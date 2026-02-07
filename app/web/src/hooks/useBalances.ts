'use client';

import { useCallback, useEffect, useMemo } from 'react';
import { useAccount, useBalance, useChainId, useReadContract } from 'wagmi';
import { formatUnits } from 'viem';
import { getChainTokens } from '@/config/tokens';

const CUSTODY_ADDRESS = (process.env.NEXT_PUBLIC_CUSTODY_ADDRESS ||
  '0x0000000000000000000000000000000000000000') as `0x${string}`;

const NATIVE_ETH_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

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

const ERC20_BALANCE_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export interface TokenBalance {
  symbol: string;
  balance: string;
  rawBalance: bigint;
  decimals: number;
  address: string;
}

interface UseBalancesResult {
  custodyBalances: TokenBalance[];
  walletBalances: TokenBalance[];
  isLoading: boolean;
  refetch: () => void;
}

/**
 * useBalances — Unified hook for all balance types:
 * - Custody balances (Yellow Network Custody contract)
 * - Wallet ETH (native balance)
 * - Wallet ERC-20 balances (USDC, etc.)
 *
 * Auto-refreshes every 30 seconds. Uses staleTime to avoid redundant
 * fetches on remount (e.g. tab switch, modal open/close).
 */
export function useBalances(): UseBalancesResult {
  const { address } = useAccount();
  const chainId = useChainId();
  const tokens = getChainTokens(chainId);

  const custodyEnabled =
    !!address &&
    tokens.length > 0 &&
    CUSTODY_ADDRESS !== '0x0000000000000000000000000000000000000000';

  const tokenAddresses = useMemo(
    () => tokens.map((t) => t.address as `0x${string}`),
    [tokens],
  );

  // Find the first ERC-20 token (non-native) for balanceOf query
  const erc20Token = useMemo(
    () => tokens.find((t) => t.address !== NATIVE_ETH_ADDRESS),
    [tokens],
  );

  // --- Custody balances ---
  const {
    data: custodyData,
    refetch: refetchCustody,
    isLoading: custodyLoading,
  } = useReadContract({
    address: CUSTODY_ADDRESS,
    abi: CUSTODY_ABI,
    functionName: 'getAccountsBalances',
    args: [address ? [address] : [], tokenAddresses],
    query: { enabled: custodyEnabled, staleTime: 20_000, refetchOnWindowFocus: true },
  });

  // --- Wallet native ETH balance ---
  const {
    data: ethData,
    refetch: refetchEth,
    isLoading: ethLoading,
  } = useBalance({
    address,
    query: { enabled: !!address, staleTime: 20_000, refetchOnWindowFocus: true },
  });

  // --- Wallet ERC-20 balance (first non-native token, e.g. USDC) ---
  const {
    data: erc20Data,
    refetch: refetchErc20,
    isLoading: erc20Loading,
  } = useReadContract({
    address: erc20Token?.address as `0x${string}` | undefined,
    abi: ERC20_BALANCE_ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!erc20Token, staleTime: 20_000, refetchOnWindowFocus: true },
  });

  // Parse custody balances
  const custodyBalances = useMemo<TokenBalance[]>(() => {
    if (!custodyData || !address || tokens.length === 0) return [];
    const accountBalances = custodyData[0] as readonly bigint[] | undefined;
    if (!accountBalances) return [];

    return tokens.map((token, i) => ({
      symbol: token.symbol,
      decimals: token.decimals,
      rawBalance: accountBalances[i] ?? 0n,
      balance: formatUnits(accountBalances[i] ?? 0n, token.decimals),
      address: token.address,
    }));
  }, [custodyData, address, tokens]);

  // Parse wallet balances
  const walletBalances = useMemo<TokenBalance[]>(() => {
    if (!address) return [];
    const result: TokenBalance[] = [];

    // Native ETH
    const ethToken = tokens.find((t) => t.address === NATIVE_ETH_ADDRESS);
    if (ethToken && ethData) {
      result.push({
        symbol: ethToken.symbol,
        decimals: ethToken.decimals,
        rawBalance: ethData.value,
        balance: formatUnits(ethData.value, ethToken.decimals),
        address: ethToken.address,
      });
    }

    // ERC-20 tokens
    if (erc20Token && erc20Data !== undefined) {
      const raw = erc20Data as bigint;
      result.push({
        symbol: erc20Token.symbol,
        decimals: erc20Token.decimals,
        rawBalance: raw,
        balance: formatUnits(raw, erc20Token.decimals),
        address: erc20Token.address,
      });
    }

    return result;
  }, [address, tokens, ethData, erc20Token, erc20Data]);

  const refetch = useCallback(() => {
    refetchCustody();
    refetchEth();
    refetchErc20();
  }, [refetchCustody, refetchEth, refetchErc20]);

  // Auto-refresh every 30s
  useEffect(() => {
    const timer = setInterval(refetch, 30_000);
    return () => clearInterval(timer);
  }, [refetch]);

  return {
    custodyBalances,
    walletBalances,
    isLoading: custodyLoading || ethLoading || erc20Loading,
    refetch,
  };
}
