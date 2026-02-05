import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { supportedChains } from './chains';

/**
 * Wagmi and RainbowKit configuration
 *
 * Configures:
 * - Supported chains (Ethereum mainnet + Sepolia testnet)
 * - Wallet connectors (MetaMask, WalletConnect, Coinbase)
 * - WalletConnect project ID from environment
 */
export const config = getDefaultConfig({
  appName: 'Dark Pool',
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || '',
  chains: supportedChains,
  ssr: true, // Enable server-side rendering support
});

/**
 * RainbowKit theme configuration
 */
export const rainbowKitTheme = {
  accentColor: '#7c3aed', // purple-primary
  accentColorForeground: 'white',
  borderRadius: 'medium',
  fontStack: 'system',
} as const;
