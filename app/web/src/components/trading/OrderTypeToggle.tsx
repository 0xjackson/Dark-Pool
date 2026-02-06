'use client';

import { motion } from 'framer-motion';
import { OrderType } from '@/types/order';

interface OrderTypeToggleProps {
  value: OrderType;
  onChange: (value: OrderType) => void;
}

/**
 * OrderTypeToggle component - Segmented control for selecting order type
 *
 * Features:
 * - Glass morphism design with backdrop blur
 * - Animated indicator that slides between options
 * - Spring animation for smooth transitions
 * - Hover effects with scale animation
 */
export function OrderTypeToggle({ value, onChange }: OrderTypeToggleProps) {
  const options: OrderType[] = ['BUY', 'SELL'];

  return (
    <div className="bg-dark-surface/30 backdrop-blur-xl border border-purple-primary/20 rounded-lg p-1">
      <div className="relative flex gap-1">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            className={`
              relative z-10 flex-1 px-6 py-2 rounded-md font-medium text-sm transition-colors duration-200
              ${
                value === option
                  ? 'text-white'
                  : 'text-gray-400 hover:text-white'
              }
            `}
          >
            <motion.span
              className="relative z-10"
              whileHover={{ scale: value === option ? 1 : 1.05 }}
              transition={{ duration: 0.2 }}
            >
              {option === 'BUY' ? 'Buy' : 'Sell'}
            </motion.span>

            {value === option && (
              <motion.div
                layoutId="activeToggle"
                className="absolute inset-0 bg-purple-primary rounded-md"
                transition={{
                  type: 'spring',
                  stiffness: 380,
                  damping: 30,
                }}
              />
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
