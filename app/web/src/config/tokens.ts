import { Token, TradingPair } from '../types/trading';
import { mainnet, sepolia } from 'wagmi/chains';

/**
 * Token configurations for supported networks
 */

// Native ETH representation (used as standard address for native ETH)
const NATIVE_ETH_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

/**
 * Mainnet (Ethereum) token addresses
 */
export const MAINNET_TOKENS = {
  ETH: {
    address: NATIVE_ETH_ADDRESS,
    symbol: 'ETH',
    decimals: 18,
    name: 'Ethereum',
  } as Token,
  USDC: {
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    symbol: 'USDC',
    decimals: 6,
    name: 'USD Coin',
  } as Token,
  WBTC: {
    address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    symbol: 'WBTC',
    decimals: 8,
    name: 'Wrapped Bitcoin',
  } as Token,
} as const;

/**
 * Sepolia testnet token addresses
 */
export const SEPOLIA_TOKENS = {
  ETH: {
    address: NATIVE_ETH_ADDRESS,
    symbol: 'ETH',
    decimals: 18,
    name: 'Ethereum',
  } as Token,
  USDC: {
    address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    symbol: 'USDC',
    decimals: 6,
    name: 'USD Coin (Sepolia)',
  } as Token,
} as const;

/**
 * Trading pairs configuration by chain ID
 */
export const TRADING_PAIRS: Record<number, TradingPair[]> = {
  // Ethereum Mainnet
  [mainnet.id]: [
    {
      id: 'ETH-USDC',
      baseToken: MAINNET_TOKENS.ETH,
      quoteToken: MAINNET_TOKENS.USDC,
    },
    {
      id: 'WBTC-USDC',
      baseToken: MAINNET_TOKENS.WBTC,
      quoteToken: MAINNET_TOKENS.USDC,
    },
  ],
  // Sepolia Testnet
  [sepolia.id]: [
    {
      id: 'ETH-USDC',
      baseToken: SEPOLIA_TOKENS.ETH,
      quoteToken: SEPOLIA_TOKENS.USDC,
    },
  ],
};

/**
 * Get trading pairs for a specific chain
 */
export function getTradingPairs(chainId: number | undefined): TradingPair[] {
  if (!chainId) return [];
  return TRADING_PAIRS[chainId] || [];
}

/**
 * Get a specific trading pair by ID and chain
 */
export function getTradingPair(
  chainId: number | undefined,
  pairId: string
): TradingPair | undefined {
  if (!chainId) return undefined;
  const pairs = TRADING_PAIRS[chainId];
  return pairs?.find((pair) => pair.id === pairId);
}

/**
 * Get all tokens for a specific chain
 */
export function getChainTokens(chainId: number | undefined): Token[] {
  if (!chainId) return [];

  if (chainId === mainnet.id) {
    return Object.values(MAINNET_TOKENS);
  }

  if (chainId === sepolia.id) {
    return Object.values(SEPOLIA_TOKENS);
  }

  return [];
}
