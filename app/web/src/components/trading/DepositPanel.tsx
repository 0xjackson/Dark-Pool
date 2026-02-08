'use client';

import { useState, useEffect } from 'react';
import { useAccount, useBalance, useChainId } from 'wagmi';
import { formatUnits } from 'viem';
import { motion, AnimatePresence } from 'framer-motion';
import { useYellowDeposit } from '@/hooks/useYellowDeposit';
import { useSessionKey } from '@/providers/SessionKeyProvider';
import { useUnifiedBalance } from '@/providers/UnifiedBalanceProvider';
import { getChainTokens } from '@/config/tokens';

const NATIVE_ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

/**
 * DepositPanel — lets users deposit funds to Yellow Network.
 * Shows wallet balance + unified balance, with a deposit form.
 */
export function DepositPanel() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { isActive: sessionKeyActive } = useSessionKey();
  const {
    step,
    stepMessage,
    loading,
    error,
    deposit,
    reset,
  } = useYellowDeposit();
  const { balances } = useUnifiedBalance();

  const [selectedToken, setSelectedToken] = useState<string>('');
  const [amount, setAmount] = useState('');
  const [selectedDecimals, setSelectedDecimals] = useState(18);

  const tokens = getChainTokens(chainId);

  // Set default token
  useEffect(() => {
    if (tokens.length > 0 && !selectedToken) {
      setSelectedToken(tokens[0].address);
      setSelectedDecimals(tokens[0].decimals);
    }
  }, [tokens, selectedToken]);

  // Get native ETH balance
  const { data: ethBalance } = useBalance({ address });

  const handleDeposit = async () => {
    if (!selectedToken || !amount || parseFloat(amount) <= 0) return;
    await deposit(selectedToken, amount, selectedDecimals);
    if (step === 'complete') {
      setAmount('');
    }
  };

  const handleTokenChange = (tokenAddr: string) => {
    setSelectedToken(tokenAddr);
    const token = tokens.find((t) => t.address === tokenAddr);
    setSelectedDecimals(token?.decimals || 18);
    setAmount('');
  };

  const selectedTokenInfo = tokens.find((t) => t.address === selectedToken);
  const isNativeETH = selectedToken.toLowerCase() === NATIVE_ETH.toLowerCase();

  // Find unified balance for selected token
  const unifiedBalance = balances.find(
    (b) => b.asset.toLowerCase() === (selectedTokenInfo?.symbol || '').toLowerCase()
  );

  return (
    <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl p-6">
      <h3 className="text-lg font-semibold text-white mb-4">
        Fund Account
      </h3>

      {!isConnected ? (
        <p className="text-white/50 text-sm">Connect wallet to deposit</p>
      ) : !sessionKeyActive ? (
        <p className="text-white/50 text-sm">Session key required. It will activate automatically.</p>
      ) : (
        <>
          {/* Unified balance display */}
          <div className="mb-4 p-3 bg-white/5 rounded-xl">
            <p className="text-xs text-white/40 mb-1">Yellow Unified Balance</p>
            <div className="space-y-1">
              {balances.length === 0 ? (
                <p className="text-sm text-white/30">No balance yet</p>
              ) : (
                balances.map((b) => (
                  <div key={b.asset} className="flex justify-between text-sm">
                    <span className="text-white/60 uppercase">{b.asset}</span>
                    <span className="text-white font-mono">{b.amount}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Token selector */}
          <div className="mb-3">
            <label className="text-xs text-white/40 mb-1 block">Token</label>
            <select
              value={selectedToken}
              onChange={(e) => handleTokenChange(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500/50"
              disabled={loading}
            >
              {tokens.map((t) => (
                <option key={t.address} value={t.address}>
                  {t.symbol}
                </option>
              ))}
            </select>
          </div>

          {/* Wallet balance hint */}
          <div className="mb-1 flex justify-between text-xs text-white/40">
            <span>Amount</span>
            <span>
              Wallet:{' '}
              {isNativeETH && ethBalance
                ? `${parseFloat(formatUnits(ethBalance.value, 18)).toFixed(6)} ETH`
                : '—'}
            </span>
          </div>

          {/* Amount input */}
          <div className="mb-4">
            <input
              type="number"
              step="any"
              min="0"
              placeholder="0.0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-purple-500/50"
              disabled={loading}
            />
          </div>

          {/* Deposit button */}
          <button
            onClick={handleDeposit}
            disabled={loading || !amount || parseFloat(amount) <= 0}
            className="w-full py-2.5 px-4 rounded-xl font-medium text-sm transition-all
              bg-gradient-to-r from-purple-600 to-blue-600 text-white
              hover:from-purple-500 hover:to-blue-500
              disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loading ? stepMessage : 'Deposit to Yellow'}
          </button>

          {/* Status / Error */}
          <AnimatePresence>
            {error && (
              <motion.div
                initial={{ opacity: 0, y: -5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="mt-3 p-2 rounded-lg bg-red-500/10 border border-red-500/20"
              >
                <p className="text-xs text-red-400">{error}</p>
                <button
                  onClick={reset}
                  className="text-xs text-red-300 underline mt-1"
                >
                  Dismiss
                </button>
              </motion.div>
            )}
            {step === 'complete' && (
              <motion.div
                initial={{ opacity: 0, y: -5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="mt-3 p-2 rounded-lg bg-green-500/10 border border-green-500/20"
              >
                <p className="text-xs text-green-400">
                  Deposit successful! Your unified balance has been updated.
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
    </div>
  );
}
