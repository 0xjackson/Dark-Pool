import { useState, useCallback } from 'react';
import { useAccount, useChainId, usePublicClient, useWalletClient } from 'wagmi';
import { keccak256, encodeAbiParameters, parseUnits, maxUint256 } from 'viem';
import { computeOrderHash, maskOrderId } from '@/utils/poseidon';
import { OrderFormData } from '@/types/trading';
import { OrderRequest, TradeSubmitStep } from '@/types/order';
import { submitOrder as apiSubmitOrder } from '@/services/api';
import { ApiError } from '@/utils/errors';
import { ROUTER_ADDRESS, ROUTER_ABI, ERC20_ABI } from '@/config/contracts';

const CUSTODY_ADDRESS = (process.env.NEXT_PUBLIC_CUSTODY_ADDRESS ||
  '0x0000000000000000000000000000000000000000') as `0x${string}`;

const CUSTODY_ABI = [
  {
    name: 'getAccountsBalances',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'accounts', type: 'address[]' },
      { name: 'tokens', type: 'address[]' },
    ],
    outputs: [{ name: '', type: 'uint256[][]' }],
  },
] as const;

const STEP_MESSAGES: Record<TradeSubmitStep, string> = {
  idle: '',
  approving: 'Approving token spend\u2026',
  committing: 'Committing order\u2026',
  submitting_order: 'Submitting order to matching engine\u2026',
  complete: 'Complete!',
  error: 'Error',
};

interface UseSubmitTradeReturn {
  currentStep: TradeSubmitStep;
  stepMessage: string;
  loading: boolean;
  error: string | null;
  success: boolean;
  submitTrade: (formData: OrderFormData) => Promise<void>;
  reset: () => void;
}

export function useSubmitTrade(): UseSubmitTradeReturn {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();

  const [currentStep, setCurrentStep] = useState<TradeSubmitStep>('idle');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const loading = currentStep !== 'idle' && currentStep !== 'complete' && currentStep !== 'error';
  const stepMessage = STEP_MESSAGES[currentStep];

  const reset = useCallback(() => {
    setCurrentStep('idle');
    setError(null);
    setSuccess(false);
  }, []);

  const submitTrade = useCallback(
    async (formData: OrderFormData): Promise<void> => {
      setError(null);
      setSuccess(false);
      setCurrentStep('idle');

      if (!isConnected || !address || !walletClient || !publicClient) {
        setError('Wallet must be connected to submit an order');
        return;
      }

      try {
        const sellToken = formData.tokenPair.baseToken.address as `0x${string}`;
        const buyToken = formData.tokenPair.quoteToken.address as `0x${string}`;
        const sellAmount = parseUnits(formData.amount, formData.tokenPair.baseToken.decimals);
        const varianceBps = Math.round(formData.slippage * 100);

        // Calculate minBuyAmount from price and slippage
        const rawBuyAmount = parseUnits(
          (parseFloat(formData.amount) * parseFloat(formData.price)).toString(),
          formData.tokenPair.quoteToken.decimals
        );
        const minBuyAmount = rawBuyAmount - (rawBuyAmount * BigInt(varianceBps)) / 10000n;

        const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour

        // Generate orderId — masked to 253 bits for BN128 field compatibility
        const rawOrderId = keccak256(
          encodeAbiParameters(
            [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }],
            [address, sellAmount, expiresAt]
          )
        );
        const orderId = maskOrderId(rawOrderId);

        // Compute nested Poseidon commitment hash (matches contract's _computeOrderHash)
        const orderHash = await computeOrderHash(
          orderId, address, sellToken, buyToken, sellAmount, minBuyAmount, expiresAt
        );

        // Check if user has sufficient Custody balance for commitOnly
        // Custody contract uses address(0) for native ETH, not the 0xEeee... sentinel
        const NATIVE_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'.toLowerCase();
        const custodyQueryToken = sellToken.toLowerCase() === NATIVE_SENTINEL
          ? '0x0000000000000000000000000000000000000000' as `0x${string}`
          : sellToken;

        let useCustodyBalance = false;
        if (CUSTODY_ADDRESS !== '0x0000000000000000000000000000000000000000') {
          try {
            const balances = await publicClient.readContract({
              address: CUSTODY_ADDRESS,
              abi: CUSTODY_ABI,
              functionName: 'getAccountsBalances',
              args: [[address], [custodyQueryToken]],
            });
            const custodyBalance = (balances as bigint[][])?.[0]?.[0] ?? 0n;
            useCustodyBalance = custodyBalance >= sellAmount;
          } catch {
            // Custody query failed — fall back to depositAndCommit
          }
        }

        setCurrentStep('committing');
        if (useCustodyBalance) {
          // User already has funds in Custody — just store the commitment
          const commitHash = await walletClient.writeContract({
            address: ROUTER_ADDRESS,
            abi: ROUTER_ABI,
            functionName: 'commitOnly',
            args: [orderId, orderHash],
          });
          await publicClient.waitForTransactionReceipt({ hash: commitHash });
        } else {
          // User needs to deposit ERC-20 tokens + commit
          const allowance = await publicClient.readContract({
            address: sellToken,
            abi: ERC20_ABI,
            functionName: 'allowance',
            args: [address, ROUTER_ADDRESS],
          });

          if ((allowance as bigint) < sellAmount) {
            setCurrentStep('approving');
            const approveHash = await walletClient.writeContract({
              address: sellToken,
              abi: ERC20_ABI,
              functionName: 'approve',
              args: [ROUTER_ADDRESS, maxUint256],
            });
            await publicClient.waitForTransactionReceipt({ hash: approveHash });
            setCurrentStep('committing');
          }

          const commitHash = await walletClient.writeContract({
            address: ROUTER_ADDRESS,
            abi: ROUTER_ABI,
            functionName: 'depositAndCommit',
            args: [sellToken, sellAmount, orderId, orderHash],
          });
          await publicClient.waitForTransactionReceipt({ hash: commitHash });
        }

        // Step 3: Submit order details to backend
        setCurrentStep('submitting_order');
        const orderRequest: OrderRequest = {
          user_address: address,
          chain_id: chainId,
          order_type: formData.orderType,
          base_token: sellToken,
          quote_token: buyToken,
          quantity: formData.amount,
          price: formData.price,
          variance_bps: varianceBps,
          order_id: orderId,
          commitment_hash: orderHash,
          expires_at: Number(expiresAt),
          min_buy_amount: minBuyAmount.toString(),
          sell_amount: sellAmount.toString(),
        };

        await apiSubmitOrder(orderRequest);

        setCurrentStep('complete');
        setSuccess(true);
      } catch (err) {
        setCurrentStep('error');
        if (err instanceof ApiError) {
          setError(err.message);
        } else if (err instanceof Error) {
          setError(err.message);
        } else {
          setError('An unexpected error occurred while submitting the trade');
        }
        setSuccess(false);
      }
    },
    [address, isConnected, chainId, walletClient, publicClient]
  );

  return {
    currentStep,
    stepMessage,
    loading,
    error,
    success,
    submitTrade,
    reset,
  };
}
