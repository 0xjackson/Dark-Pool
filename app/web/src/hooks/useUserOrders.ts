'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { Order, OrderStatus } from '@/types/order';
import { fetchUserOrders } from '@/services/api';

interface UseUserOrdersOptions {
  status?: OrderStatus;
  limit?: number;
  autoRefresh?: boolean;
  refreshInterval?: number;
}

interface UseUserOrdersReturn {
  orders: Order[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Hook for fetching and managing user orders
 *
 * Features:
 * - Fetches orders for a given user address
 * - Optional auto-refresh at specified interval
 * - Manual refresh capability
 * - Loading and error states
 *
 * @param address - User's wallet address
 * @param options - Configuration options
 * @returns Orders data, loading state, error state, and refresh function
 */
export function useUserOrders(
  address: string | undefined,
  options: UseUserOrdersOptions = {}
): UseUserOrdersReturn {
  const {
    status,
    limit = 50,
    autoRefresh = true,
    refreshInterval = 10000, // 10 seconds
  } = options;

  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);

  const refresh = useCallback(async () => {
    if (!address) {
      setOrders([]);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const fetchedOrders = await fetchUserOrders(address, status, limit);

      // Only update state if component is still mounted
      if (isMountedRef.current) {
        setOrders(fetchedOrders);
      }
    } catch (err) {
      if (isMountedRef.current) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to fetch orders';
        setError(errorMessage);
        console.error('Error fetching user orders:', err);
      }
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
      }
    }
  }, [address, status, limit]);

  // Initial fetch
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-refresh interval
  useEffect(() => {
    if (!autoRefresh || !address) {
      return;
    }

    const intervalId = setInterval(refresh, refreshInterval);

    return () => {
      clearInterval(intervalId);
    };
  }, [autoRefresh, refreshInterval, refresh, address]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  return { orders, loading, error, refresh };
}
