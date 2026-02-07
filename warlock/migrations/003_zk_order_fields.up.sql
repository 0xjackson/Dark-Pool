-- Add on-chain order fields needed for ZK proof generation
ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_id VARCHAR(66);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sell_amount VARCHAR(78);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS min_buy_amount VARCHAR(78);

-- Settlement tracking columns referenced by settlement worker
ALTER TABLE matches ADD COLUMN IF NOT EXISTS settle_tx_hash VARCHAR(66);
ALTER TABLE matches ADD COLUMN IF NOT EXISTS settled_at TIMESTAMP WITH TIME ZONE;
