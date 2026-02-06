import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import { getWarlockClient, Match } from '../services/warlockClient';

interface Client {
  ws: WebSocket;
  channels: Set<string>;
  userAddress?: string;
}

/**
 * WebSocket server for real-time updates
 *
 * Channels:
 * - orderbook:<baseToken>-<quoteToken> - Order book updates
 * - orders:<userAddress> - User's order status updates
 * - matches:<userAddress> - Match notifications for user
 * - matches:all - All match notifications
 */
export class DarkPoolWebSocketServer {
  private wss: WebSocketServer;
  private clients: Map<WebSocket, Client> = new Map();
  private channels: Map<string, Set<WebSocket>> = new Map();

  constructor(server: Server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.setupWebSocketServer();
    this.subscribeToMatchStream();
  }

  private setupWebSocketServer() {
    this.wss.on('connection', (ws: WebSocket) => {
      console.log('WebSocket client connected');

      const client: Client = {
        ws,
        channels: new Set(),
      };

      this.clients.set(ws, client);

      // Handle messages from client
      ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleClientMessage(ws, message);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
          this.sendError(ws, 'Invalid message format');
        }
      });

      // Handle disconnection
      ws.on('close', () => {
        console.log('WebSocket client disconnected');
        this.handleDisconnect(ws);
      });

      // Handle errors
      ws.on('error', (error: Error) => {
        console.error('WebSocket error:', error);
        this.handleDisconnect(ws);
      });

      // Send welcome message
      this.send(ws, {
        type: 'connected',
        message: 'Connected to Dark Pool WebSocket',
        timestamp: new Date().toISOString(),
      });
    });

    console.log('WebSocket server started on /ws');
  }

  private handleClientMessage(ws: WebSocket, message: any) {
    const { type, payload } = message;

    switch (type) {
      case 'subscribe':
        this.handleSubscribe(ws, payload);
        break;

      case 'unsubscribe':
        this.handleUnsubscribe(ws, payload);
        break;

      case 'ping':
        this.send(ws, { type: 'pong', timestamp: new Date().toISOString() });
        break;

      default:
        this.sendError(ws, `Unknown message type: ${type}`);
    }
  }

  private handleSubscribe(ws: WebSocket, payload: any) {
    const { channel, userAddress } = payload;

    if (!channel) {
      this.sendError(ws, 'Channel is required for subscription');
      return;
    }

    const client = this.clients.get(ws);
    if (!client) return;

    // Store user address if provided
    if (userAddress) {
      client.userAddress = userAddress;
    }

    // Add client to channel
    if (!this.channels.has(channel)) {
      this.channels.set(channel, new Set());
    }

    this.channels.get(channel)!.add(ws);
    client.channels.add(channel);

    console.log(`Client subscribed to channel: ${channel}`);

    this.send(ws, {
      type: 'subscribed',
      channel,
      timestamp: new Date().toISOString(),
    });
  }

  private handleUnsubscribe(ws: WebSocket, payload: any) {
    const { channel } = payload;

    if (!channel) {
      this.sendError(ws, 'Channel is required for unsubscription');
      return;
    }

    const client = this.clients.get(ws);
    if (!client) return;

    // Remove client from channel
    const channelClients = this.channels.get(channel);
    if (channelClients) {
      channelClients.delete(ws);
      if (channelClients.size === 0) {
        this.channels.delete(channel);
      }
    }

    client.channels.delete(channel);

    console.log(`Client unsubscribed from channel: ${channel}`);

    this.send(ws, {
      type: 'unsubscribed',
      channel,
      timestamp: new Date().toISOString(),
    });
  }

  private handleDisconnect(ws: WebSocket) {
    const client = this.clients.get(ws);
    if (!client) return;

    // Remove client from all channels
    client.channels.forEach((channel) => {
      const channelClients = this.channels.get(channel);
      if (channelClients) {
        channelClients.delete(ws);
        if (channelClients.size === 0) {
          this.channels.delete(channel);
        }
      }
    });

    this.clients.delete(ws);
  }

  /**
   * Subscribe to Warlock match stream and broadcast to WebSocket clients
   */
  private subscribeToMatchStream() {
    const warlockClient = getWarlockClient();

    warlockClient.streamMatches();

    warlockClient.on('match', (match: Match) => {
      console.log('Received match from Warlock:', match.id);

      // Broadcast to matches:all channel
      this.broadcast('matches:all', {
        type: 'match',
        data: match,
        timestamp: new Date().toISOString(),
      });

      // Broadcast to buyer's channel
      if (match.buyer_address) {
        this.broadcast(`matches:${match.buyer_address}`, {
          type: 'match',
          data: match,
          role: 'buyer',
          timestamp: new Date().toISOString(),
        });

        this.broadcast(`orders:${match.buyer_address}`, {
          type: 'order_update',
          order_id: match.buy_order_id,
          status: 'matched',
          timestamp: new Date().toISOString(),
        });
      }

      // Broadcast to seller's channel
      if (match.seller_address) {
        this.broadcast(`matches:${match.seller_address}`, {
          type: 'match',
          data: match,
          role: 'seller',
          timestamp: new Date().toISOString(),
        });

        this.broadcast(`orders:${match.seller_address}`, {
          type: 'order_update',
          order_id: match.sell_order_id,
          status: 'matched',
          timestamp: new Date().toISOString(),
        });
      }

      // Broadcast to order book channel
      const orderbookChannel = `orderbook:${match.base_token}-${match.quote_token}`;
      this.broadcast(orderbookChannel, {
        type: 'orderbook_update',
        base_token: match.base_token,
        quote_token: match.quote_token,
        timestamp: new Date().toISOString(),
      });
    });

    warlockClient.on('error', (error: Error) => {
      console.error('Warlock match stream error:', error);
    });

    warlockClient.on('end', () => {
      console.log('Warlock match stream ended, reconnecting...');
      // Reconnect after delay
      setTimeout(() => this.subscribeToMatchStream(), 5000);
    });
  }

  /**
   * Broadcast message to all clients subscribed to a channel
   */
  public broadcast(channel: string, message: any) {
    const clients = this.channels.get(channel);
    if (!clients || clients.size === 0) {
      return;
    }

    const data = JSON.stringify(message);
    let sentCount = 0;

    clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
        sentCount++;
      }
    });

    if (sentCount > 0) {
      console.log(`Broadcast to ${channel}: ${sentCount} clients`);
    }
  }

  /**
   * Send message to a specific client
   */
  private send(ws: WebSocket, message: any) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * Send error message to client
   */
  private sendError(ws: WebSocket, error: string) {
    this.send(ws, {
      type: 'error',
      error,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Get server statistics
   */
  public getStats() {
    return {
      connectedClients: this.clients.size,
      activeChannels: this.channels.size,
      channels: Array.from(this.channels.entries()).map(([channel, clients]) => ({
        channel,
        subscribers: clients.size,
      })),
    };
  }

  /**
   * Shutdown the WebSocket server
   */
  public shutdown() {
    console.log('Shutting down WebSocket server...');

    // Close all client connections
    this.clients.forEach((client) => {
      client.ws.close(1000, 'Server shutting down');
    });

    this.wss.close(() => {
      console.log('WebSocket server closed');
    });

    // Stop Warlock match stream
    const warlockClient = getWarlockClient();
    warlockClient.stopStreamMatches();
  }
}

export default DarkPoolWebSocketServer;
