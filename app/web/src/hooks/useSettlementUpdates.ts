'use client';

import { useEffect, useCallback, useRef } from 'react';
import { useAccount } from 'wagmi';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:3001/ws';

interface SettlementEvent {
  type: 'settlement';
  data: {
    matchId: string;
    status: 'SETTLED' | 'FAILED';
  };
  timestamp: string;
}

interface MatchEvent {
  type: 'match';
  data: Record<string, unknown>;
  role: 'buyer' | 'seller';
  timestamp: string;
}

type WSMessage = SettlementEvent | MatchEvent | { type: string };

/**
 * Hook that listens for real-time settlement and match updates via WebSocket.
 * Subscribes to matches:<address> channel using the backend WS protocol.
 *
 * Calls onSettlement when a match settles or fails.
 * Calls onMatch when a new match is created.
 */
export function useSettlementUpdates(
  onSettlement?: (event: SettlementEvent) => void,
  onMatch?: (event: MatchEvent) => void,
) {
  const { address } = useAccount();
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    if (!address) return;

    // Avoid duplicate connections
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      // Subscribe using the server's expected protocol: { type, payload: { channel, userAddress } }
      ws.send(JSON.stringify({
        type: 'subscribe',
        payload: {
          channel: `matches:${address}`,
          userAddress: address,
        },
      }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as WSMessage;
        if (msg.type === 'settlement' && onSettlement) {
          onSettlement(msg as SettlementEvent);
        } else if (msg.type === 'match' && onMatch) {
          onMatch(msg as MatchEvent);
        }
      } catch {
        // ignore non-JSON messages
      }
    };

    ws.onclose = () => {
      wsRef.current = null;
      // Reconnect after 5 seconds
      reconnectTimerRef.current = setTimeout(connect, 5000);
    };

    ws.onerror = () => {
      // onclose will fire after this, triggering reconnect
    };

    wsRef.current = ws;
  }, [address, onSettlement, onMatch]);

  useEffect(() => {
    connect();
    return () => {
      reconnectTimerRef.current && clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connect]);
}
