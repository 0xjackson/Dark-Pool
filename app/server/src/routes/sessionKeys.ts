import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { Hex, Address, getAddress } from 'viem';
import { generateSessionKey } from '../utils/keygen';
import {
  authenticateUserWs,
  completeUserAuth,
  getUserWs,
  revokeSessionKey,
} from '../services/yellowConnection';

const router = Router();

let db: Pool;

export function setSessionKeysDatabase(pool: Pool) {
  db = pool;
}

/**
 * POST /api/session-key/create
 *
 * Frontend calls this when wallet connects. Either returns existing active key
 * or generates a new one and returns an EIP-712 challenge for the user to sign.
 */
router.post('/create', async (req: Request, res: Response) => {
  try {
    const { userAddress, allowances } = req.body;

    if (!userAddress) {
      return res.status(400).json({ error: 'userAddress is required' });
    }

    const addr = getAddress(userAddress as Address);

    // Check for existing active key
    const existing = await db.query(
      `SELECT address, expires_at FROM session_keys
       WHERE owner = $1 AND status = 'ACTIVE' AND expires_at > NOW()
       LIMIT 1`,
      [addr],
    );

    if (existing.rows.length > 0) {
      // Key is ACTIVE and registered with Yellow — all channel ops
      // route through engine WS, so no per-user WS needed.
      return res.json({
        active: true,
        sessionKeyAddress: existing.rows[0].address,
        expiresAt: existing.rows[0].expires_at,
      });
    }

    // Generate new session key
    const sk = generateSessionKey();
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60); // +30 days
    const expiresAtDate = new Date(Number(expiresAt) * 1000);
    const userAllowances = allowances || [
      { asset: 'usdc', amount: '10000' },
      { asset: 'eth', amount: '10' },
      { asset: 'usdt', amount: '10000' },
    ];

    // Open WS to Yellow and get challenge for user to sign
    const { challengeRaw, eip712 } = await authenticateUserWs(
      addr,
      sk.address,
      expiresAt,
      userAllowances,
    );

    // Store in DB as PENDING (include challengeRaw so /activate can use it)
    await db.query(
      `INSERT INTO session_keys (owner, address, private_key, application, allowances, status, expires_at)
       VALUES ($1, $2, $3, 'dark-pool', $4, 'PENDING', $5)
       ON CONFLICT (owner, application) DO UPDATE
       SET address = $2, private_key = $3, allowances = $4, status = 'PENDING', expires_at = $5`,
      [addr, sk.address, sk.privateKey, JSON.stringify(userAllowances), expiresAtDate.toISOString()],
    );

    return res.json({
      active: false,
      sessionKeyAddress: sk.address,
      challengeRaw,
      eip712,
    });
  } catch (error: any) {
    console.error('Error creating session key:', error);
    res.status(500).json({ error: 'Failed to create session key', message: error.message });
  }
});

/**
 * POST /api/session-key/activate
 *
 * Frontend calls this after the user signs the EIP-712 challenge.
 * Completes the auth_verify step on Yellow and activates the key.
 */
router.post('/activate', async (req: Request, res: Response) => {
  try {
    const { userAddress, signature, challengeRaw } = req.body;

    if (!userAddress || !signature || !challengeRaw) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['userAddress', 'signature', 'challengeRaw'],
      });
    }

    const addr = getAddress(userAddress as Address);

    // Find session key awaiting activation (PENDING for new, ACTIVE for re-auth after WS death)
    const keyRow = await db.query(
      `SELECT address FROM session_keys
       WHERE owner = $1 AND status IN ('PENDING', 'ACTIVE')
       LIMIT 1`,
      [addr],
    );

    if (keyRow.rows.length === 0) {
      return res.status(404).json({ error: 'No session key found for this user' });
    }

    const sessionKeyAddress = keyRow.rows[0].address;

    // Complete auth on Yellow
    await completeUserAuth(addr, signature as Hex, challengeRaw);

    // Ensure status is ACTIVE
    await db.query(
      `UPDATE session_keys SET status = 'ACTIVE'
       WHERE owner = $1 AND address = $2`,
      [addr, sessionKeyAddress],
    );

    const updated = await db.query(
      `SELECT expires_at FROM session_keys WHERE owner = $1 AND address = $2`,
      [addr, sessionKeyAddress],
    );

    return res.json({
      success: true,
      expiresAt: updated.rows[0]?.expires_at,
    });
  } catch (error: any) {
    console.error('Error activating session key:', error);
    res.status(500).json({ error: 'Failed to activate session key', message: error.message });
  }
});

/**
 * POST /api/session-key/revoke
 *
 * Revokes a user's session key on Yellow Network and marks it as REVOKED in DB.
 */
router.post('/revoke', async (req: Request, res: Response) => {
  try {
    const { userAddress } = req.body;

    if (!userAddress) {
      return res.status(400).json({ error: 'userAddress is required' });
    }

    const addr = getAddress(userAddress as Address);

    // Load key from DB
    const keyRow = await db.query(
      `SELECT address FROM session_keys
       WHERE owner = $1 AND status = 'ACTIVE'
       LIMIT 1`,
      [addr],
    );

    if (keyRow.rows.length === 0) {
      return res.status(404).json({ error: 'No active session key found for this user' });
    }

    const skAddress = keyRow.rows[0].address as Address;

    // Revoke on Yellow via engine WS
    await revokeSessionKey(skAddress);

    // Mark as REVOKED in DB
    await db.query(
      `UPDATE session_keys SET status = 'REVOKED' WHERE owner = $1 AND address = $2`,
      [addr, skAddress],
    );

    return res.json({ success: true });
  } catch (error: any) {
    console.error('Error revoking session key:', error);
    res.status(500).json({ error: 'Failed to revoke session key', message: error.message });
  }
});

export default router;
