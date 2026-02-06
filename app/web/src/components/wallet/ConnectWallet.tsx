'use client';

import { useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import { useAccount } from 'wagmi';
import { useTradeModal } from '@/hooks/useTradeModal';
import { TradeModal } from '@/components/trading/TradeModal';
import { OrdersDrawer } from '@/components/trading/OrdersDrawer';
import { OrdersDrawerToggle } from '@/components/trading/OrdersDrawerToggle';
import { useUserOrders } from '@/hooks/useUserOrders';

/**
 * Hero section for center content
 *
 * Features:
 * - Tagline message
 * - Trade button
 * - Smooth entrance animation
 * - Orders drawer integration
 */
export function ConnectWallet() {
  const { isOpen, openModal, closeModal } = useTradeModal();
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const { address } = useAccount();

  // Fetch orders to show pending count on toggle button
  const { orders } = useUserOrders(address, {
    autoRefresh: true,
    refreshInterval: 10000,
  });

  // Count pending orders
  const pendingCount = useMemo(() => {
    return orders.filter(
      (order) => order.status === 'PENDING' || order.status === 'PARTIALLY_FILLED'
    ).length;
  }, [orders]);

  // Handle successful order submission
  const handleOrderSuccess = () => {
    // Trigger refresh in the drawer
    setRefreshTrigger((prev) => prev + 1);
  };

  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="text-center flex flex-col items-center gap-8"
      >
        <p className="text-5xl text-purple-secondary font-medium">
          Permissionless OTC peer-to-peer trading
        </p>
        <button
          type="button"
          onClick={openModal}
          className="px-10 py-4 bg-dark-elevated/80 backdrop-blur-xl border border-purple-primary/30 hover:border-purple-primary/50 text-purple-secondary hover:text-white text-lg font-semibold rounded-lg transition-all duration-200"
        >
          Trade
        </button>
        <TradeModal
          isOpen={isOpen}
          onClose={closeModal}
          onOrderSuccess={handleOrderSuccess}
        />
      </motion.div>

      {/* Orders Drawer Toggle (only show when wallet is connected) */}
      {address && (
        <OrdersDrawerToggle
          onClick={() => setIsDrawerOpen(true)}
          pendingCount={pendingCount}
        />
      )}

      {/* Orders Drawer */}
      <OrdersDrawer
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        userAddress={address}
        onRefreshTrigger={refreshTrigger}
      />
    </>
  );
}
