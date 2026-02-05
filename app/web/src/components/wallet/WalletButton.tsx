'use client';

import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useWalletConnection } from '@/hooks/useWalletConnection';
import { getChainName } from '@/config/chains';

/**
 * Wallet button component for connected state
 *
 * Features:
 * - Displays truncated address
 * - Shows current network
 * - Disconnect functionality
 * - Uses RainbowKit's built-in UI
 */
export function WalletButton() {
  const { chainId } = useWalletConnection();

  return (
    <ConnectButton.Custom>
      {({
        account,
        chain,
        openAccountModal,
        openChainModal,
        openConnectModal,
        mounted,
      }) => {
        const ready = mounted;
        const connected = ready && account && chain;

        return (
          <div
            {...(!ready && {
              'aria-hidden': true,
              style: {
                opacity: 0,
                pointerEvents: 'none',
                userSelect: 'none',
              },
            })}
          >
            {(() => {
              if (!connected) {
                return (
                  <button
                    onClick={openConnectModal}
                    type="button"
                    className="px-6 py-3 bg-purple-primary hover:bg-purple-glow text-white font-semibold rounded-lg transition-all duration-200 shadow-lg hover:shadow-purple-glow/50"
                  >
                    Connect Wallet
                  </button>
                );
              }

              if (chain.unsupported) {
                return (
                  <button
                    onClick={openChainModal}
                    type="button"
                    className="px-6 py-3 bg-red-600 hover:bg-red-700 text-white font-semibold rounded-lg transition-all duration-200"
                  >
                    Wrong Network
                  </button>
                );
              }

              return (
                <div className="flex items-center gap-3">
                  {/* Chain Switcher */}
                  <button
                    onClick={openChainModal}
                    type="button"
                    className="flex items-center gap-2 px-4 py-2 bg-dark-elevated/50 backdrop-blur-xl border border-purple-primary/20 rounded-lg text-purple-secondary hover:border-purple-primary/40 transition-all"
                  >
                    {chain.hasIcon && (
                      <div
                        style={{
                          background: chain.iconBackground,
                          width: 16,
                          height: 16,
                          borderRadius: 999,
                          overflow: 'hidden',
                        }}
                      >
                        {chain.iconUrl && (
                          <img
                            alt={chain.name ?? 'Chain icon'}
                            src={chain.iconUrl}
                            style={{ width: 16, height: 16 }}
                          />
                        )}
                      </div>
                    )}
                    <span className="text-sm">{chain.name}</span>
                  </button>

                  {/* Account Button */}
                  <button
                    onClick={openAccountModal}
                    type="button"
                    className="px-6 py-3 bg-dark-surface/30 backdrop-blur-xl border border-purple-primary/20 rounded-lg text-white font-mono hover:border-purple-primary/40 transition-all shadow-lg"
                  >
                    {account.displayName}
                  </button>
                </div>
              );
            })()}
          </div>
        );
      }}
    </ConnectButton.Custom>
  );
}
