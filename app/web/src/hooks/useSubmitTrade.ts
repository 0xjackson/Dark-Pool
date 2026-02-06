import { useState, useCallback } from 'react';
import { useAccount, useChainId, usePublicClient, useWalletClient } from 'wagmi';
import { keccak256, encodeAbiParameters, parseUnits, maxUint256 } from 'viem';
import { OrderFormData } from '@/types/trading';
import { OrderRequest, TradeSubmitStep } from '@/types/order';
import { submitOrder as apiSubmitOrder } from '@/services/api';
import { ApiError } from '@/utils/errors';
import { ROUTER_ADDRESS, ROUTER_ABI, ERC20_ABI } from '@/config/contracts';

const STEP_MESSAGES: Record<TradeSubmitStep, string> = {
  idle: '',
  approving: 'Approving token spend\u2026',
  committing: 'Depositing & committing order\u2026',
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
        const orderId = keccak256(
          encodeAbiParameters(
            [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }],
            [address, sellAmount, expiresAt]
          )
        );

        // Compute commitment hash matching contract's keccak256(abi.encode(OrderDetails))
        const orderHash = keccak256(
          encodeAbiParameters(
            [
              { type: 'bytes32' },
              { type: 'address' },
              { type: 'address' },
              { type: 'address' },
              { type: 'uint256' },
              { type: 'uint256' },
              { type: 'uint256' },
            ],
            [orderId, address, sellToken, buyToken, sellAmount, minBuyAmount, expiresAt]
          )
        );

        // Step 1: Check allowance and approve if needed
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
        }

        // Step 2: Call depositAndCommit on-chain
        setCurrentStep('committing');
        const commitHash = await walletClient.writeContract({
          address: ROUTER_ADDRESS,
          abi: ROUTER_ABI,
          functionName: 'depositAndCommit',
          args: [sellToken, sellAmount, orderId, orderHash],
        });
        await publicClient.waitForTransactionReceipt({ hash: commitHash });

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
