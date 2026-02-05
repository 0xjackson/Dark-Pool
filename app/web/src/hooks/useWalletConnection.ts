'use client';

import { useAccount, useDisconnect, useConnect } from 'wagmi';
import { truncateAddress } from '@/types/wallet';

/**
 * Custom hook to abstract wallet connection logic
 *
 * Returns wallet state and helper functions:
 * - address: Connected wallet address
 * - isConnected: Connection status
 * - isConnecting: Loading state
 * - chainId: Current network ID
 * - truncatedAddress: Shortened address (0x1234...5678)
 * - disconnect: Function to disconnect wallet
 */
export function useWalletConnection() {
  const { address, isConnected, isConnecting, chainId } = useAccount();
  const { disconnect } = useDisconnect();
  const { connectors, connect } = useConnect();

  return {
    address,
    isConnected,
    isConnecting,
    chainId,
    truncatedAddress: truncateAddress(address),
    disconnect,
    connect: () => {
      // RainbowKit handles connection UI
      // This is just for programmatic access if needed
      const connector = connectors[0];
      if (connector) {
        connect({ connector });
      }
    },
  };
}
