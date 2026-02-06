'use client';

import { TradingPair } from '@/types/trading';
import { getTradingPairs } from '@/config/tokens';

interface TokenPairSelectorProps {
  value: TradingPair | null;
  onChange: (pair: TradingPair | null) => void;
  chainId: number;
}

/**
 * TokenPairSelector component - Dropdown for selecting trading pairs
 *
 * Features:
 * - Glass morphism design with backdrop blur
 * - Displays available trading pairs for the selected chain
 * - Format: "ETH/USDC", "WBTC/USDC" (baseToken/quoteToken)
 * - Handles case where no trading pairs are available for the chain
 * - Purple-themed focus states with ring effect
 */
export function TokenPairSelector({
  value,
  onChange,
  chainId,
}: TokenPairSelectorProps) {
  const tradingPairs = getTradingPairs(chainId);
  const hasPairs = tradingPairs.length > 0;

  const handleChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const selectedPairId = event.target.value;

    if (!selectedPairId) {
      onChange(null);
      return;
    }

    const selectedPair = tradingPairs.find((pair) => pair.id === selectedPairId);
    onChange(selectedPair || null);
  };

  return (
    <div className="w-full">
      <select
        value={value?.id || ''}
        onChange={handleChange}
        disabled={!hasPairs}
        className={`
          w-full px-4 py-3 rounded-lg text-white
          bg-dark-surface/30 backdrop-blur-xl
          border border-purple-primary/20
          focus:outline-none focus:border-purple-primary/50 focus:ring-2 focus:ring-purple-primary/20
          transition-all duration-200
          ${
            !hasPairs
              ? 'cursor-not-allowed opacity-50'
              : 'cursor-pointer hover:border-purple-primary/30'
          }
        `}
      >
        {!hasPairs ? (
          <option value="">No trading pairs available for this chain</option>
        ) : (
          <>
            <option value="">Select trading pair...</option>
            {tradingPairs.map((pair) => (
              <option key={pair.id} value={pair.id}>
                {pair.baseToken.symbol}/{pair.quoteToken.symbol}
              </option>
            ))}
          </>
        )}
      </select>
    </div>
  );
}
