import { Pool } from 'pg';
import { Hex, Address } from 'viem';
import {
  getAssetSymbol,
  getEngineAddress,
  createAppSession,
  closeAppSession,
} from './yellowConnection';
import DarkPoolWebSocketServer from '../websocket/server';

const POLL_INTERVAL = 2000;
const BATCH_SIZE = 10;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let db: Pool;
let wsServer: DarkPoolWebSocketServer | null = null;

export function startSettlementWorker(pool: Pool, ws?: DarkPoolWebSocketServer): void {
  db = pool;
  wsServer = ws || null;

  console.log('Settlement worker started (polling every 2s)');
  pollTimer = setInterval(() => {
    pollAndSettle().catch((err) => console.error('Settlement worker error:', err));
  }, POLL_INTERVAL);
}

export function stopSettlementWorker(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log('Settlement worker stopped');
  }
}

async function pollAndSettle(): Promise<void> {
  // Fetch pending matches
  const result = await db.query(
    `SELECT m.id, m.buy_order_id, m.sell_order_id, m.base_token, m.quote_token,
            m.quantity, m.price,
            bo.user_address AS buyer_address,
            so.user_address AS seller_address
     FROM matches m
     JOIN orders bo ON m.buy_order_id = bo.id
     JOIN orders so ON m.sell_order_id = so.id
     WHERE m.settlement_status = 'PENDING'
     ORDER BY m.matched_at
     LIMIT $1`,
    [BATCH_SIZE],
  );

  for (const match of result.rows) {
    try {
      await settleMatch(match);
    } catch (err: any) {
      console.error(`Settlement failed for match ${match.id}:`, err.message);
      await db.query(
        `UPDATE matches SET settlement_status = 'FAILED', settlement_error = $2
         WHERE id = $1`,
        [match.id, err.message],
      );
    }
  }
}

async function settleMatch(match: any): Promise<void> {
  // STEP 0: Claim atomically
  const claim = await db.query(
    `UPDATE matches SET settlement_status = 'SETTLING'
     WHERE id = $1 AND settlement_status = 'PENDING'
     RETURNING *`,
    [match.id],
  );

  if (claim.rows.length === 0) return; // already claimed by another worker

  // STEP 1: Load all 3 session keys
  const buyerKey = await loadSessionKey(match.buyer_address);
  const sellerKey = await loadSessionKey(match.seller_address);
  const engineKey = await loadSessionKey('warlock');

  if (!buyerKey) throw new Error(`Missing session key for buyer ${match.buyer_address}`);
  if (!sellerKey) throw new Error(`Missing session key for seller ${match.seller_address}`);
  if (!engineKey) throw new Error('Missing warlock session key');

  // STEP 2: Resolve symbols
  const baseSymbol = getAssetSymbol(match.base_token);
  const quoteSymbol = getAssetSymbol(match.quote_token);

  if (!baseSymbol) throw new Error(`Unknown base token: ${match.base_token}`);
  if (!quoteSymbol) throw new Error(`Unknown quote token: ${match.quote_token}`);

  // Calculate quote amount: quantity * price (string math to avoid float issues)
  const quoteAmount = stringMultiply(match.quantity, match.price);

  const engineAddress = getEngineAddress();
  const seller = match.seller_address as Address;
  const buyer = match.buyer_address as Address;

  // STEP 3: Create app session on Yellow
  const appSessionId = await createAppSession(
    sellerKey.private_key as Hex,
    buyerKey.private_key as Hex,
    [seller, buyer, engineAddress],
    [
      { participant: seller, asset: baseSymbol, amount: match.quantity },
      { participant: buyer, asset: quoteSymbol, amount: quoteAmount },
      { participant: engineAddress, asset: baseSymbol, amount: '0' },
      { participant: engineAddress, asset: quoteSymbol, amount: '0' },
    ],
  );

  await db.query(
    `UPDATE matches SET app_session_id = $2 WHERE id = $1`,
    [match.id, appSessionId],
  );

  console.log(`Match ${match.id}: app session created ${appSessionId}`);

  // STEP 4: Close app session (THE SWAP — redistribute funds)
  await closeAppSession(appSessionId as Hex, [
    { participant: seller, asset: quoteSymbol, amount: quoteAmount }, // seller GETS quote
    { participant: buyer, asset: baseSymbol, amount: match.quantity }, // buyer GETS base
    { participant: engineAddress, asset: baseSymbol, amount: '0' },
    { participant: engineAddress, asset: quoteSymbol, amount: '0' },
  ]);

  await db.query(
    `UPDATE matches SET settlement_status = 'SETTLED', settled_at = NOW()
     WHERE id = $1`,
    [match.id],
  );

  console.log(`Match ${match.id}: SETTLED`);

  // STEP 5: Notify via WebSocket
  if (wsServer) {
    const notification = {
      type: 'settlement',
      data: { matchId: match.id, status: 'SETTLED' },
      timestamp: new Date().toISOString(),
    };
    wsServer.broadcast(`matches:${match.buyer_address}`, notification);
    wsServer.broadcast(`matches:${match.seller_address}`, notification);
  }
}

async function loadSessionKey(owner: string): Promise<{ address: string; private_key: string } | null> {
  const result = await db.query(
    `SELECT address, private_key FROM session_keys
     WHERE owner = $1 AND status = 'ACTIVE' AND expires_at > NOW()
     LIMIT 1`,
    [owner],
  );
  return result.rows[0] || null;
}

/**
 * Multiply two decimal strings without floating point errors.
 * Returns a decimal string.
 */
function stringMultiply(a: string, b: string): string {
  const decA = (a.split('.')[1] || '').length;
  const decB = (b.split('.')[1] || '').length;
  const totalDecimals = decA + decB;

  const intA = BigInt(a.replace('.', ''));
  const intB = BigInt(b.replace('.', ''));
  const product = intA * intB;

  const productStr = product.toString();
  if (totalDecimals === 0) return productStr;

  const padded = productStr.padStart(totalDecimals + 1, '0');
  const intPart = padded.slice(0, padded.length - totalDecimals);
  const decPart = padded.slice(padded.length - totalDecimals).replace(/0+$/, '');

  return decPart ? `${intPart}.${decPart}` : intPart;
}
