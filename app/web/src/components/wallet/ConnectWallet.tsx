'use client';

import { motion } from 'framer-motion';

/**
 * Hero section for center content
 *
 * Features:
 * - Tagline message
 * - Trade button
 * - Smooth entrance animation
 */
export function ConnectWallet() {
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
        className="px-10 py-4 bg-dark-elevated/80 backdrop-blur-xl border border-purple-primary/30 hover:border-purple-primary/50 text-purple-secondary hover:text-white text-lg font-semibold rounded-lg transition-all duration-200"
      >
        Trade
      </button>
    </motion.div>
  );
}
