-- Dark Pool Order Matching System - Initial Schema
-- Creates tables for orders and matches with variance/slippage tolerance support

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Orders table - stores all order states
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- User and chain info
    user_address VARCHAR(42) NOT NULL,  -- Ethereum address (0x + 40 hex chars)
    chain_id INTEGER NOT NULL,

    -- Order details
    order_type VARCHAR(4) NOT NULL CHECK (order_type IN ('BUY', 'SELL')),
    base_token VARCHAR(42) NOT NULL,    -- Token being bought/sold
    quote_token VARCHAR(42) NOT NULL,   -- Token used for payment

    -- Quantities and prices (NUMERIC for full precision)
    quantity NUMERIC(36, 18) NOT NULL CHECK (quantity > 0),
    price NUMERIC(36, 18) NOT NULL CHECK (price > 0),

    -- Variance/slippage tolerance
    variance_bps INTEGER NOT NULL DEFAULT 0 CHECK (variance_bps >= 0 AND variance_bps <= 10000),  -- basis points: 100 = 1%
    min_price NUMERIC(36, 18) NOT NULL,  -- Computed: price * (1 - variance_bps/10000)
    max_price NUMERIC(36, 18) NOT NULL,  -- Computed: price * (1 + variance_bps/10000)

    -- Fill tracking
    filled_quantity NUMERIC(36, 18) NOT NULL DEFAULT 0,
    remaining_quantity NUMERIC(36, 18) NOT NULL,

    -- Commit-reveal pattern
    commitment_hash VARCHAR(66),        -- keccak256 hash (0x + 64 hex chars)
    commitment_tx VARCHAR(66),          -- Transaction hash
    revealed BOOLEAN NOT NULL DEFAULT false,

    -- Order status lifecycle: PENDING → COMMITTED → REVEALED → PARTIALLY_FILLED → FILLED → CANCELLED
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (
        status IN ('PENDING', 'COMMITTED', 'REVEALED', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED')
    ),

    -- Signature and data
    order_signature TEXT,               -- EIP-712 signature
    order_data JSONB,                   -- Full order details

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    committed_at TIMESTAMP WITH TIME ZONE,
    revealed_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Matches table - records trade executions
CREATE TABLE matches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Order references
    buy_order_id UUID NOT NULL REFERENCES orders(id),
    sell_order_id UUID NOT NULL REFERENCES orders(id),

    -- Token pair
    base_token VARCHAR(42) NOT NULL,
    quote_token VARCHAR(42) NOT NULL,

    -- Match details
    quantity NUMERIC(36, 18) NOT NULL CHECK (quantity > 0),
    price NUMERIC(36, 18) NOT NULL CHECK (price > 0),

    -- Settlement tracking
    settlement_status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (
        settlement_status IN ('PENDING', 'SETTLING', 'SETTLED', 'FAILED')
    ),
    yellow_session_id VARCHAR(255),     -- Yellow Network app session ID
    settlement_tx VARCHAR(66),          -- Settlement transaction hash

    -- Timestamps
    matched_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    settled_at TIMESTAMP WITH TIME ZONE,

    -- Prevent duplicate matches
    UNIQUE(buy_order_id, sell_order_id, matched_at)
);

-- Performance indexes for matching algorithm
-- Critical index for finding matching orders (price-time priority)
CREATE INDEX idx_orders_matching_buy ON orders (
    base_token, quote_token, status, max_price DESC, created_at ASC
) WHERE order_type = 'BUY' AND status IN ('REVEALED', 'PARTIALLY_FILLED');

CREATE INDEX idx_orders_matching_sell ON orders (
    base_token, quote_token, status, min_price ASC, created_at ASC
) WHERE order_type = 'SELL' AND status IN ('REVEALED', 'PARTIALLY_FILLED');

-- Index for user order lookups
CREATE INDEX idx_orders_user ON orders (user_address, created_at DESC);

-- Index for order book queries
CREATE INDEX idx_orders_book ON orders (base_token, quote_token, order_type, status, price);

-- Index for match history
CREATE INDEX idx_matches_orders ON matches (buy_order_id, sell_order_id);
CREATE INDEX idx_matches_timestamp ON matches (matched_at DESC);
CREATE INDEX idx_matches_settlement ON matches (settlement_status, matched_at);

-- Function to auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger to auto-update updated_at on orders
CREATE TRIGGER update_orders_updated_at BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- View for active order book (faster queries)
CREATE VIEW active_orders AS
SELECT
    id,
    user_address,
    order_type,
    base_token,
    quote_token,
    quantity,
    price,
    variance_bps,
    min_price,
    max_price,
    remaining_quantity,
    status,
    created_at
FROM orders
WHERE status IN ('REVEALED', 'PARTIALLY_FILLED')
ORDER BY
    CASE WHEN order_type = 'BUY' THEN price END DESC,
    CASE WHEN order_type = 'SELL' THEN price END ASC,
    created_at ASC;

-- View for match history with order details
CREATE VIEW match_details AS
SELECT
    m.id,
    m.quantity,
    m.price,
    m.base_token,
    m.quote_token,
    m.settlement_status,
    m.matched_at,
    m.settled_at,
    bo.user_address AS buyer_address,
    so.user_address AS seller_address,
    bo.price AS buy_price,
    so.price AS sell_price
FROM matches m
JOIN orders bo ON m.buy_order_id = bo.id
JOIN orders so ON m.sell_order_id = so.id;

COMMENT ON TABLE orders IS 'Stores all dark pool orders with variance/slippage tolerance';
COMMENT ON TABLE matches IS 'Records executed trades between buy and sell orders';
COMMENT ON COLUMN orders.variance_bps IS 'Slippage tolerance in basis points (100 = 1%, 10000 = 100%)';
COMMENT ON COLUMN orders.min_price IS 'Minimum acceptable price = price * (1 - variance_bps/10000)';
COMMENT ON COLUMN orders.max_price IS 'Maximum acceptable price = price * (1 + variance_bps/10000)';
