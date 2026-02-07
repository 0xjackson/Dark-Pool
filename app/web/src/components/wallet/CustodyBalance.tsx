'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAccount, useChainId, useReadContract } from 'wagmi';
import { formatUnits } from 'viem';
import { getChainTokens } from '@/config/tokens';

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

interface TokenBalance {
  symbol: string;
  balance: string;
  rawBalance: bigint;
  decimals: number;
}

/**
 * CustodyBalance — Displays the user's Yellow Network Custody balances
 * for all configured tokens on the current chain.
 *
 * Queries the Custody contract's getAccountsBalances() view function (no auth needed).
 * Refreshes every 15 seconds or on new blocks.
 */
export function CustodyBalance() {
  const { address } = useAccount();
  const chainId = useChainId();
  const tokens = getChainTokens(chainId);
  const [balances, setBalances] = useState<TokenBalance[]>([]);

  const tokenAddresses = tokens.map((t) => t.address as `0x${string}`);

  const { data, refetch } = useReadContract({
    address: CUSTODY_ADDRESS,
    abi: CUSTODY_ABI,
    functionName: 'getAccountsBalances',
    args: [address ? [address] : [], tokenAddresses],
    query: {
      enabled: !!address && tokenAddresses.length > 0 && CUSTODY_ADDRESS !== '0x0000000000000000000000000000000000000000',
    },
  });

  // Parse balance data when it changes
  useEffect(() => {
    if (!data || !address || tokens.length === 0) {
      setBalances([]);
      return;
    }

    // data is uint256[][] — data[0] is the first account's balances array
    const accountBalances = data[0] as readonly bigint[] | undefined;
    if (!accountBalances) {
      setBalances([]);
      return;
    }

    const parsed: TokenBalance[] = tokens.map((token, i) => ({
      symbol: token.symbol,
      decimals: token.decimals,
      rawBalance: accountBalances[i] ?? 0n,
      balance: formatUnits(accountBalances[i] ?? 0n, token.decimals),
    }));

    setBalances(parsed);
  }, [data, address, tokens]);

  // Refresh every 15 seconds
  const refreshBalances = useCallback(() => {
    refetch();
  }, [refetch]);

  useEffect(() => {
    const timer = setInterval(refreshBalances, 15000);
    return () => clearInterval(timer);
  }, [refreshBalances]);

  if (!address) return null;
  if (CUSTODY_ADDRESS === '0x0000000000000000000000000000000000000000') return null;

  return (
    <div className="bg-dark-surface/50 backdrop-blur-sm border border-purple-primary/20 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-purple-secondary uppercase tracking-wider">
          Custody Balance
        </h3>
        <button
          type="button"
          onClick={refreshBalances}
          className="text-xs text-purple-secondary/70 hover:text-purple-primary transition-colors"
        >
          Refresh
        </button>
      </div>
      {balances.length === 0 ? (
        <p className="text-sm text-purple-secondary/50">No balances</p>
      ) : (
        <div className="space-y-2">
          {balances.map((b) => (
            <div key={b.symbol} className="flex items-center justify-between">
              <span className="text-sm text-purple-secondary">{b.symbol}</span>
              <span className="text-sm font-mono text-white">
                {Number(b.balance).toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 6,
                })}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
