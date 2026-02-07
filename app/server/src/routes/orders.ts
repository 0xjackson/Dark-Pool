import { Router, Request, Response } from 'express';
import { getWarlockClient } from '../services/warlockClient';
import { verifyCommitment } from '../services/commitmentVerifier';
import { Pool } from 'pg';
import { getAddress, Address } from 'viem';

const router = Router();

// Get database pool from app context
let db: Pool;

export function setDatabase(pool: Pool) {
  db = pool;
}

/**
 * POST /api/orders - Create and submit a new order
 *
 * The user must have already called depositAndCommit() on-chain.
 * This endpoint verifies the on-chain commitment hash matches the
 * submitted order details before forwarding to the matching engine.
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const {
      user_address,
      chain_id,
      order_type,
      base_token,
      quote_token,
      quantity,
      price,
      variance_bps,
      order_id,
      commitment_hash,
      expires_at,
      min_buy_amount,
      sell_amount,
    } = req.body;

    // Validate required fields
    if (
      !user_address ||
      !chain_id ||
      !order_type ||
      !base_token ||
      !quote_token ||
      !quantity ||
      !price ||
      !order_id ||
      !commitment_hash ||
      !expires_at ||
      !min_buy_amount ||
      !sell_amount
    ) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: [
          'user_address', 'chain_id', 'order_type', 'base_token', 'quote_token',
          'quantity', 'price', 'order_id', 'commitment_hash', 'expires_at',
          'min_buy_amount', 'sell_amount',
        ],
      });
    }

    // Checksum the user address
    const checksummedAddress = getAddress(user_address as Address);

    // Validate order type
    if (order_type !== 'BUY' && order_type !== 'SELL') {
      return res.status(400).json({
        error: 'Invalid order_type. Must be BUY or SELL',
      });
    }

    // Validate variance_bps
    const varianceBps = variance_bps || 0;
    if (varianceBps < 0 || varianceBps > 10000) {
      return res.status(400).json({
        error: 'variance_bps must be between 0 and 10000 (0% to 100%)',
      });
    }

    // Verify on-chain commitment matches submitted details
    const verificationError = await verifyCommitment(
      order_id,
      checksummedAddress,
      order_type,
      base_token,
      quote_token,
      sell_amount,
      min_buy_amount,
      expires_at
    );

    if (verificationError) {
      return res.status(403).json({
        error: 'Commitment verification failed',
        message: verificationError,
      });
    }

    // Submit order to Warlock matching engine
    const warlockClient = getWarlockClient();
    const result = await warlockClient.submitOrder({
      user_address: checksummedAddress,
      chain_id,
      order_type,
      base_token,
      quote_token,
      quantity,
      price,
      variance_bps: varianceBps,
      commitment_hash,
      order_id,
      sell_amount,
      min_buy_amount,
    });

    res.status(201).json({
      success: true,
      order: result.order,
      immediate_matches: result.immediate_matches,
    });
  } catch (error: any) {
    console.error('Error creating order:', error);
    res.status(500).json({
      error: 'Failed to create order',
      message: error.message,
    });
  }
});

/**
 * GET /api/orders/user/:address - Get all orders for a user
 */
router.get('/user/:address', async (req: Request, res: Response) => {
  try {
    const address = getAddress(req.params.address as Address);
    const { status, limit = 50, offset = 0 } = req.query;

    let query = `
      SELECT
        id, user_address, chain_id, order_type, base_token, quote_token,
        quantity, price, variance_bps, min_price, max_price,
        filled_quantity, remaining_quantity, status,
        created_at, updated_at, expires_at
      FROM orders
      WHERE user_address = $1
    `;

    const params: any[] = [address];

    if (status) {
      query += ` AND status = $${params.length + 1}`;
      params.push(status);
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await db.query(query, params);

    res.json({
      orders: result.rows,
      total: result.rowCount,
      limit: parseInt(limit as string),
      offset: parseInt(offset as string),
    });
  } catch (error: any) {
    console.error('Error fetching user orders:', error);
    res.status(500).json({
      error: 'Failed to fetch orders',
      message: error.message,
    });
  }
});

/**
 * GET /api/matches/user/:address - Get matches for a user
 */
router.get('/matches/user/:address', async (req: Request, res: Response) => {
  try {
    const address = getAddress(req.params.address as Address);
    const { limit = 50, offset = 0 } = req.query;

    const result = await db.query(
      `SELECT
        m.id, m.buy_order_id, m.sell_order_id, m.base_token, m.quote_token,
        m.quantity, m.price, m.settlement_status, m.yellow_session_id,
        m.matched_at, m.settled_at,
        bo.user_address as buyer_address,
        so.user_address as seller_address
      FROM matches m
      JOIN orders bo ON m.buy_order_id = bo.id
      JOIN orders so ON m.sell_order_id = so.id
      WHERE bo.user_address = $1 OR so.user_address = $1
      ORDER BY m.matched_at DESC
      LIMIT $2 OFFSET $3`,
      [address, limit, offset]
    );

    res.json({
      matches: result.rows,
      total: result.rowCount,
      limit: parseInt(limit as string),
      offset: parseInt(offset as string),
    });
  } catch (error: any) {
    console.error('Error fetching matches:', error);
    res.status(500).json({
      error: 'Failed to fetch matches',
      message: error.message,
    });
  }
});

/**
 * GET /api/orderbook/:base/:quote - Get order book for token pair
 */
router.get('/orderbook/:base/:quote', async (req: Request, res: Response) => {
  try {
    const { base, quote } = req.params;
    const { depth = 20 } = req.query;

    const warlockClient = getWarlockClient();
    const orderBook = await warlockClient.getOrderBook(
      base,
      quote,
      parseInt(depth as string)
    );

    res.json(orderBook);
  } catch (error: any) {
    console.error('Error fetching order book:', error);
    res.status(500).json({
      error: 'Failed to fetch order book',
      message: error.message,
    });
  }
});

/**
 * DELETE /api/orders/:id - Cancel an order
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { user_address } = req.body;

    if (!user_address) {
      return res.status(400).json({ error: 'user_address is required' });
    }

    // Cancel order via Warlock
    const warlockClient = getWarlockClient();
    const result = await warlockClient.cancelOrder(id, getAddress(user_address as Address));

    res.json(result);
  } catch (error: any) {
    console.error('Error cancelling order:', error);
    res.status(500).json({
      error: 'Failed to cancel order',
      message: error.message,
    });
  }
});

/**
 * GET /api/orders/:id - Get order by ID
 * IMPORTANT: This route must come AFTER all specific routes like /user/:address
 * to avoid matching specific paths as IDs
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const result = await db.query(
      `SELECT
        id, user_address, chain_id, order_type, base_token, quote_token,
        quantity, price, variance_bps, min_price, max_price,
        filled_quantity, remaining_quantity, status,
        created_at, updated_at, expires_at
      FROM orders
      WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json(result.rows[0]);
  } catch (error: any) {
    console.error('Error fetching order:', error);
    res.status(500).json({
      error: 'Failed to fetch order',
      message: error.message,
    });
  }
});

export default router;
