'use client';

import { Match } from '@/types/order';
import { formatDistanceToNow } from 'date-fns';
import { useMemo } from 'react';
import { getTokenSymbol } from '@/utils/tokens';

interface MatchCardProps {
  match: Match;
  userAddress?: string;
}

/**
 * MatchCard - Displays completed match/trade information
 *
 * Features:
 * - Token pair
 * - Matched quantity and price
 * - Settlement status
 * - Counterparty address (truncated)
 * - Match timestamp
 * - Settlement transaction link (if settled)
 */
export function MatchCard({ match, userAddress }: MatchCardProps) {
  // Get settlement status color
  const statusColor = match.settlement_status === 'SETTLED'
    ? 'text-green-400 bg-green-400/10 border-green-400/30'
    : 'text-yellow-400 bg-yellow-400/10 border-yellow-400/30';

  // Format relative time
  const relativeTime = useMemo(() => {
    try {
      return formatDistanceToNow(new Date(match.matched_at), { addSuffix: true });
    } catch {
      return 'Unknown time';
    }
  }, [match.matched_at]);

  // Determine user's role and counterparty
  const isBuyer = userAddress?.toLowerCase() === match.buyer_address?.toLowerCase();
  const userRole = isBuyer ? 'BUY' : 'SELL';
  const counterparty = isBuyer ? match.seller_address : match.buyer_address;

  // Truncate address
  const truncateAddress = (address?: string) => {
    if (!address) return 'Unknown';
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  };

  // Get token symbols from addresses
  const baseSymbol = getTokenSymbol(match.base_token);
  const quoteSymbol = getTokenSymbol(match.quote_token);

  // Calculate total value
  const totalValue = useMemo(() => {
    const quantity = parseFloat(match.quantity);
    const price = parseFloat(match.price);
    return (quantity * price).toFixed(2);
  }, [match.quantity, match.price]);

  return (
    <div className="bg-dark-surface/50 backdrop-blur-sm border border-purple-primary/20 rounded-lg p-4 hover:border-purple-primary/40 transition-all duration-200">
      {/* Header - Token Pair and Status */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={`px-2 py-1 rounded text-xs font-semibold border ${
            userRole === 'BUY'
              ? 'text-green-400 bg-green-400/10 border-green-400/30'
              : 'text-red-400 bg-red-400/10 border-red-400/30'
          }`}>
            {userRole}
          </span>
          <span className="text-purple-secondary font-medium">
            {baseSymbol}/{quoteSymbol}
          </span>
        </div>
        <span className={`px-2 py-1 rounded text-xs font-semibold border ${statusColor}`}>
          {match.settlement_status}
        </span>
      </div>

      {/* Match Details */}
      <div className="space-y-1 mb-3">
        <div className="flex justify-between text-sm">
          <span className="text-purple-secondary/70">Quantity:</span>
          <span className="text-white font-medium">{match.quantity} {baseSymbol}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-purple-secondary/70">Price:</span>
          <span className="text-white font-medium">{match.price} {quoteSymbol}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-purple-secondary/70">Total Value:</span>
          <span className="text-white font-medium">{totalValue} {quoteSymbol}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-purple-secondary/70">Counterparty:</span>
          <span className="text-purple-secondary font-mono text-xs">
            {truncateAddress(counterparty)}
          </span>
        </div>
      </div>

      {/* Settlement Info */}
      {match.settlement_status === 'SETTLED' && match.settled_at && (
        <div className="text-xs text-green-400/70 mb-2">
          Settled {formatDistanceToNow(new Date(match.settled_at), { addSuffix: true })}
        </div>
      )}

      {/* Timestamp */}
      <div className="text-xs text-purple-secondary/50 pt-2 border-t border-purple-primary/10">
        Matched {relativeTime}
      </div>
    </div>
  );
}
