import { Token, TradingPair } from '../types/trading';
import { mainnet, sepolia, baseSepolia, base } from 'wagmi/chains';

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
 * Base Sepolia testnet token addresses (Yellow Network sandbox)
 */
export const BASE_SEPOLIA_TOKENS = {
  YTEST_USD: {
    address: '0xDB9F293e3898c9E5536A3be1b0C56c89d2b32DEb',
    symbol: 'ytest.USD',
    decimals: 6,
    name: 'Yellow Test USD',
  } as Token,
  ETH: {
    address: NATIVE_ETH_ADDRESS,
    symbol: 'ETH',
    decimals: 18,
    name: 'Ethereum',
  } as Token,
} as const;

/**
 * Base mainnet token addresses
 */
export const BASE_TOKENS = {
  ETH: {
    address: NATIVE_ETH_ADDRESS,
    symbol: 'ETH',
    decimals: 18,
    name: 'Ethereum',
  } as Token,
  USDC: {
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    symbol: 'USDC',
    decimals: 6,
    name: 'USD Coin',
  } as Token,
} as const;

/**
 * Trading pairs configuration by chain ID
 */
export const TRADING_PAIRS: Record<number, TradingPair[]> = {
  // Base Mainnet
  [base.id]: [
    {
      id: 'ETH-USDC',
      baseToken: BASE_TOKENS.ETH,
      quoteToken: BASE_TOKENS.USDC,
    },
  ],
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
  // Base Sepolia Testnet (Yellow Network sandbox)
  [baseSepolia.id]: [
    {
      id: 'ETH-ytest.USD',
      baseToken: BASE_SEPOLIA_TOKENS.ETH,
      quoteToken: BASE_SEPOLIA_TOKENS.YTEST_USD,
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

  if (chainId === base.id) {
    return Object.values(BASE_TOKENS);
  }

  if (chainId === mainnet.id) {
    return Object.values(MAINNET_TOKENS);
  }

  if (chainId === sepolia.id) {
    return Object.values(SEPOLIA_TOKENS);
  }

  if (chainId === baseSepolia.id) {
    return Object.values(BASE_SEPOLIA_TOKENS);
  }

  return [];
}
