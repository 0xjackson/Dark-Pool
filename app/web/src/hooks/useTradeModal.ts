import { useState, useCallback } from 'react';

interface UseTradeModalReturn {
  isOpen: boolean;
  openModal: () => void;
  closeModal: () => void;
}

export const useTradeModal = (): UseTradeModalReturn => {
  const [isOpen, setIsOpen] = useState(false);

  const openModal = useCallback(() => {
    setIsOpen(true);
  }, []);

  const closeModal = useCallback(() => {
    setIsOpen(false);
  }, []);

  return {
    isOpen,
    openModal,
    closeModal,
  };
};
