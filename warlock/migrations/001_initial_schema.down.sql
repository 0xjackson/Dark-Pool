-- Rollback script for initial schema

DROP VIEW IF EXISTS match_details;
DROP VIEW IF EXISTS active_orders;

DROP TRIGGER IF EXISTS update_orders_updated_at ON orders;
DROP FUNCTION IF EXISTS update_updated_at_column();

DROP INDEX IF EXISTS idx_matches_settlement;
DROP INDEX IF EXISTS idx_matches_timestamp;
DROP INDEX IF EXISTS idx_matches_orders;
DROP INDEX IF EXISTS idx_orders_book;
DROP INDEX IF EXISTS idx_orders_user;
DROP INDEX IF EXISTS idx_orders_matching_sell;
DROP INDEX IF EXISTS idx_orders_matching_buy;

DROP TABLE IF EXISTS matches;
DROP TABLE IF EXISTS orders;

DROP EXTENSION IF EXISTS "uuid-ossp";
