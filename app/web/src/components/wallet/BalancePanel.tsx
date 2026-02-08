'use client';

import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAccount } from 'wagmi';
import { useBalances, type TokenBalance } from '@/hooks/useBalances';
import { useSessionKey } from '@/hooks/useSessionKey';
import { WithdrawButton } from './WithdrawButton';
import { getLedgerBalances, type LedgerBalance } from '@/services/api';

const CUSTODY_ADDRESS = process.env.NEXT_PUBLIC_CUSTODY_ADDRESS || '0x0000000000000000000000000000000000000000';

function formatBalance(balance: string): string {
  const num = Number(balance);
  if (num === 0) return '0.00';
  if (num < 0.000001) return '<0.000001';
  return num.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}

function BalanceRow({ b, showWithdraw }: { b: TokenBalance; showWithdraw?: boolean }) {
  const token = { address: b.address, symbol: b.symbol, decimals: b.decimals, name: b.symbol };

  return (
    <div key={b.symbol}>
      <div className="flex items-center justify-between">
        <span className="text-sm text-purple-secondary">{b.symbol}</span>
        <div className="flex items-center gap-3">
          <span className="text-sm font-mono text-white">{formatBalance(b.balance)}</span>
          {showWithdraw && b.rawBalance > 0n && (
            <WithdrawButton token={token} maxBalance={b.balance} />
          )}
        </div>
      </div>
    </div>
  );
}

interface BalancesToggleProps {
  onClick: () => void;
  isOpen?: boolean;
}

export function BalancesToggle({ onClick, isOpen }: BalancesToggleProps) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      className={`mt-3 z-40 flex items-center gap-2 px-4 py-3 bg-dark-elevated/80 backdrop-blur-xl border rounded-lg shadow-lg transition-all duration-200 group ${
        isOpen
          ? 'border-purple-primary/60 shadow-purple-glow/20'
          : 'border-purple-primary/30 hover:border-purple-primary/50 hover:shadow-purple-glow/20'
      }`}
      whileHover={{ scale: 1.05 }}
      whileTap={{ scale: 0.95 }}
      aria-label="Toggle balances"
    >
      {/* Wallet Icon */}
      <svg
        className="w-5 h-5 text-purple-secondary group-hover:text-white transition-colors duration-200"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"
        />
      </svg>

      {/* Text */}
      <span className="text-sm font-medium text-purple-secondary group-hover:text-white transition-colors duration-200">
        Balances
      </span>
    </motion.button>
  );
}

interface BalancesDropdownProps {
  isOpen: boolean;
  onClose: () => void;
}

export function BalancesDropdown({ isOpen, onClose }: BalancesDropdownProps) {
  const { address } = useAccount();
  const { custodyBalances, walletBalances, isLoading, refetch } = useBalances();
  const { isActive: sessionKeyActive } = useSessionKey();
  const [unifiedBalances, setUnifiedBalances] = useState<LedgerBalance[]>([]);

  const refreshUnified = useCallback(async () => {
    if (!address || !sessionKeyActive) return;
    try {
      const b = await getLedgerBalances(address);
      setUnifiedBalances(b);
    } catch {
      // Silently fail
    }
  }, [address, sessionKeyActive]);

  useEffect(() => {
    refreshUnified();
    const interval = setInterval(refreshUnified, 30_000);
    return () => clearInterval(interval);
  }, [refreshUnified]);

  // ESC key listener
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  const handleRefresh = useCallback(() => {
    refetch();
    refreshUnified();
  }, [refetch, refreshUnified]);

  if (!address) return null;

  const hasCustody = CUSTODY_ADDRESS !== '0x0000000000000000000000000000000000000000';

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          className="bg-dark-surface/50 backdrop-blur-sm border border-purple-primary/20 rounded-xl w-[280px] mt-3 overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 pt-3 pb-2">
            <h3 className="text-xs font-semibold text-purple-secondary uppercase tracking-wider">
              Balances
            </h3>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={handleRefresh}
                className="text-xs text-purple-secondary/70 hover:text-purple-primary transition-colors"
                disabled={isLoading}
              >
                {isLoading ? '...' : 'Refresh'}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="p-1 text-purple-secondary/70 hover:text-white transition-colors"
                aria-label="Close balances"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          {/* Scrollable Content */}
          <div className="max-h-[320px] overflow-y-auto px-3 pb-3">
            {/* Wallet Balances */}
            <div className="mb-3">
              <p className="text-[10px] font-medium text-purple-secondary/50 uppercase tracking-wider mb-1.5">
                Wallet
              </p>
              {walletBalances.length === 0 ? (
                <p className="text-xs text-purple-secondary/40">Loading...</p>
              ) : (
                <div className="space-y-1">
                  {walletBalances.map((b) => (
                    <BalanceRow key={b.symbol} b={b} />
                  ))}
                </div>
              )}
            </div>

            {/* Unified Balance (Yellow Network) */}
            {sessionKeyActive && (
              <div className="mb-3">
                <p className="text-[10px] font-medium text-green-400/60 uppercase tracking-wider mb-1.5">
                  Unified (Tradeable)
                </p>
                {unifiedBalances.length === 0 ? (
                  <p className="text-xs text-purple-secondary/40">No balance</p>
                ) : (
                  <div className="space-y-1">
                    {unifiedBalances.map((b) => (
                      <div key={b.asset} className="flex items-center justify-between">
                        <span className="text-sm text-green-400/80 uppercase">{b.asset}</span>
                        <span className="text-sm font-mono text-white">{formatBalance(b.amount)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Custody Balances */}
            {hasCustody && (
              <div>
                <p className="text-[10px] font-medium text-purple-secondary/50 uppercase tracking-wider mb-1.5">
                  Custody
                </p>
                {custodyBalances.length === 0 ? (
                  <p className="text-xs text-purple-secondary/40">
                    {isLoading ? 'Loading...' : 'No balances'}
                  </p>
                ) : (
                  <div className="space-y-1">
                    {custodyBalances.map((b) => (
                      <BalanceRow key={b.symbol} b={b} showWithdraw />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
