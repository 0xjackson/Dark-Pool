'use client';

import { createContext, useContext, useState, useCallback, useEffect, useRef, ReactNode } from 'react';
import { useAccount, useSignTypedData } from 'wagmi';
import { createSessionKey, activateSessionKey } from '@/services/api';
import { ApiError } from '@/utils/errors';

type SessionKeyStatus = 'idle' | 'creating' | 'signing' | 'activating' | 'active' | 'error';

interface SessionKeyContextValue {
  status: SessionKeyStatus;
  isActive: boolean;
  isLoading: boolean;
  error: string | null;
  expiresAt: string | null;
  retry: () => void;
}

const SessionKeyContext = createContext<SessionKeyContextValue | null>(null);

export function SessionKeyProvider({ children }: { children: ReactNode }) {
  const { address, isConnected } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();

  const [status, setStatus] = useState<SessionKeyStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const hasAttemptedRef = useRef(false);

  const isActive = status === 'active';
  const isLoading = status === 'creating' || status === 'signing' || status === 'activating';

  const initSessionKey = useCallback(async () => {
    if (!address) return;

    setError(null);
    setStatus('creating');

    try {
      const response = await createSessionKey(address);

      if (response.active) {
        setExpiresAt(response.expiresAt ?? null);
        setStatus('active');
        return;
      }

      if (!response.eip712 || !response.challengeRaw) {
        throw new Error('Server returned incomplete session key data');
      }

      setStatus('signing');

      const { EIP712Domain, ...types } = response.eip712.types as Record<string, unknown>;

      const signature = await signTypedDataAsync({
        domain: response.eip712.domain as any,
        types: types as any,
        primaryType: response.eip712.primaryType as string,
        message: response.eip712.message as any,
      });

      setStatus('activating');
      const activateResponse = await activateSessionKey(
        address,
        signature,
        response.challengeRaw,
      );

      setExpiresAt(activateResponse.expiresAt ?? null);
      setStatus('active');
    } catch (err: unknown) {
      setStatus('error');

      if (
        err instanceof Error &&
        (err.name === 'UserRejectedRequestError' ||
         err.message.includes('User rejected') ||
         err.message.includes('user rejected'))
      ) {
        setError('Signature rejected. Please try again to enable trading.');
        return;
      }

      if (err instanceof ApiError) {
        setError(err.message);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('An unexpected error occurred while setting up session key');
      }
    }
  }, [address, signTypedDataAsync]);

  const retry = useCallback(() => {
    hasAttemptedRef.current = false;
    initSessionKey();
  }, [initSessionKey]);

  // Auto-trigger when wallet connects
  useEffect(() => {
    if (isConnected && address && !hasAttemptedRef.current && status === 'idle') {
      hasAttemptedRef.current = true;
      initSessionKey();
    }
  }, [isConnected, address, status, initSessionKey]);

  // Reset on disconnect
  useEffect(() => {
    if (!isConnected) {
      setStatus('idle');
      setError(null);
      setExpiresAt(null);
      hasAttemptedRef.current = false;
    }
  }, [isConnected]);

  return (
    <SessionKeyContext.Provider value={{ status, isActive, isLoading, error, expiresAt, retry }}>
      {children}
    </SessionKeyContext.Provider>
  );
}

export function useSessionKey(): SessionKeyContextValue {
  const context = useContext(SessionKeyContext);
  if (!context) {
    throw new Error('useSessionKey must be used within a SessionKeyProvider');
  }
  return context;
}
