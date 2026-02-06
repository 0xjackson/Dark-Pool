import { useState, useCallback } from 'react';
import { useAccount, useChainId, useSignTypedData } from 'wagmi';
import { keccak256, encodePacked } from 'viem';
import { OrderFormData } from '@/types/trading';
import { OrderRequest, OrderData, TradeSubmitStep } from '@/types/order';
import { submitOrder as apiSubmitOrder, submitCommitHash } from '@/services/api';
import { ApiError } from '@/utils/errors';
import { EIP712_DOMAIN, ORDER_TYPES } from '@/config/eip712';

const STEP_MESSAGES: Record<TradeSubmitStep, string> = {
  idle: '',
  signing: 'Signing order…',
  depositing: 'Preparing deposit…',
  submitting_order: 'Submitting order…',
  storing_commitment: 'Storing commitment…',
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
  const { signTypedDataAsync } = useSignTypedData();

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

      if (!isConnected || !address) {
        setError('Wallet must be connected to submit an order');
        return;
      }

      try {
        const variance_bps = Math.round(formData.slippage * 100);
        const nonce = BigInt(Date.now()).toString();

        const orderData: OrderData = {
          user: address,
          baseToken: formData.tokenPair.baseToken.address,
          quoteToken: formData.tokenPair.quoteToken.address,
          quantity: formData.amount,
          price: formData.price,
          varianceBps: variance_bps,
          nonce,
          chainId,
          orderType: formData.orderType,
        };

        // Step 1: Sign the order via EIP-712
        setCurrentStep('signing');
        const signature = await signTypedDataAsync({
          domain: {
            ...EIP712_DOMAIN,
            chainId,
          },
          types: ORDER_TYPES,
          primaryType: 'Order',
          message: {
            user: address,
            baseToken: orderData.baseToken as `0x${string}`,
            quoteToken: orderData.quoteToken as `0x${string}`,
            quantity: BigInt(orderData.quantity),
            price: BigInt(orderData.price),
            varianceBps: BigInt(orderData.varianceBps),
            nonce: BigInt(orderData.nonce),
            chainId: BigInt(chainId),
            orderType: orderData.orderType,
          },
        });

        // Compute commitment hash matching DarkPool.sol's computeCommitmentHash
        const commitmentHash = keccak256(
          encodePacked(
            ['address', 'address', 'address', 'uint256', 'uint256', 'uint256', 'uint256'],
            [
              address,
              orderData.baseToken as `0x${string}`,
              orderData.quoteToken as `0x${string}`,
              BigInt(orderData.quantity),
              BigInt(orderData.price),
              BigInt(orderData.varianceBps),
              BigInt(orderData.nonce),
            ]
          )
        );

        // Step 2: Deposit stub
        setCurrentStep('depositing');
        await depositStub(orderData);

        // Step 3: Submit order to backend
        setCurrentStep('submitting_order');
        const orderRequest: OrderRequest = {
          user_address: address,
          chain_id: chainId,
          order_type: formData.orderType,
          base_token: formData.tokenPair.baseToken.address,
          quote_token: formData.tokenPair.quoteToken.address,
          quantity: formData.amount,
          price: formData.price,
          variance_bps,
          order_signature: signature,
          order_data: orderData,
          commitment_hash: commitmentHash,
          nonce,
        };

        const orderResponse = await apiSubmitOrder(orderRequest);

        // Step 4: Store commitment hash
        setCurrentStep('storing_commitment');
        await submitCommitHash({
          order_id: orderResponse.order.id,
          commitment_hash: commitmentHash,
          user_address: address,
        });

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
    [address, isConnected, chainId, signTypedDataAsync]
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

/**
 * Deposit stub — placeholder for future ERC20.approve() + custody transfer.
 * Currently just logs the intent and resolves immediately.
 */
async function depositStub(orderData: OrderData): Promise<void> {
  console.log('[depositStub] Deposit intent for order:', {
    user: orderData.user,
    baseToken: orderData.baseToken,
    quantity: orderData.quantity,
  });
}
