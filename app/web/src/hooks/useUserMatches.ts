'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { Match } from '@/types/order';
import { fetchUserMatches } from '@/services/api';

interface UseUserMatchesOptions {
  limit?: number;
  autoRefresh?: boolean;
  refreshInterval?: number;
}

interface UseUserMatchesReturn {
  matches: Match[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Hook for fetching and managing user matches
 *
 * Features:
 * - Fetches matches for a given user address
 * - Optional auto-refresh at specified interval
 * - Manual refresh capability
 * - Loading and error states
 *
 * @param address - User's wallet address
 * @param options - Configuration options
 * @returns Matches data, loading state, error state, and refresh function
 */
export function useUserMatches(
  address: string | undefined,
  options: UseUserMatchesOptions = {}
): UseUserMatchesReturn {
  const {
    limit = 50,
    autoRefresh = true,
    refreshInterval = 10000, // 10 seconds
  } = options;

  const [matches, setMatches] = useState<Match[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);

  const refresh = useCallback(async () => {
    if (!address) {
      setMatches([]);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const fetchedMatches = await fetchUserMatches(address, limit);

      // Only update state if component is still mounted
      if (isMountedRef.current) {
        setMatches(fetchedMatches);
      }
    } catch (err) {
      if (isMountedRef.current) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to fetch matches';
        setError(errorMessage);
        console.error('Error fetching user matches:', err);
      }
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
      }
    }
  }, [address, limit]);

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

  return { matches, loading, error, refresh };
}
