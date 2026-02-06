'use client';

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';

interface SlippageInputProps {
  value: number;
  onChange: (value: number) => void;
  error?: string;
}

/**
 * SlippageInput component - Allows users to set slippage tolerance for trades
 *
 * Features:
 * - Preset buttons for common slippage values (0.1%, 0.5%, 1%, 2%)
 * - Custom input option for decimal values
 * - Glass morphism design with backdrop blur
 * - Framer Motion animations for button interactions
 * - Max validation: Cannot exceed 100%
 * - Info tooltip explaining slippage
 * - Mutual exclusivity between presets and custom input
 */
export function SlippageInput({ value, onChange, error }: SlippageInputProps) {
  const presets = [0.1, 0.5, 1, 2];
  const [customValue, setCustomValue] = useState('');
  const [isCustomActive, setIsCustomActive] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);

  // Initialize custom input state based on whether value matches a preset
  useEffect(() => {
    const isPreset = presets.includes(value);
    setIsCustomActive(!isPreset);
    if (!isPreset && value > 0) {
      setCustomValue(value.toString());
    }
  }, []);

  const handlePresetClick = (preset: number) => {
    setIsCustomActive(false);
    setCustomValue('');
    onChange(preset);
  };

  const handleCustomChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const inputValue = e.target.value;

    // Allow empty string or valid decimal numbers
    if (inputValue === '' || /^\d*\.?\d*$/.test(inputValue)) {
      setCustomValue(inputValue);
      setIsCustomActive(true);

      // Parse and validate the value
      const numValue = parseFloat(inputValue);
      if (!isNaN(numValue)) {
        // Cap at 100%
        const cappedValue = Math.min(numValue, 100);
        onChange(cappedValue);
      }
    }
  };

  const handleCustomFocus = () => {
    setIsCustomActive(true);
  };

  return (
    <div className="w-full space-y-3">
      {/* Label with info tooltip */}
      <div className="flex items-center gap-2">
        <label className="text-sm font-medium text-gray-300">
          Slippage Tolerance
        </label>
        <div className="relative">
          <button
            type="button"
            onMouseEnter={() => setShowTooltip(true)}
            onMouseLeave={() => setShowTooltip(false)}
            className="text-purple-secondary hover:text-purple-primary transition-colors duration-200"
            aria-label="Slippage information"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </button>

          {/* Tooltip */}
          {showTooltip && (
            <motion.div
              initial={{ opacity: 0, y: -5 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -5 }}
              className="absolute left-0 top-6 z-10 w-64 p-3 bg-dark-elevated/95 backdrop-blur-xl border border-purple-primary/30 rounded-lg shadow-xl"
            >
              <p className="text-xs text-gray-300 leading-relaxed">
                Slippage tolerance is the maximum price difference you're
                willing to accept between when you submit a trade and when it
                executes. Higher slippage reduces the chance of failed
                transactions but may result in worse prices.
              </p>
            </motion.div>
          )}
        </div>
      </div>

      {/* Preset buttons */}
      <div className="flex gap-2">
        {presets.map((preset) => {
          const isActive = !isCustomActive && value === preset;

          return (
            <motion.button
              key={preset}
              type="button"
              onClick={() => handlePresetClick(preset)}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              transition={{ duration: 0.2 }}
              className={`
                flex-1 px-4 py-2 rounded-lg font-medium text-sm transition-all duration-200
                ${
                  isActive
                    ? 'bg-purple-primary border border-purple-primary text-white'
                    : 'bg-dark-surface/30 border border-purple-primary/20 text-gray-400 hover:border-purple-primary/40'
                }
              `}
            >
              {preset}%
            </motion.button>
          );
        })}
      </div>

      {/* Custom input */}
      <div className="relative">
        <input
          type="text"
          value={customValue}
          onChange={handleCustomChange}
          onFocus={handleCustomFocus}
          placeholder="Custom"
          className={`
            w-full px-4 py-3 rounded-lg text-white placeholder-gray-500
            bg-dark-surface/30 backdrop-blur-xl
            border transition-all duration-200
            focus:outline-none focus:ring-2 focus:ring-purple-primary/20
            ${
              isCustomActive
                ? 'border-purple-primary/50'
                : 'border-purple-primary/20 focus:border-purple-primary/50'
            }
          `}
        />
        <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none">
          %
        </span>
      </div>

      {/* Error message */}
      {error && (
        <motion.p
          initial={{ opacity: 0, y: -5 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-red-400 text-sm"
        >
          {error}
        </motion.p>
      )}
    </div>
  );
}
