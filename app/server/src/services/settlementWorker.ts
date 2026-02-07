import { Pool } from 'pg';
import { Hex, Address } from 'viem';
import {
  getAssetSymbol,
  getEngineAddress,
  createAppSession,
  closeAppSession,
} from './yellowConnection';
import { generateSettlementProof } from './proofGenerator';
import { getEngineWalletClient, getPublicClient } from './engineWallet';
import DarkPoolWebSocketServer from '../websocket/server';

const POLL_INTERVAL = 2000;
const BATCH_SIZE = 10;

const ROUTER_ADDRESS = process.env.ROUTER_ADDRESS as Address | undefined;

const ROUTER_ABI = [
  'function proveAndSettle(bytes32 sellerOrderId, bytes32 buyerOrderId, uint256 sellerFillAmount, uint256 buyerFillAmount, uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c) external',
  'function markFullySettled(bytes32 orderId) external',
  'function commitments(bytes32) view returns (address user, bytes32 orderHash, uint256 timestamp, uint256 settledAmount, uint8 status)',
] as const;

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

  // STEP 3: Load full order details for ZK proof generation
  const sellerOrder = await loadOrderDetails(match.sell_order_id);
  const buyerOrder = await loadOrderDetails(match.buy_order_id);

  // STEP 4: Generate ZK proof
  console.log(`Match ${match.id}: generating ZK proof...`);
  const proof = await generateSettlementProof(
    {
      orderId: sellerOrder.order_id,
      user: sellerOrder.user_address,
      sellToken: sellerOrder.base_token,
      buyToken: sellerOrder.quote_token,
      sellAmount: sellerOrder.sell_amount,
      minBuyAmount: sellerOrder.min_buy_amount,
      expiresAt: Math.floor(new Date(sellerOrder.expires_at).getTime() / 1000),
    },
    {
      orderId: buyerOrder.order_id,
      user: buyerOrder.user_address,
      sellToken: buyerOrder.base_token,
      buyToken: buyerOrder.quote_token,
      sellAmount: buyerOrder.sell_amount,
      minBuyAmount: buyerOrder.min_buy_amount,
      expiresAt: Math.floor(new Date(buyerOrder.expires_at).getTime() / 1000),
    },
    sellerOrder.commitment_hash,
    buyerOrder.commitment_hash,
    match.quantity,      // sellerFillAmount
    quoteAmount,         // buyerFillAmount
    '0',                 // sellerSettledSoFar (TODO: read from on-chain or track in DB)
    '0',                 // buyerSettledSoFar
    Math.floor(Date.now() / 1000),
  );
  console.log(`Match ${match.id}: ZK proof generated`);

  // STEP 5: Call proveAndSettle on-chain
  if (ROUTER_ADDRESS) {
    const walletClient = getEngineWalletClient();
    const publicClient = getPublicClient();

    const txHash = await walletClient.writeContract({
      address: ROUTER_ADDRESS,
      abi: ROUTER_ABI,
      functionName: 'proveAndSettle',
      args: [
        sellerOrder.order_id as Hex,
        buyerOrder.order_id as Hex,
        BigInt(match.quantity),
        BigInt(quoteAmount),
        proof.a.map(BigInt) as [bigint, bigint],
        proof.b.map((row: string[]) => row.map(BigInt)) as [[bigint, bigint], [bigint, bigint]],
        proof.c.map(BigInt) as [bigint, bigint],
      ],
    });

    await publicClient.waitForTransactionReceipt({ hash: txHash });

    // Store tx hash
    await db.query(
      `UPDATE matches SET settle_tx_hash = $2 WHERE id = $1`,
      [match.id, txHash],
    );

    console.log(`Match ${match.id}: proveAndSettle tx ${txHash}`);
  } else {
    console.warn(`Match ${match.id}: ROUTER_ADDRESS not set, skipping on-chain settlement`);
  }

  // STEP 6: Create app session on Yellow
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

  // STEP 7: Close app session (THE SWAP — redistribute funds)
  await closeAppSession(appSessionId as Hex, [
    { participant: seller, asset: quoteSymbol, amount: quoteAmount }, // seller GETS quote
    { participant: buyer, asset: baseSymbol, amount: match.quantity }, // buyer GETS base
    { participant: engineAddress, asset: baseSymbol, amount: '0' },
    { participant: engineAddress, asset: quoteSymbol, amount: '0' },
  ]);

  // STEP 8: Check if orders fully filled → call markFullySettled
  if (ROUTER_ADDRESS) {
    const walletClient = getEngineWalletClient();

    const sellerRemaining = await db.query(
      `SELECT remaining_quantity FROM orders WHERE id = $1`,
      [match.sell_order_id],
    );
    if (sellerRemaining.rows[0]?.remaining_quantity === '0') {
      await walletClient.writeContract({
        address: ROUTER_ADDRESS,
        abi: ROUTER_ABI,
        functionName: 'markFullySettled',
        args: [sellerOrder.order_id as Hex],
      });
      console.log(`Match ${match.id}: seller order marked fully settled`);
    }

    const buyerRemaining = await db.query(
      `SELECT remaining_quantity FROM orders WHERE id = $1`,
      [match.buy_order_id],
    );
    if (buyerRemaining.rows[0]?.remaining_quantity === '0') {
      await walletClient.writeContract({
        address: ROUTER_ADDRESS,
        abi: ROUTER_ABI,
        functionName: 'markFullySettled',
        args: [buyerOrder.order_id as Hex],
      });
      console.log(`Match ${match.id}: buyer order marked fully settled`);
    }
  }

  await db.query(
    `UPDATE matches SET settlement_status = 'SETTLED', settled_at = NOW()
     WHERE id = $1`,
    [match.id],
  );

  console.log(`Match ${match.id}: SETTLED`);

  // STEP 9: Notify via WebSocket
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

async function loadOrderDetails(orderId: string) {
  const result = await db.query(
    `SELECT id, user_address, base_token, quote_token,
            order_id, sell_amount, min_buy_amount, commitment_hash,
            quantity, price, expires_at
     FROM orders WHERE id = $1`,
    [orderId],
  );
  if (result.rows.length === 0) throw new Error(`Order not found: ${orderId}`);
  return result.rows[0];
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
