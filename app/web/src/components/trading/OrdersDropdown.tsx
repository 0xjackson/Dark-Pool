'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useUserOrders } from '@/hooks/useUserOrders';
import { useUserMatches } from '@/hooks/useUserMatches';
import { useSettlementUpdates } from '@/hooks/useSettlementUpdates';
import { OrderCard } from './OrderCard';
import { MatchCard } from './MatchCard';

interface OrdersDropdownProps {
  isOpen: boolean;
  onClose: () => void;
  userAddress?: string;
  onRefreshTrigger?: number;
}

type TabType = 'orders' | 'history';

export function OrdersDropdown({ isOpen, onClose, userAddress, onRefreshTrigger }: OrdersDropdownProps) {
  const [activeTab, setActiveTab] = useState<TabType>('orders');

  const {
    orders: allOrders,
    loading: ordersLoading,
    error: ordersError,
    refresh: refreshOrders,
  } = useUserOrders(userAddress, {
    autoRefresh: isOpen,
    refreshInterval: 10000,
  });

  const {
    matches,
    loading: matchesLoading,
    error: matchesError,
    refresh: refreshMatches,
  } = useUserMatches(userAddress, {
    autoRefresh: isOpen,
    refreshInterval: 10000,
  });

  const openOrders = useMemo(() => {
    return allOrders.filter(
      (order) => order.status === 'PENDING' || order.status === 'PARTIALLY_FILLED'
    );
  }, [allOrders]);

  const completedOrders = useMemo(() => {
    return allOrders.filter(
      (order) => order.status === 'FILLED' || order.status === 'CANCELLED' || order.status === 'EXPIRED'
    );
  }, [allOrders]);

  const pendingCount = openOrders.length;

  useSettlementUpdates(
    useCallback(() => { refreshOrders(); refreshMatches(); }, [refreshOrders, refreshMatches]),
    useCallback(() => { refreshOrders(); refreshMatches(); }, [refreshOrders, refreshMatches]),
  );

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
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  const handleRefresh = useCallback(() => {
    refreshOrders();
    refreshMatches();
  }, [refreshOrders, refreshMatches]);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          className="bg-dark-elevated/70 backdrop-blur-xl border border-purple-primary/20 rounded-xl w-[280px] mt-3 overflow-hidden shadow-lg"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 pt-3 pb-2">
            <h3 className="text-xs font-semibold text-purple-secondary uppercase tracking-wider">
              Orders
            </h3>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={handleRefresh}
                className="px-2 py-1 text-xs text-purple-secondary/60 hover:text-purple-secondary bg-dark-bg/30 hover:bg-dark-bg/50 border border-purple-primary/10 hover:border-purple-primary/20 rounded-md transition-all duration-200"
                disabled={ordersLoading || matchesLoading}
              >
                {ordersLoading || matchesLoading ? '...' : 'Refresh'}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="p-1 text-purple-secondary/50 hover:text-purple-secondary/80 bg-dark-bg/30 hover:bg-dark-bg/50 border border-purple-primary/10 hover:border-purple-primary/20 rounded-md transition-all duration-200"
                aria-label="Close orders"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex mx-3 mb-2 rounded-lg bg-dark-bg/40 backdrop-blur-sm border border-purple-primary/10 p-0.5">
            <button
              type="button"
              onClick={() => setActiveTab('orders')}
              className={`flex-1 px-2 py-1.5 text-xs font-medium rounded-md transition-all duration-200 ${
                activeTab === 'orders'
                  ? 'text-white bg-dark-elevated/80 backdrop-blur-xl border border-purple-primary/20 shadow-sm'
                  : 'text-purple-secondary/70 hover:text-purple-secondary border border-transparent'
              }`}
            >
              Open
              {pendingCount > 0 && (
                <span className="ml-1 px-1.5 py-0.5 rounded-full bg-purple-primary/15 text-purple-primary/80 text-[10px]">
                  {pendingCount}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('history')}
              className={`flex-1 px-2 py-1.5 text-xs font-medium rounded-md transition-all duration-200 ${
                activeTab === 'history'
                  ? 'text-white bg-dark-elevated/80 backdrop-blur-xl border border-purple-primary/20 shadow-sm'
                  : 'text-purple-secondary/70 hover:text-purple-secondary border border-transparent'
              }`}
            >
              History
              {(completedOrders.length > 0 || matches.length > 0) && (
                <span className="ml-1 px-1.5 py-0.5 rounded-full bg-purple-primary/15 text-purple-primary/80 text-[10px]">
                  {completedOrders.length + matches.length}
                </span>
              )}
            </button>
          </div>

          {/* Scrollable Content */}
          <div className="max-h-[320px] overflow-y-auto px-3 pb-3">
            {/* Open Orders Tab */}
            {activeTab === 'orders' && (
              <div className="space-y-2">
                {ordersLoading && openOrders.length === 0 ? (
                  <div className="text-center text-purple-secondary/70 text-xs py-6">
                    Loading orders...
                  </div>
                ) : ordersError ? (
                  <div className="text-center text-red-400 text-xs py-6">
                    <p className="mb-1">Failed to load orders</p>
                    <button
                      onClick={handleRefresh}
                      className="px-2 py-0.5 text-purple-secondary/60 hover:text-purple-secondary bg-dark-bg/30 hover:bg-dark-bg/50 border border-purple-primary/10 hover:border-purple-primary/20 rounded-md transition-all duration-200"
                    >
                      Try again
                    </button>
                  </div>
                ) : openOrders.length === 0 ? (
                  <div className="text-center text-purple-secondary/70 py-6">
                    <svg
                      className="w-8 h-8 mx-auto mb-2 text-purple-primary/30"
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
                    <p className="text-xs">No open orders</p>
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
              <div className="space-y-2">
                {(matchesLoading || ordersLoading) && matches.length === 0 && completedOrders.length === 0 ? (
                  <div className="text-center text-purple-secondary/70 text-xs py-6">
                    Loading history...
                  </div>
                ) : (matchesError || ordersError) ? (
                  <div className="text-center text-red-400 text-xs py-6">
                    <p className="mb-1">Failed to load history</p>
                    <button
                      onClick={handleRefresh}
                      className="px-2 py-0.5 text-purple-secondary/60 hover:text-purple-secondary bg-dark-bg/30 hover:bg-dark-bg/50 border border-purple-primary/10 hover:border-purple-primary/20 rounded-md transition-all duration-200"
                    >
                      Try again
                    </button>
                  </div>
                ) : matches.length === 0 && completedOrders.length === 0 ? (
                  <div className="text-center text-purple-secondary/70 py-6">
                    <svg
                      className="w-8 h-8 mx-auto mb-2 text-purple-primary/30"
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
                    <p className="text-xs">No trade history yet</p>
                  </div>
                ) : (
                  <>
                    {matches.length > 0 && (
                      <>
                        <div className="text-[10px] text-purple-secondary/70 font-semibold uppercase tracking-wider mb-1">
                          Matches
                        </div>
                        {matches.map((match) => (
                          <MatchCard key={match.id} match={match} userAddress={userAddress} />
                        ))}
                      </>
                    )}
                    {completedOrders.length > 0 && (
                      <>
                        <div className="text-[10px] text-purple-secondary/70 font-semibold uppercase tracking-wider mb-1 mt-3">
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
      )}
    </AnimatePresence>
  );
}
