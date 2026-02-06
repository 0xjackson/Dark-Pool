'use client';

import { Modal } from '@/components/ui/Modal';
import { OrderForm } from './OrderForm';

interface TradeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOrderSuccess?: () => void;
}

/**
 * TradeModal - Wrapper component for submitting trade orders
 *
 * Simple wrapper that combines:
 * - Modal component for the dialog/overlay
 * - OrderForm component for the form logic
 *
 * Features:
 * - Success feedback handled by OrderForm component
 * - User manually closes modal via X button or backdrop click
 * - Triggers callback on successful order submission for external state updates
 */
export function TradeModal({ isOpen, onClose, onOrderSuccess }: TradeModalProps) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Submit Order">
      <OrderForm onSuccess={onOrderSuccess} />
    </Modal>
  );
}
