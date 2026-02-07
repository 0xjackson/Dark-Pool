-- Rollback session key management

ALTER TABLE matches DROP COLUMN IF EXISTS settlement_error;
ALTER TABLE matches DROP COLUMN IF EXISTS app_session_id;

DROP INDEX IF EXISTS idx_session_keys_owner;
DROP TABLE IF EXISTS session_keys;
