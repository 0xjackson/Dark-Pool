'use client';

import { PoolBackground } from '@/components/animations/PoolBackground';
import { GlowOrb } from '@/components/animations/GlowOrb';
import { Container } from '@/components/ui/Container';
import { Logo } from '@/components/ui/Logo';
import { ConnectWallet } from '@/components/wallet/ConnectWallet';
import { WalletButton } from '@/components/wallet/WalletButton';
import { useWalletConnection } from '@/hooks/useWalletConnection';
import { ConnectButton } from '@rainbow-me/rainbowkit';

export default function Home() {
  const { isConnected } = useWalletConnection();

  return (
    <main className="relative h-screen bg-gradient-to-br from-dark-bg via-dark-surface to-dark-elevated overflow-hidden flex flex-col">
      {/* Animated Background */}
      <PoolBackground />

      {/* Floating Glow Orbs */}
      <GlowOrb delay={0} duration={35} size={400} initialX="10%" initialY="20%" />
      <GlowOrb delay={5} duration={40} size={300} initialX="80%" initialY="60%" color="rgba(192, 132, 252, 0.25)" />
      <GlowOrb delay={10} duration={45} size={350} initialX="50%" initialY="80%" color="rgba(167, 139, 250, 0.2)" />

      {/* Header - Logo and Title (top-left) */}
      <div className="absolute top-0 left-0 p-8 z-20 flex items-center gap-4">
        <Logo width={120} height={120} withGlow />
        <h1 className="text-5xl font-bold bg-gradient-to-r from-purple-secondary via-purple-primary to-purple-glow bg-clip-text text-transparent tracking-tight">
          Dark Pool
        </h1>
      </div>

      {/* Header - Wallet Controls (top-right) */}
      <div className="absolute top-0 right-0 p-8 z-20">
        {isConnected ? (
          <WalletButton />
        ) : (
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
        )}
      </div>

      {/* Main Content - Hero Section (always visible) */}
      <div className="relative z-10 flex-1 flex items-center justify-center p-8">
        <ConnectWallet />
      </div>
    </main>
  );
}
