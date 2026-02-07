import { useState, useCallback } from 'react';
import { useAccount, useChainId, usePublicClient, useWalletClient } from 'wagmi';
import { keccak256, encodeAbiParameters, parseUnits } from 'viem';
import { computeOrderHash, maskOrderId } from '@/utils/poseidon';
import { OrderFormData } from '@/types/trading';
import { OrderRequest, TradeSubmitStep } from '@/types/order';
import { submitOrder as apiSubmitOrder } from '@/services/api';
import { ApiError } from '@/utils/errors';
import { ROUTER_ADDRESS, ROUTER_ABI } from '@/config/contracts';

const STEP_MESSAGES: Record<TradeSubmitStep, string> = {
  idle: '',
  approving: 'Approving token spend\u2026',
  committing: 'Committing order on-chain\u2026',
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
        const isBuy = formData.orderType === 'BUY';

        // Trading pair tokens (same for BUY and SELL — used for matching in Warlock)
        const baseTokenAddr = formData.tokenPair.baseToken.address as `0x${string}`;
        const quoteTokenAddr = formData.tokenPair.quoteToken.address as `0x${string}`;

        // Contract-level tokens (what user actually deposits/receives)
        // SELL ETH/USDC: deposit ETH, receive USDC
        // BUY ETH/USDC: deposit USDC, receive ETH
        const sellToken = isBuy ? quoteTokenAddr : baseTokenAddr;
        const buyToken = isBuy ? baseTokenAddr : quoteTokenAddr;
        const sellDecimals = isBuy
          ? formData.tokenPair.quoteToken.decimals
          : formData.tokenPair.baseToken.decimals;
        const buyDecimals = isBuy
          ? formData.tokenPair.baseToken.decimals
          : formData.tokenPair.quoteToken.decimals;

        const varianceBps = Math.round(formData.slippage * 100);

        // SELL: deposit formData.amount of base, receive (amount * price) of quote
        // BUY: deposit (amount * price) of quote, receive formData.amount of base
        const sellAmount = isBuy
          ? parseUnits(
              (parseFloat(formData.amount) * parseFloat(formData.price)).toString(),
              sellDecimals
            )
          : parseUnits(formData.amount, sellDecimals);

        const rawBuyAmount = isBuy
          ? parseUnits(formData.amount, buyDecimals)
          : parseUnits(
              (parseFloat(formData.amount) * parseFloat(formData.price)).toString(),
              buyDecimals
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

        // Always use commitOnly — deposits happen through Yellow channel flow separately.
        // User's unified balance on Yellow must be sufficient before trading.
        setCurrentStep('committing');
        const commitHash = await walletClient.writeContract({
          address: ROUTER_ADDRESS,
          abi: ROUTER_ABI,
          functionName: 'commitOnly',
          args: [orderId, orderHash],
        });
        await publicClient.waitForTransactionReceipt({ hash: commitHash });

        // Submit order details to backend
        setCurrentStep('submitting_order');
        const orderRequest: OrderRequest = {
          user_address: address,
          chain_id: chainId,
          order_type: formData.orderType,
          base_token: baseTokenAddr,
          quote_token: quoteTokenAddr,
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
