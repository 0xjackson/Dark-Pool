'use client';

import { useState, useEffect } from 'react';
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseUnits } from 'viem';
import type { Token } from '@/types/trading';

const CUSTODY_ADDRESS = (process.env.NEXT_PUBLIC_CUSTODY_ADDRESS ||
  '0x0000000000000000000000000000000000000000') as `0x${string}`;

const CUSTODY_ABI = [
  {
    name: 'withdraw',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

interface WithdrawButtonProps {
  token: Token;
  maxBalance?: string;
  onSuccess?: () => void;
}

/**
 * WithdrawButton — Allows users to withdraw tokens from Yellow Custody.
 * Calls custody.withdraw(token, amount) on-chain.
 */
export function WithdrawButton({ token, maxBalance, onSuccess }: WithdrawButtonProps) {
  const { address } = useAccount();
  const [amount, setAmount] = useState('');
  const [showInput, setShowInput] = useState(false);

  const { data: hash, writeContract, isPending, error: writeError, reset } = useWriteContract();

  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({
    hash,
  });

  const handleWithdraw = () => {
    if (!amount || !address) return;

    const parsedAmount = parseUnits(amount, token.decimals);
    if (parsedAmount <= 0n) return;

    writeContract({
      address: CUSTODY_ADDRESS,
      abi: CUSTODY_ABI,
      functionName: 'withdraw',
      args: [token.address as `0x${string}`, parsedAmount],
    });
  };

  const handleMax = () => {
    if (maxBalance) setAmount(maxBalance);
  };

  // Reset after success
  useEffect(() => {
    if (!isSuccess) return;
    const timer = setTimeout(() => {
      setAmount('');
      setShowInput(false);
      reset();
      onSuccess?.();
    }, 2000);
    return () => clearTimeout(timer);
  }, [isSuccess, reset, onSuccess]);

  if (!address) return null;
  if (CUSTODY_ADDRESS === '0x0000000000000000000000000000000000000000') return null;

  if (!showInput) {
    return (
      <button
        type="button"
        onClick={() => setShowInput(true)}
        className="text-xs text-purple-primary hover:text-purple-glow transition-colors"
      >
        Withdraw
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 mt-2">
      <div className="relative flex-1">
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
          step="any"
          min="0"
          className="w-full bg-dark-bg/50 border border-purple-primary/30 rounded-lg px-3 py-1.5 text-sm text-white placeholder-purple-secondary/40 focus:outline-none focus:border-purple-primary/60"
          disabled={isPending || isConfirming}
        />
        {maxBalance && (
          <button
            type="button"
            onClick={handleMax}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-purple-primary hover:text-purple-glow"
          >
            MAX
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={handleWithdraw}
        disabled={isPending || isConfirming || !amount}
        className="px-3 py-1.5 text-xs font-medium rounded-lg bg-purple-primary/20 text-purple-primary hover:bg-purple-primary/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {isPending ? 'Sign...' : isConfirming ? 'Confirming...' : isSuccess ? 'Done' : 'Send'}
      </button>
      <button
        type="button"
        onClick={() => { setShowInput(false); setAmount(''); reset(); }}
        className="text-xs text-purple-secondary/70 hover:text-white"
      >
        Cancel
      </button>
      {writeError && (
        <span className="text-xs text-red-400 truncate max-w-[120px]" title={writeError.message}>
          Error
        </span>
      )}
    </div>
  );
}
