'use client';

import { motion } from 'framer-motion';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { Logo } from '@/components/ui/Logo';

/**
 * Main wallet connection UI for disconnected state
 *
 * Features:
 * - Logo with glow effect
 * - Glass morphism card design
 * - RainbowKit connect button
 * - Smooth entrance animation
 */
export function ConnectWallet() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="flex flex-col items-center gap-8"
    >
      {/* Logo */}
      <Logo width={180} height={180} withGlow />

      {/* Connection Card */}
      <div className="w-full bg-dark-surface/30 backdrop-blur-xl border border-purple-primary/20 rounded-2xl p-8 shadow-2xl">
        <div className="flex flex-col items-center gap-6 text-center">
          {/* Title */}
          <div className="space-y-2">
            <h1 className="text-3xl font-bold text-white">
              Connect Your Wallet
            </h1>
            <p className="text-purple-secondary text-sm">
              Enter the Dark Pool
            </p>
          </div>

          {/* Connect Button */}
          <ConnectButton.Custom>
            {({
              account,
              chain,
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
                  {!connected && (
                    <button
                      onClick={openConnectModal}
                      type="button"
                      className="px-8 py-4 bg-gradient-to-r from-purple-primary to-purple-glow hover:from-purple-glow hover:to-purple-accent text-white font-semibold rounded-lg transition-all duration-200 shadow-lg hover:shadow-purple-glow/50 transform hover:scale-105"
                    >
                      Connect Wallet
                    </button>
                  )}
                </div>
              );
            }}
          </ConnectButton.Custom>

          {/* Info Text */}
          <p className="text-purple-secondary/60 text-xs max-w-xs">
            By connecting, you agree to our terms of service and privacy policy.
            Your wallet will be used to sign transactions securely.
          </p>
        </div>
      </div>
    </motion.div>
  );
}
