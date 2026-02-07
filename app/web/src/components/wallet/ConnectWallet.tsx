'use client';

import { motion } from 'framer-motion';
import { useAccount } from 'wagmi';
import { useTradeModal } from '@/hooks/useTradeModal';
import { TradeModal } from '@/components/trading/TradeModal';
import { useSessionKey } from '@/hooks/useSessionKey';

/**
 * Hero section for center content
 *
 * Features:
 * - Tagline message
 * - Trade button
 * - Smooth entrance animation
 * - Orders drawer integration
 */
interface ConnectWalletProps {
  onOrderSuccess?: () => void;
}

export function ConnectWallet({ onOrderSuccess }: ConnectWalletProps) {
  const { isOpen, openModal, closeModal } = useTradeModal();
  const { isConnected } = useAccount();
  const { status: sessionKeyStatus, isLoading: sessionKeyLoading, error: sessionKeyError, retry: retrySessionKey } = useSessionKey();

  const handleOrderSuccess = () => {
    onOrderSuccess?.();
  };

  return (
    <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="text-center flex flex-col items-center gap-8"
      >
        <p className="text-5xl text-purple-secondary font-medium">
          Permissionless OTC peer-to-peer trading
        </p>
        <button
          type="button"
          onClick={openModal}
          className="px-10 py-4 bg-dark-elevated/80 backdrop-blur-xl border border-purple-primary/30 hover:border-purple-primary/50 text-purple-secondary hover:text-white text-lg font-semibold rounded-lg transition-all duration-200"
        >
          Trade
        </button>
        {isConnected && sessionKeyLoading && (
          <p className="text-sm text-purple-secondary/70 animate-pulse">
            {sessionKeyStatus === 'creating' && 'Preparing session key...'}
            {sessionKeyStatus === 'signing' && 'Please sign the session key in your wallet...'}
            {sessionKeyStatus === 'activating' && 'Activating session key...'}
          </p>
        )}
        {isConnected && sessionKeyError && (
          <p className="text-sm text-red-400">
            {sessionKeyError}{' '}
            <button
              type="button"
              onClick={retrySessionKey}
              className="underline text-purple-secondary hover:text-white transition-colors"
            >
              Try again
            </button>
          </p>
        )}
        <TradeModal
          isOpen={isOpen}
          onClose={closeModal}
          onOrderSuccess={handleOrderSuccess}
        />
      </motion.div>
  );
}
