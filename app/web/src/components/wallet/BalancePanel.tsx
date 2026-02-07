'use client';

import { useAccount } from 'wagmi';
import { useBalances, type TokenBalance } from '@/hooks/useBalances';
import { WithdrawButton } from './WithdrawButton';

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

/**
 * BalancePanel — Compact panel showing wallet + custody balances.
 * Mounts in the top-right header area when wallet is connected.
 */
export function BalancePanel() {
  const { address } = useAccount();
  const { custodyBalances, walletBalances, isLoading, refetch } = useBalances();

  if (!address) return null;

  const hasCustody = CUSTODY_ADDRESS !== '0x0000000000000000000000000000000000000000';

  return (
    <div className="bg-dark-surface/50 backdrop-blur-sm border border-purple-primary/20 rounded-xl p-4 w-[280px] mt-3">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-purple-secondary uppercase tracking-wider">
          Balances
        </h3>
        <button
          type="button"
          onClick={refetch}
          className="text-xs text-purple-secondary/70 hover:text-purple-primary transition-colors"
          title="Refresh balances"
        >
          {isLoading ? '...' : 'Refresh'}
        </button>
      </div>

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
  );
}
