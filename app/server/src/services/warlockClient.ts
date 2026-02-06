import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import { EventEmitter } from 'events';

// gRPC client configuration
const PROTO_PATH = path.join(__dirname, '../proto/warlock.proto');
const WARLOCK_URL = process.env.WARLOCK_GRPC_URL || 'localhost:50051';

// Load proto definition
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});

const warlockProto = grpc.loadPackageDefinition(packageDefinition) as any;

// Type definitions
export interface Order {
  id: string;
  user_address: string;
  chain_id: number;
  order_type: 'BUY' | 'SELL';
  base_token: string;
  quote_token: string;
  quantity: string;
  price: string;
  variance_bps: number;
  min_price: string;
  max_price: string;
  filled_quantity: string;
  remaining_quantity: string;
  status: string;
  created_at?: Date;
  expires_at?: Date;
}

export interface Match {
  id: string;
  buy_order_id: string;
  sell_order_id: string;
  base_token: string;
  quote_token: string;
  quantity: string;
  price: string;
  settlement_status: string;
  yellow_session_id?: string;
  matched_at?: Date;
  settled_at?: Date;
  buyer_address: string;
  seller_address: string;
}

export interface SubmitOrderRequest {
  user_address: string;
  chain_id: number;
  order_type: 'BUY' | 'SELL';
  base_token: string;
  quote_token: string;
  quantity: string;
  price: string;
  variance_bps: number;
  expires_in_seconds?: number;
  commitment_hash?: string;
  order_signature?: string;
  order_data?: string;
}

export interface PriceLevel {
  price: string;
  quantity: string;
  order_count: number;
}

export interface OrderBook {
  base_token: string;
  quote_token: string;
  bids: PriceLevel[];
  asks: PriceLevel[];
  timestamp: Date;
}

/**
 * WarlockClient - gRPC client wrapper for Warlock matching engine
 */
export class WarlockClient extends EventEmitter {
  private client: any;
  private matchStream: any = null;

  constructor() {
    super();
    this.client = new warlockProto.warlock.v1.MatcherService(
      WARLOCK_URL,
      grpc.credentials.createInsecure()
    );
  }

  /**
   * Submit a new order to the matching engine
   */
  async submitOrder(request: SubmitOrderRequest): Promise<{ order: Order; immediate_matches: Match[] }> {
    return new Promise((resolve, reject) => {
      const grpcRequest = {
        user_address: request.user_address,
        chain_id: request.chain_id,
        order_type: request.order_type === 'BUY' ? 1 : 2,
        base_token: request.base_token,
        quote_token: request.quote_token,
        quantity: request.quantity,
        price: request.price,
        variance_bps: request.variance_bps,
        expires_in_seconds: request.expires_in_seconds || 0,
        commitment_hash: request.commitment_hash || '',
        order_signature: request.order_signature || '',
        order_data: request.order_data || '',
      };

      this.client.SubmitOrder(grpcRequest, (error: any, response: any) => {
        if (error) {
          console.error('gRPC SubmitOrder error:', error);
          reject(error);
          return;
        }

        resolve({
          order: this.convertOrder(response.order),
          immediate_matches: (response.immediate_matches || []).map(this.convertMatch),
        });
      });
    });
  }

  /**
   * Cancel an order
   */
  async cancelOrder(orderId: string, userAddress: string): Promise<{ success: boolean; message: string }> {
    return new Promise((resolve, reject) => {
      this.client.CancelOrder(
        { order_id: orderId, user_address: userAddress },
        (error: any, response: any) => {
          if (error) {
            console.error('gRPC CancelOrder error:', error);
            reject(error);
            return;
          }

          resolve({
            success: response.success,
            message: response.message,
          });
        }
      );
    });
  }

  /**
   * Get order book for a token pair
   */
  async getOrderBook(baseToken: string, quoteToken: string, depth: number = 20): Promise<OrderBook> {
    return new Promise((resolve, reject) => {
      this.client.GetOrderBook(
        { base_token: baseToken, quote_token: quoteToken, depth },
        (error: any, response: any) => {
          if (error) {
            console.error('gRPC GetOrderBook error:', error);
            reject(error);
            return;
          }

          resolve({
            base_token: response.base_token,
            quote_token: response.quote_token,
            bids: response.bids || [],
            asks: response.asks || [],
            timestamp: new Date(response.timestamp?.seconds * 1000 || Date.now()),
          });
        }
      );
    });
  }

  /**
   * Stream matches in real-time
   */
  streamMatches(filters?: { baseToken?: string; quoteToken?: string; userAddress?: string }) {
    if (this.matchStream) {
      console.warn('Match stream already active');
      return;
    }

    const request = {
      base_token: filters?.baseToken || '',
      quote_token: filters?.quoteToken || '',
      user_address: filters?.userAddress || '',
    };

    this.matchStream = this.client.StreamMatches(request);

    this.matchStream.on('data', (event: any) => {
      const match = this.convertMatch(event.match);
      this.emit('match', match);
    });

    this.matchStream.on('error', (error: any) => {
      console.error('Match stream error:', error);
      this.emit('error', error);
      this.matchStream = null;
    });

    this.matchStream.on('end', () => {
      console.log('Match stream ended');
      this.emit('end');
      this.matchStream = null;
    });

    console.log('Match stream started');
  }

  /**
   * Stop streaming matches
   */
  stopStreamMatches() {
    if (this.matchStream) {
      this.matchStream.cancel();
      this.matchStream = null;
      console.log('Match stream stopped');
    }
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<{
    healthy: boolean;
    version: string;
    uptime_seconds: number;
    total_orders: number;
    total_matches: number;
  }> {
    return new Promise((resolve, reject) => {
      this.client.HealthCheck({}, (error: any, response: any) => {
        if (error) {
          console.error('gRPC HealthCheck error:', error);
          reject(error);
          return;
        }

        resolve({
          healthy: response.healthy,
          version: response.version,
          uptime_seconds: parseInt(response.uptime_seconds),
          total_orders: parseInt(response.total_orders),
          total_matches: parseInt(response.total_matches),
        });
      });
    });
  }

  /**
   * Close the client
   */
  close() {
    this.stopStreamMatches();
    if (this.client) {
      grpc.closeClient(this.client);
    }
  }

  // Helper methods

  private convertOrder(protoOrder: any): Order {
    if (!protoOrder) return {} as Order;

    return {
      id: protoOrder.id,
      user_address: protoOrder.user_address,
      chain_id: protoOrder.chain_id,
      order_type: protoOrder.order_type === 1 || protoOrder.order_type === 'ORDER_TYPE_BUY' ? 'BUY' : 'SELL',
      base_token: protoOrder.base_token,
      quote_token: protoOrder.quote_token,
      quantity: protoOrder.quantity,
      price: protoOrder.price,
      variance_bps: protoOrder.variance_bps,
      min_price: protoOrder.min_price,
      max_price: protoOrder.max_price,
      filled_quantity: protoOrder.filled_quantity,
      remaining_quantity: protoOrder.remaining_quantity,
      status: this.convertOrderStatus(protoOrder.status),
      created_at: protoOrder.created_at ? new Date(protoOrder.created_at.seconds * 1000) : undefined,
      expires_at: protoOrder.expires_at ? new Date(protoOrder.expires_at.seconds * 1000) : undefined,
    };
  }

  private convertMatch(protoMatch: any): Match {
    if (!protoMatch) return {} as Match;

    return {
      id: protoMatch.id,
      buy_order_id: protoMatch.buy_order_id,
      sell_order_id: protoMatch.sell_order_id,
      base_token: protoMatch.base_token,
      quote_token: protoMatch.quote_token,
      quantity: protoMatch.quantity,
      price: protoMatch.price,
      settlement_status: this.convertSettlementStatus(protoMatch.settlement_status),
      yellow_session_id: protoMatch.yellow_session_id,
      matched_at: protoMatch.matched_at ? new Date(protoMatch.matched_at.seconds * 1000) : undefined,
      settled_at: protoMatch.settled_at ? new Date(protoMatch.settled_at.seconds * 1000) : undefined,
      buyer_address: protoMatch.buyer_address,
      seller_address: protoMatch.seller_address,
    };
  }

  private convertOrderStatus(status: number | string): string {
    // Handle both numeric and string enum values
    if (typeof status === 'string') {
      // Extract status name from ORDER_STATUS_XXX format
      const match = status.match(/ORDER_STATUS_(.+)/);
      return match ? match[1] : status;
    }

    const statuses = [
      'UNSPECIFIED',
      'PENDING',
      'COMMITTED',
      'REVEALED',
      'PARTIALLY_FILLED',
      'FILLED',
      'CANCELLED',
    ];
    return statuses[status] || 'UNSPECIFIED';
  }

  private convertSettlementStatus(status: number): string {
    const statuses = ['UNSPECIFIED', 'PENDING', 'SETTLING', 'SETTLED', 'FAILED'];
    return statuses[status] || 'UNSPECIFIED';
  }
}

// Singleton instance
let warlockClient: WarlockClient | null = null;

export function getWarlockClient(): WarlockClient {
  if (!warlockClient) {
    warlockClient = new WarlockClient();
  }
  return warlockClient;
}

export default WarlockClient;
