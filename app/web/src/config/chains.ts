import { mainnet, sepolia } from 'wagmi/chains';

/**
 * Supported blockchain networks for Dark Pool
 *
 * - mainnet: Ethereum mainnet for production trading
 * - sepolia: Ethereum Sepolia testnet for development/testing
 */
export const supportedChains = [mainnet, sepolia] as const;

/**
 * Default chain to use when connecting wallet
 * Uses environment variable or defaults to mainnet
 */
export const defaultChain = mainnet;

/**
 * Chain configuration mapping
 */
export const chainConfig = {
  [mainnet.id]: {
    name: 'Ethereum',
    shortName: 'ETH',
    explorerUrl: 'https://etherscan.io',
  },
  [sepolia.id]: {
    name: 'Sepolia',
    shortName: 'SEP',
    explorerUrl: 'https://sepolia.etherscan.io',
  },
} as const;

/**
 * Get chain display name
 */
export function getChainName(chainId: number | undefined): string {
  if (!chainId) return 'Unknown';
  return chainConfig[chainId as keyof typeof chainConfig]?.name || 'Unknown';
}

/**
 * Get chain explorer URL
 */
export function getExplorerUrl(chainId: number | undefined): string | undefined {
  if (!chainId) return undefined;
  return chainConfig[chainId as keyof typeof chainConfig]?.explorerUrl;
}
