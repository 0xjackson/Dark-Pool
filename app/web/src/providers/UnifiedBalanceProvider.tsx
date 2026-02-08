'use client';

import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';
import { useAccount } from 'wagmi';
import { useSessionKey } from '@/providers/SessionKeyProvider';
import { getLedgerBalances, type LedgerBalance } from '@/services/api';

interface UnifiedBalanceContextValue {
  balances: LedgerBalance[];
  refreshBalances: () => Promise<void>;
}

const UnifiedBalanceContext = createContext<UnifiedBalanceContextValue | null>(null);

const POLL_INTERVAL = 15_000; // 15s polling

export function UnifiedBalanceProvider({ children }: { children: ReactNode }) {
  const { address } = useAccount();
  const { isActive: sessionKeyActive } = useSessionKey();
  const [balances, setBalances] = useState<LedgerBalance[]>([]);

  const refreshBalances = useCallback(async () => {
    if (!address || !sessionKeyActive) return;
    try {
      const b = await getLedgerBalances(address);
      setBalances(b);
    } catch (err) {
      console.warn('[UnifiedBalance] refresh failed:', err);
    }
  }, [address, sessionKeyActive]);

  // Fetch on mount + when session key activates, then poll
  useEffect(() => {
    if (!address || !sessionKeyActive) {
      setBalances([]);
      return;
    }
    refreshBalances();
    const interval = setInterval(refreshBalances, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [address, sessionKeyActive, refreshBalances]);

  // Reset on disconnect
  useEffect(() => {
    if (!address) setBalances([]);
  }, [address]);

  return (
    <UnifiedBalanceContext.Provider value={{ balances, refreshBalances }}>
      {children}
    </UnifiedBalanceContext.Provider>
  );
}

export function useUnifiedBalance(): UnifiedBalanceContextValue {
  const context = useContext(UnifiedBalanceContext);
  if (!context) {
    throw new Error('useUnifiedBalance must be used within a UnifiedBalanceProvider');
  }
  return context;
}
