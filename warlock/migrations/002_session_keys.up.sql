-- Session Key Management
-- Stores session keys for Yellow Network authentication (users + engine)

CREATE TABLE session_keys (
    id SERIAL PRIMARY KEY,
    owner VARCHAR(42) NOT NULL,              -- user address OR 'warlock'
    address VARCHAR(42) NOT NULL,            -- session key address
    private_key TEXT NOT NULL,               -- raw private key (encrypt later)
    application VARCHAR(100) NOT NULL,       -- 'dark-pool' or 'clearnode'
    allowances JSONB DEFAULT '[]',
    status VARCHAR(20) DEFAULT 'PENDING'
      CHECK (status IN ('PENDING', 'ACTIVE', 'EXPIRED', 'REVOKED')),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(owner, application)               -- one key per owner+app
);

CREATE INDEX idx_session_keys_owner ON session_keys (owner, status);

-- Extra columns on existing matches table for settlement tracking
ALTER TABLE matches ADD COLUMN IF NOT EXISTS app_session_id VARCHAR(66);
ALTER TABLE matches ADD COLUMN IF NOT EXISTS settlement_error TEXT;
