'use client';

import { PoolBackground } from '@/components/animations/PoolBackground';
import { GlowOrb } from '@/components/animations/GlowOrb';
import { Container } from '@/components/ui/Container';
import { ConnectWallet } from '@/components/wallet/ConnectWallet';
import { WalletButton } from '@/components/wallet/WalletButton';
import { useWalletConnection } from '@/hooks/useWalletConnection';

export default function Home() {
  const { isConnected } = useWalletConnection();

  return (
    <main className="min-h-screen bg-gradient-to-br from-dark-bg via-dark-surface to-dark-elevated overflow-hidden">
      {/* Animated Background */}
      <PoolBackground />

      {/* Floating Glow Orbs */}
      <GlowOrb delay={0} duration={35} size={400} initialX="10%" initialY="20%" />
      <GlowOrb delay={5} duration={40} size={300} initialX="80%" initialY="60%" color="rgba(192, 132, 252, 0.25)" />
      <GlowOrb delay={10} duration={45} size={350} initialX="50%" initialY="80%" color="rgba(167, 139, 250, 0.2)" />

      {/* Main Content */}
      <Container>
        {isConnected ? <WalletButton /> : <ConnectWallet />}
      </Container>
    </main>
  );
}
