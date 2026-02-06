export type OrderType = 'BUY' | 'SELL';

export type OrderStatus =
  | 'PENDING'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELLED'
  | 'EXPIRED';

export interface OrderRequest {
  user_address: string;
  chain_id: number;
  order_type: OrderType;
  base_token: string;
  quote_token: string;
  quantity: string;
  price: string;
  variance_bps: number;
}

export interface Order {
  id: string;
  user_address: string;
  chain_id: number;
  order_type: OrderType;
  base_token: string;
  quote_token: string;
  quantity: string;
  price: string;
  variance_bps: number;
  status: OrderStatus;
  filled_quantity: string;
  remaining_quantity: string;
  created_at: string;
  updated_at: string;
}

export interface OrderResponse {
  success: boolean;
  order: Order;
  immediate_matches: any[];
}

export type SettlementStatus = 'PENDING' | 'SETTLED';

export interface Match {
  id: string;
  buy_order_id: string;
  sell_order_id: string;
  base_token: string;
  quote_token: string;
  quantity: string;
  price: string;
  settlement_status: SettlementStatus;
  matched_at: string;
  settled_at: string | null;
  buyer_address?: string;
  seller_address?: string;
}
