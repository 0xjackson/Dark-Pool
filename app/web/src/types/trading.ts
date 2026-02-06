import type { OrderType } from './order';

export interface Token {
  address: string;
  symbol: string;
  decimals: number;
  name: string;
}

export interface TradingPair {
  id: string;
  baseToken: Token;
  quoteToken: Token;
}

export interface OrderFormData {
  tokenPair: TradingPair;
  orderType: OrderType;
  amount: string;
  price: string;
  slippage: number;
}
