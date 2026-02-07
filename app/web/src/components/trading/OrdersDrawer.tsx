'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useUserOrders } from '@/hooks/useUserOrders';
import { useUserMatches } from '@/hooks/useUserMatches';
import { useSettlementUpdates } from '@/hooks/useSettlementUpdates';
import { OrderCard } from './OrderCard';
import { MatchCard } from './MatchCard';

interface OrdersDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  userAddress?: string;
  onRefreshTrigger?: number; // Increment this to trigger a refresh
}

type TabType = 'orders' | 'history';

/**
 * OrdersDrawer - Slide-in drawer for viewing orders and matches
 *
 * Features:
 * - Slides in from the right side
 * - Glass morphism design
 * - Two tabs: Open Orders and History
 * - Real-time updates via auto-refresh
 * - Responsive (full screen on mobile, drawer on desktop)
 * - Toggle button with pending order count badge
 */
export function OrdersDrawer({ isOpen, onClose, userAddress, onRefreshTrigger }: OrdersDrawerProps) {
  const [activeTab, setActiveTab] = useState<TabType>('orders');

  // Fetch orders with auto-refresh
  const {
    orders: allOrders,
    loading: ordersLoading,
    error: ordersError,
    refresh: refreshOrders,
  } = useUserOrders(userAddress, {
    autoRefresh: isOpen,
    refreshInterval: 10000,
  });

  // Fetch matches with auto-refresh
  const {
    matches,
    loading: matchesLoading,
    error: matchesError,
    refresh: refreshMatches,
  } = useUserMatches(userAddress, {
    autoRefresh: isOpen,
    refreshInterval: 10000,
  });

  // Filter open orders (PENDING or PARTIALLY_FILLED)
  const openOrders = useMemo(() => {
    return allOrders.filter(
      (order) => order.status === 'PENDING' || order.status === 'PARTIALLY_FILLED'
    );
  }, [allOrders]);

  // Filter completed orders (FILLED, CANCELLED, EXPIRED)
  const completedOrders = useMemo(() => {
    return allOrders.filter(
      (order) => order.status === 'FILLED' || order.status === 'CANCELLED' || order.status === 'EXPIRED'
    );
  }, [allOrders]);

  // Count of pending orders for badge
  const pendingCount = openOrders.length;

  // Real-time settlement/match updates via WebSocket
  useSettlementUpdates(
    useCallback(() => { refreshOrders(); refreshMatches(); }, [refreshOrders, refreshMatches]),
    useCallback(() => { refreshOrders(); refreshMatches(); }, [refreshOrders, refreshMatches]),
  );

  // Trigger refresh when onRefreshTrigger changes
  useEffect(() => {
    if (onRefreshTrigger !== undefined && onRefreshTrigger > 0) {
      refreshOrders();
      refreshMatches();
    }
  }, [onRefreshTrigger, refreshOrders, refreshMatches]);

  // ESC key listener
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isOpen) {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen, onClose]);

  // Manual refresh handler
  const handleRefresh = useCallback(() => {
    refreshOrders();
    refreshMatches();
  }, [refreshOrders, refreshMatches]);

  // Only render portal on client side
  if (typeof window === 'undefined') {
    return null;
  }

  const drawerContent = (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex">
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-0 bg-dark-bg/60 backdrop-blur-sm"
            onClick={onClose}
          />

          {/* Drawer Panel */}
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ duration: 0.3, ease: 'easeInOut' }}
            className="ml-auto relative bg-dark-elevated/95 backdrop-blur-xl border-l border-purple-primary/30 w-full md:w-[400px] h-full overflow-hidden flex flex-col shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="bg-dark-elevated/80 backdrop-blur-xl border-b border-purple-primary/20 px-6 py-4 flex items-center justify-between">
              <h2 className="text-xl font-semibold text-purple-secondary">Orders</h2>
              <div className="flex items-center gap-2">
                {/* Refresh Button */}
                <button
                  type="button"
                  onClick={handleRefresh}
                  className="p-2 text-purple-secondary hover:text-white hover:bg-dark-surface/50 rounded-lg transition-all duration-200"
                  aria-label="Refresh orders"
                  disabled={ordersLoading || matchesLoading}
                >
                  <svg
                    className={`w-5 h-5 ${ordersLoading || matchesLoading ? 'animate-spin' : ''}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                    />
                  </svg>
                </button>
                {/* Close Button */}
                <button
                  type="button"
                  onClick={onClose}
                  className="p-2 text-purple-secondary hover:text-white hover:bg-dark-surface/50 rounded-lg transition-all duration-200"
                  aria-label="Close drawer"
                >
                  <svg
                    className="w-5 h-5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>
            </div>

            {/* Tab Bar */}
            <div className="flex border-b border-purple-primary/20 bg-dark-surface/30">
              <button
                type="button"
                onClick={() => setActiveTab('orders')}
                className={`flex-1 px-4 py-3 text-sm font-medium transition-all duration-200 ${
                  activeTab === 'orders'
                    ? 'text-white border-b-2 border-purple-primary bg-dark-surface/50'
                    : 'text-purple-secondary hover:text-white hover:bg-dark-surface/30'
                }`}
              >
                Open Orders
                {pendingCount > 0 && (
                  <span className="ml-2 px-2 py-0.5 rounded-full bg-purple-primary/20 text-purple-primary text-xs">
                    {pendingCount}
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('history')}
                className={`flex-1 px-4 py-3 text-sm font-medium transition-all duration-200 ${
                  activeTab === 'history'
                    ? 'text-white border-b-2 border-purple-primary bg-dark-surface/50'
                    : 'text-purple-secondary hover:text-white hover:bg-dark-surface/30'
                }`}
              >
                History
                {(completedOrders.length > 0 || matches.length > 0) && (
                  <span className="ml-2 px-2 py-0.5 rounded-full bg-purple-primary/20 text-purple-primary text-xs">
                    {completedOrders.length + matches.length}
                  </span>
                )}
              </button>
            </div>

            {/* Content Area */}
            <div className="flex-1 overflow-y-auto p-4">
              {/* Open Orders Tab */}
              {activeTab === 'orders' && (
                <div className="space-y-3">
                  {ordersLoading && openOrders.length === 0 ? (
                    <div className="text-center text-purple-secondary/70 py-8">
                      Loading orders...
                    </div>
                  ) : ordersError ? (
                    <div className="text-center text-red-400 py-8">
                      <p className="mb-2">Failed to load orders</p>
                      <button
                        onClick={handleRefresh}
                        className="text-sm text-purple-primary hover:text-purple-glow underline"
                      >
                        Try again
                      </button>
                    </div>
                  ) : openOrders.length === 0 ? (
                    <div className="text-center text-purple-secondary/70 py-12">
                      <svg
                        className="w-16 h-16 mx-auto mb-4 text-purple-primary/30"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.5}
                          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                        />
                      </svg>
                      <p className="text-lg mb-2">No open orders</p>
                      <p className="text-sm text-purple-secondary/50">
                        Submit an order to get started
                      </p>
                    </div>
                  ) : (
                    openOrders.map((order) => (
                      <OrderCard key={order.id} order={order} />
                    ))
                  )}
                </div>
              )}

              {/* History Tab */}
              {activeTab === 'history' && (
                <div className="space-y-3">
                  {(matchesLoading || ordersLoading) && matches.length === 0 && completedOrders.length === 0 ? (
                    <div className="text-center text-purple-secondary/70 py-8">
                      Loading history...
                    </div>
                  ) : (matchesError || ordersError) ? (
                    <div className="text-center text-red-400 py-8">
                      <p className="mb-2">Failed to load history</p>
                      <button
                        onClick={handleRefresh}
                        className="text-sm text-purple-primary hover:text-purple-glow underline"
                      >
                        Try again
                      </button>
                    </div>
                  ) : matches.length === 0 && completedOrders.length === 0 ? (
                    <div className="text-center text-purple-secondary/70 py-12">
                      <svg
                        className="w-16 h-16 mx-auto mb-4 text-purple-primary/30"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.5}
                          d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                        />
                      </svg>
                      <p className="text-lg mb-2">No trade history yet</p>
                      <p className="text-sm text-purple-secondary/50">
                        Your completed trades will appear here
                      </p>
                    </div>
                  ) : (
                    <>
                      {/* Show matches first */}
                      {matches.length > 0 && (
                        <>
                          <div className="text-xs text-purple-secondary/70 font-semibold uppercase tracking-wider mb-2">
                            Matches
                          </div>
                          {matches.map((match) => (
                            <MatchCard key={match.id} match={match} userAddress={userAddress} />
                          ))}
                        </>
                      )}

                      {/* Then show completed orders */}
                      {completedOrders.length > 0 && (
                        <>
                          <div className="text-xs text-purple-secondary/70 font-semibold uppercase tracking-wider mb-2 mt-6">
                            Completed Orders
                          </div>
                          {completedOrders.map((order) => (
                            <OrderCard key={order.id} order={order} />
                          ))}
                        </>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );

  return createPortal(drawerContent, document.body);
}
