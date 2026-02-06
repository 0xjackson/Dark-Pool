import { useState, useCallback } from 'react';
import { useAccount, useChainId } from 'wagmi';
import { OrderFormData } from '@/types/trading';
import { OrderRequest, OrderResponse } from '@/types/order';
import { submitOrder as apiSubmitOrder } from '@/services/api';
import { ApiError } from '@/utils/errors';

interface UseOrderSubmitReturn {
  loading: boolean;
  error: string | null;
  success: boolean;
  submitOrder: (formData: OrderFormData) => Promise<void>;
  reset: () => void;
}

/**
 * Custom hook for submitting orders to the dark pool
 * Handles wallet connection, order conversion, and API submission
 *
 * @returns Object containing loading state, error message, success flag, submitOrder function, and reset function
 */
export function useOrderSubmit(): UseOrderSubmitReturn {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  /**
   * Resets the hook state to initial values
   */
  const reset = useCallback(() => {
    setLoading(false);
    setError(null);
    setSuccess(false);
  }, []);

  /**
   * Submits an order to the dark pool
   * @param formData - The order form data from the UI
   * @throws Will set error state if wallet is not connected or submission fails
   */
  const submitOrder = useCallback(
    async (formData: OrderFormData): Promise<void> => {
      // Reset previous state
      setError(null);
      setSuccess(false);

      // Validate wallet connection
      if (!isConnected || !address) {
        setError('Wallet must be connected to submit an order');
        return;
      }

      setLoading(true);

      try {
        // Convert slippage percentage to basis points
        // e.g., 0.5% slippage = 0.5 * 100 = 50 bps
        const variance_bps = Math.round(formData.slippage * 100);

        // Map form data to API request format
        const orderRequest: OrderRequest = {
          user_address: address,
          chain_id: chainId,
          order_type: formData.orderType,
          base_token: formData.tokenPair.baseToken.address,
          quote_token: formData.tokenPair.quoteToken.address,
          quantity: formData.amount,
          price: formData.price,
          variance_bps,
        };

        // Submit order to API
        await apiSubmitOrder(orderRequest);

        // Mark as successful
        setSuccess(true);
      } catch (err) {
        // Handle API errors
        if (err instanceof ApiError) {
          setError(err.message);
        } else if (err instanceof Error) {
          setError(err.message);
        } else {
          setError('An unexpected error occurred while submitting the order');
        }

        setSuccess(false);
      } finally {
        setLoading(false);
      }
    },
    [address, isConnected, chainId]
  );

  return {
    loading,
    error,
    success,
    submitOrder,
    reset,
  };
}
