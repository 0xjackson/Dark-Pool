import { Router, Request, Response } from 'express';
import { getWarlockClient } from '../services/warlockClient';
import { Pool } from 'pg';

const router = Router();

// Get database pool from app context
let db: Pool;

export function setDatabase(pool: Pool) {
  db = pool;
}

/**
 * POST /api/orders - Create and submit a new order
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
      expires_in_seconds,
      order_signature,
      order_data,
    } = req.body;

    // Validate required fields
    if (
      !user_address ||
      !chain_id ||
      !order_type ||
      !base_token ||
      !quote_token ||
      !quantity ||
      !price
    ) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: [
          'user_address',
          'chain_id',
          'order_type',
          'base_token',
          'quote_token',
          'quantity',
          'price',
        ],
      });
    }

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

    // TODO: Verify signature (implement signature verification)
    // const isValidSignature = verifyOrderSignature(order_data, order_signature, user_address);
    // if (!isValidSignature) {
    //   return res.status(401).json({ error: 'Invalid signature' });
    // }

    // Generate commitment hash (simplified - should use proper keccak256)
    // const commitment_hash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(JSON.stringify(order_data)));

    // Submit order to Warlock matching engine
    const warlockClient = getWarlockClient();
    const result = await warlockClient.submitOrder({
      user_address,
      chain_id,
      order_type,
      base_token,
      quote_token,
      quantity,
      price,
      variance_bps: varianceBps,
      expires_in_seconds: expires_in_seconds || 0,
      order_signature: order_signature || '',
      order_data: order_data ? JSON.stringify(order_data) : '{}',
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
 * GET /api/orders/:id - Get order by ID
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const result = await db.query(
      `SELECT
        id, user_address, chain_id, order_type, base_token, quote_token,
        quantity, price, variance_bps, min_price, max_price,
        filled_quantity, remaining_quantity, status,
        created_at, expires_at
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

/**
 * GET /api/orders/user/:address - Get all orders for a user
 */
router.get('/user/:address', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    const { status, limit = 50, offset = 0 } = req.query;

    let query = `
      SELECT
        id, user_address, chain_id, order_type, base_token, quote_token,
        quantity, price, variance_bps, min_price, max_price,
        filled_quantity, remaining_quantity, status,
        created_at, expires_at
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
    const result = await warlockClient.cancelOrder(id, user_address);

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
 * GET /api/matches/user/:address - Get matches for a user
 */
router.get('/matches/user/:address', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;
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

export default router;
