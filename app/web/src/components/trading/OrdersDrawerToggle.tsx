'use client';

import { motion } from 'framer-motion';

interface OrdersDrawerToggleProps {
  onClick: () => void;
  pendingCount: number;
}

/**
 * OrdersDrawerToggle - Floating button to toggle the orders drawer
 *
 * Features:
 * - Fixed position in top-right corner
 * - Badge showing pending order count
 * - Hover animation
 * - Accessible
 */
export function OrdersDrawerToggle({ onClick, pendingCount }: OrdersDrawerToggleProps) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      className="fixed top-24 right-8 z-40 flex items-center gap-2 px-4 py-3 bg-dark-elevated/80 backdrop-blur-xl border border-purple-primary/30 hover:border-purple-primary/50 rounded-lg shadow-lg hover:shadow-purple-glow/20 transition-all duration-200 group"
      whileHover={{ scale: 1.05 }}
      whileTap={{ scale: 0.95 }}
      aria-label="Toggle orders drawer"
    >
      {/* Icon */}
      <svg
        className="w-5 h-5 text-purple-secondary group-hover:text-white transition-colors duration-200"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
        />
      </svg>

      {/* Text */}
      <span className="text-sm font-medium text-purple-secondary group-hover:text-white transition-colors duration-200">
        Orders
      </span>

      {/* Badge */}
      {pendingCount > 0 && (
        <motion.span
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          className="flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-purple-primary text-white text-xs font-bold"
        >
          {pendingCount}
        </motion.span>
      )}
    </motion.button>
  );
}
