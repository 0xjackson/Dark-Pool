import { Router, Request, Response } from 'express';
import { Pool } from 'pg';

const router = Router();

let db: Pool;

export function setDatabase(pool: Pool) {
  db = pool;
}

/**
 * POST /api/commit-hash - Store a commitment hash for an order
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { order_id, commitment_hash, user_address } = req.body;

    if (!order_id || !commitment_hash || !user_address) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['order_id', 'commitment_hash', 'user_address'],
      });
    }

    // Verify order exists and belongs to user
    const orderResult = await db.query(
      'SELECT id, user_address, status FROM orders WHERE id = $1',
      [order_id]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderResult.rows[0];
    if (order.user_address.toLowerCase() !== user_address.toLowerCase()) {
      return res.status(403).json({ error: 'Order does not belong to this user' });
    }

    // Update order with commitment hash
    await db.query(
      `UPDATE orders
       SET commitment_hash = $1, status = 'COMMITTED', updated_at = NOW()
       WHERE id = $2`,
      [commitment_hash, order_id]
    );

    // TODO: Call commitOrder() on the DarkPool smart contract

    res.json({ success: true });
  } catch (error: any) {
    console.error('Error storing commitment hash:', error);
    res.status(500).json({
      error: 'Failed to store commitment hash',
      message: error.message,
    });
  }
});

export default router;
