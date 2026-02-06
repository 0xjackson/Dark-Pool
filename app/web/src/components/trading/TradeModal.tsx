'use client';

import { useState, useCallback } from 'react';
import { Modal } from '@/components/ui/Modal';
import { OrderForm } from './OrderForm';

interface TradeModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * TradeModal - Wrapper component for submitting trade orders
 *
 * Simple wrapper that combines:
 * - Modal component for the dialog/overlay
 * - OrderForm component for the form logic
 *
 * Features:
 * - Auto-closes modal 2-3 seconds after successful order submission
 * - Success feedback handled by OrderForm component
 * - Clean separation of concerns
 */
export function TradeModal({ isOpen, onClose }: TradeModalProps) {
  const [isClosing, setIsClosing] = useState(false);

  const handleSuccess = useCallback(() => {
    // Set closing state to prevent multiple triggers
    if (isClosing) return;
    setIsClosing(true);

    // Close modal after 2.5 seconds to allow user to see success message
    setTimeout(() => {
      onClose();
      setIsClosing(false);
    }, 2500);
  }, [isClosing, onClose]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Submit Order">
      <OrderForm onSuccess={handleSuccess} />
    </Modal>
  );
}
