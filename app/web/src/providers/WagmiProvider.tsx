'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider as WagmiProviderBase } from 'wagmi';
import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit';
import { config, rainbowKitTheme } from '@/config/wagmi';
import { SessionKeyProvider } from '@/providers/SessionKeyProvider';
import { UnifiedBalanceProvider } from '@/providers/UnifiedBalanceProvider';
import '@rainbow-me/rainbowkit/styles.css';

/**
 * TanStack Query client for wallet state management
 */
const queryClient = new QueryClient();

/**
 * Main provider component that wraps the app with wallet functionality
 *
 * Provider hierarchy:
 * 1. QueryClientProvider - TanStack Query for state management
 * 2. WagmiProvider - Wagmi hooks and wallet connection
 * 3. RainbowKitProvider - Pre-built wallet UI components
 */
export function WagmiProvider({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <WagmiProviderBase config={config}>
        <RainbowKitProvider
          theme={darkTheme({
            ...rainbowKitTheme,
            overlayBlur: 'small',
          })}
        >
          <SessionKeyProvider>
            <UnifiedBalanceProvider>
              {children}
            </UnifiedBalanceProvider>
          </SessionKeyProvider>
        </RainbowKitProvider>
      </WagmiProviderBase>
    </QueryClientProvider>
  );
}
