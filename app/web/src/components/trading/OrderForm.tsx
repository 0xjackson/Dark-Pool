'use client';

import { useState, useEffect } from 'react';
import { useAccount, useChainId } from 'wagmi';
import { motion, AnimatePresence } from 'framer-motion';
import { TokenPairSelector } from './TokenPairSelector';
import { OrderTypeToggle } from './OrderTypeToggle';
import { SlippageInput } from './SlippageInput';
import { useSubmitTrade } from '@/hooks/useSubmitTrade';
import { useSessionKey } from '@/providers/SessionKeyProvider';
import { useYellowDeposit } from '@/hooks/useYellowDeposit';
import { useUnifiedBalance } from '@/providers/UnifiedBalanceProvider';
import { validateOrderForm } from '@/utils/validation';
import { TradingPair } from '@/types/trading';
import { OrderType } from '@/types/order';

interface OrderFormProps {
  onSuccess?: () => void;
}

/**
 * OrderForm component - Complete form for submitting dark pool orders
 *
 * Features:
 * - Composes all order sub-components (TokenPairSelector, OrderTypeToggle, etc.)
 * - Client-side validation with inline error messages
 * - Loading states and submission feedback
 * - Success/error handling with auto-reset
 * - Glass morphism design with purple gradient submit button
 * - Disables submit when wallet not connected or form invalid
 */
export function OrderForm({ onSuccess }: OrderFormProps) {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { loading, error, success, submitTrade, stepMessage, reset } = useSubmitTrade();
  const { isActive: sessionKeyActive, isLoading: sessionKeyLoading, error: sessionKeyError, retry: retrySessionKey } = useSessionKey();
  const {
    deposit: yellowDeposit,
    loading: depositLoading,
    stepMessage: depositStepMessage,
    step: depositStep,
    reset: resetDeposit,
    error: depositError,
  } = useYellowDeposit();
  const { balances: unifiedBalances } = useUnifiedBalance();

  // Form state
  const [tokenPair, setTokenPair] = useState<TradingPair | null>(null);
  const [orderType, setOrderType] = useState<OrderType>('BUY');
  const [amount, setAmount] = useState('');
  const [price, setPrice] = useState('');
  const [slippage, setSlippage] = useState(0.5);

  // Validation errors
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [insufficientBalance, setInsufficientBalance] = useState<{
    token: string;
    symbol: string;
    decimals: number;
    needed: string;
    available: string;
  } | null>(null);

  // Clear deposit state when deposit completes
  useEffect(() => {
    if (depositStep === 'complete') {
      setInsufficientBalance(null);
      resetDeposit();
    }
  }, [depositStep, resetDeposit]);

  // Handle successful submission
  useEffect(() => {
    if (success) {
      // Call onSuccess callback if provided
      if (onSuccess) {
        onSuccess();
      }

      // Reset form after 2 seconds
      const timeout = setTimeout(() => {
        // Reset form state
        setTokenPair(null);
        setOrderType('BUY');
        setAmount('');
        setPrice('');
        setSlippage(0.5);
        setErrors({});
        reset();
      }, 2000);

      return () => clearTimeout(timeout);
    }
  }, [success, onSuccess, reset]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Clear previous errors
    setErrors({});
    setInsufficientBalance(null);

    // Validate form
    const formData = {
      tokenPair: tokenPair!,
      orderType,
      amount,
      price,
      slippage,
    };

    const validationErrors = validateOrderForm(formData);

    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }

    // Check unified balance before submitting
    const isBuy = orderType === 'BUY';
    const sellToken = isBuy ? tokenPair!.quoteToken : tokenPair!.baseToken;
    const sellAmount = isBuy
      ? (parseFloat(amount) * parseFloat(price)).toString()
      : amount;

    const matchingBalance = unifiedBalances.find(
      (b) => b.asset.toLowerCase() === sellToken.symbol.toLowerCase()
    );
    const available = parseFloat(matchingBalance?.amount || '0');

    if (available < parseFloat(sellAmount)) {
      setInsufficientBalance({
        token: sellToken.address,
        symbol: sellToken.symbol,
        decimals: sellToken.decimals,
        needed: sellAmount,
        available: available.toString(),
      });
      return;
    }

    // Submit trade (commit → submit to matching engine)
    await submitTrade(formData);
  };

  const handleDepositAndRetry = async () => {
    if (!insufficientBalance) return;
    const deficit = (
      parseFloat(insufficientBalance.needed) - parseFloat(insufficientBalance.available)
    ).toString();
    await yellowDeposit(
      insufficientBalance.token,
      deficit,
      insufficientBalance.decimals,
    );
  };

  // Check if form is valid
  const isFormValid =
    isConnected &&
    sessionKeyActive &&
    tokenPair &&
    amount.trim() !== '' &&
    price.trim() !== '' &&
    !loading;

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Token Pair Selector */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-gray-300">
          Trading Pair
        </label>
        <TokenPairSelector
          value={tokenPair}
          onChange={setTokenPair}
          chainId={chainId}
        />
        {errors.tokenPair && (
          <motion.p
            initial={{ opacity: 0, y: -5 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-red-400 text-sm"
          >
            {errors.tokenPair}
          </motion.p>
        )}
      </div>

      {/* Order Type Toggle */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-gray-300">Order Type</label>
        <OrderTypeToggle value={orderType} onChange={setOrderType} />
      </div>

      {/* Amount Input */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-gray-300">Amount</label>
        <input
          type="text"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.0"
          className={`
            w-full px-4 py-3 rounded-lg text-white placeholder-gray-500
            bg-dark-surface/30 backdrop-blur-xl
            border transition-all duration-200
            focus:outline-none focus:ring-2 focus:ring-purple-primary/20
            ${
              errors.amount
                ? 'border-red-400/50 focus:border-red-400'
                : 'border-purple-primary/20 focus:border-purple-primary/50'
            }
          `}
        />
        {errors.amount && (
          <motion.p
            initial={{ opacity: 0, y: -5 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-red-400 text-sm"
          >
            {errors.amount}
          </motion.p>
        )}
      </div>

      {/* Price Input */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-gray-300">Price</label>
        <input
          type="text"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          placeholder="0.0"
          className={`
            w-full px-4 py-3 rounded-lg text-white placeholder-gray-500
            bg-dark-surface/30 backdrop-blur-xl
            border transition-all duration-200
            focus:outline-none focus:ring-2 focus:ring-purple-primary/20
            ${
              errors.price
                ? 'border-red-400/50 focus:border-red-400'
                : 'border-purple-primary/20 focus:border-purple-primary/50'
            }
          `}
        />
        {errors.price && (
          <motion.p
            initial={{ opacity: 0, y: -5 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-red-400 text-sm"
          >
            {errors.price}
          </motion.p>
        )}
      </div>

      {/* Slippage Input */}
      <SlippageInput
        value={slippage}
        onChange={setSlippage}
        error={errors.slippage}
      />

      {/* General Error */}
      {errors.general && (
        <motion.div
          initial={{ opacity: 0, y: -5 }}
          animate={{ opacity: 1, y: 0 }}
          className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg"
        >
          <p className="text-red-400 text-sm">{errors.general}</p>
        </motion.div>
      )}

      {/* API Error */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, y: -5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg"
          >
            <p className="text-red-400 text-sm">{error}</p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Success Message */}
      <AnimatePresence>
        {success && (
          <motion.div
            initial={{ opacity: 0, y: -5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            className="p-3 bg-green-500/10 border border-green-500/30 rounded-lg"
          >
            <p className="text-green-400 text-sm">
              Order submitted successfully!
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Insufficient Balance Warning + Deposit */}
      <AnimatePresence>
        {insufficientBalance && (
          <motion.div
            initial={{ opacity: 0, y: -5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            className="p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg"
          >
            <p className="text-yellow-400 text-sm mb-2">
              Insufficient {insufficientBalance.symbol} unified balance.
              Need {insufficientBalance.needed}, have {insufficientBalance.available}.
            </p>
            {depositLoading ? (
              <p className="text-yellow-300 text-xs animate-pulse">{depositStepMessage}</p>
            ) : (
              <button
                type="button"
                onClick={handleDepositAndRetry}
                className="text-sm px-3 py-1.5 rounded-lg bg-yellow-500/20 text-yellow-300 hover:bg-yellow-500/30 transition-colors"
              >
                Deposit {(parseFloat(insufficientBalance.needed) - parseFloat(insufficientBalance.available)).toFixed(6)} {insufficientBalance.symbol}
              </button>
            )}
            {depositError && (
              <p className="text-red-400 text-xs mt-1">{depositError}</p>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Submit Button */}
      <motion.button
        type="submit"
        disabled={!isFormValid || !!insufficientBalance}
        whileHover={isFormValid && !insufficientBalance ? { scale: 1.02 } : undefined}
        whileTap={isFormValid && !insufficientBalance ? { scale: 0.98 } : undefined}
        className={`
          w-full py-4 rounded-lg font-semibold text-white text-lg
          transition-all duration-200
          ${
            isFormValid && !insufficientBalance
              ? 'bg-gradient-to-r from-purple-primary to-purple-glow hover:shadow-lg hover:shadow-purple-primary/25'
              : 'bg-gray-600/50 cursor-not-allowed opacity-50'
          }
        `}
      >
        {loading ? (
          <span className="flex items-center justify-center gap-2">
            <svg
              className="animate-spin h-5 w-5 text-white"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
            {stepMessage || 'Submitting...'}
          </span>
        ) : (
          'Submit Order'
        )}
      </motion.button>

      {/* Status warnings */}
      {!isConnected && (
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="text-center text-sm text-gray-400"
        >
          Connect your wallet to submit orders
        </motion.p>
      )}
      {isConnected && sessionKeyLoading && (
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="text-center text-sm text-purple-secondary/70 animate-pulse"
        >
          Setting up session key...
        </motion.p>
      )}
      {isConnected && sessionKeyError && (
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="text-center text-sm text-red-400"
        >
          {sessionKeyError}{' '}
          <button
            type="button"
            onClick={retrySessionKey}
            className="underline text-purple-secondary hover:text-white transition-colors"
          >
            Try again
          </button>
        </motion.p>
      )}
    </form>
  );
}
