'use client';

import { Order } from '@/types/order';
import { formatDistanceToNow } from 'date-fns';
import { useMemo } from 'react';
import { getTokenSymbol } from '@/utils/tokens';

interface OrderCardProps {
  order: Order;
}

/**
 * OrderCard - Displays individual order information
 *
 * Features:
 * - Token pair with symbols
 * - Order type badge (BUY/SELL)
 * - Quantity and price
 * - Status badge
 * - Progress bar for partially filled orders
 * - Relative timestamp
 */
export function OrderCard({ order }: OrderCardProps) {
  // Calculate fill percentage
  const fillPercentage = useMemo(() => {
    const filled = parseFloat(order.filled_quantity);
    const total = parseFloat(order.quantity);
    return total > 0 ? (filled / total) * 100 : 0;
  }, [order.filled_quantity, order.quantity]);

  // Get status color
  const statusColor = useMemo(() => {
    switch (order.status) {
      case 'PENDING':
        return 'text-yellow-400 bg-yellow-400/10 border-yellow-400/30';
      case 'PARTIALLY_FILLED':
        return 'text-blue-400 bg-blue-400/10 border-blue-400/30';
      case 'FILLED':
        return 'text-green-400 bg-green-400/10 border-green-400/30';
      case 'CANCELLED':
        return 'text-gray-400 bg-gray-400/10 border-gray-400/30';
      case 'EXPIRED':
        return 'text-red-400 bg-red-400/10 border-red-400/30';
      default:
        return 'text-purple-400 bg-purple-400/10 border-purple-400/30';
    }
  }, [order.status]);

  // Get order type color
  const orderTypeColor = order.order_type === 'BUY'
    ? 'text-green-400 bg-green-400/10 border-green-400/30'
    : 'text-red-400 bg-red-400/10 border-red-400/30';

  // Format relative time
  const relativeTime = useMemo(() => {
    try {
      return formatDistanceToNow(new Date(order.created_at), { addSuffix: true });
    } catch {
      return 'Unknown time';
    }
  }, [order.created_at]);

  // Get token symbols from addresses
  const baseSymbol = getTokenSymbol(order.base_token, order.chain_id);
  const quoteSymbol = getTokenSymbol(order.quote_token, order.chain_id);

  return (
    <div className="bg-dark-bg/40 backdrop-blur-sm border border-purple-primary/10 rounded-lg p-4 hover:border-purple-primary/25 transition-all duration-200">
      {/* Header - Type and Status */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={`px-2 py-1 rounded text-xs font-semibold border ${orderTypeColor}`}>
            {order.order_type}
          </span>
          <span className="text-purple-secondary font-medium">
            {baseSymbol}/{quoteSymbol}
          </span>
        </div>
        <span className={`px-2 py-1 rounded text-xs font-semibold border ${statusColor}`}>
          {order.status.replace('_', ' ')}
        </span>
      </div>

      {/* Order Details */}
      <div className="space-y-1 mb-3">
        <div className="flex justify-between text-sm">
          <span className="text-purple-secondary/70">Quantity:</span>
          <span className="text-white font-medium">{order.quantity} {baseSymbol}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-purple-secondary/70">Price:</span>
          <span className="text-white font-medium">{order.price} {quoteSymbol}</span>
        </div>
        {fillPercentage > 0 && fillPercentage < 100 && (
          <div className="flex justify-between text-sm">
            <span className="text-purple-secondary/70">Filled:</span>
            <span className="text-white font-medium">{order.filled_quantity} {baseSymbol}</span>
          </div>
        )}
      </div>

      {/* Progress Bar for Partially Filled */}
      {order.status === 'PARTIALLY_FILLED' && (
        <div className="mb-3">
          <div className="w-full bg-dark-bg rounded-full h-2 overflow-hidden">
            <div
              className="bg-gradient-to-r from-blue-500 to-purple-500 h-full transition-all duration-500"
              style={{ width: `${fillPercentage}%` }}
            />
          </div>
          <div className="text-xs text-purple-secondary/70 mt-1 text-right">
            {fillPercentage.toFixed(1)}% filled
          </div>
        </div>
      )}

      {/* Timestamp */}
      <div className="text-xs text-purple-secondary/50 pt-2 border-t border-purple-primary/10">
        {relativeTime}
      </div>
    </div>
  );
}
