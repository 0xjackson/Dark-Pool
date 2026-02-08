import { Router, Request, Response } from 'express';
import { Address, getAddress } from 'viem';
import {
  requestCreateChannel,
  requestResizeChannel,
  requestCloseChannel,
  getLedgerBalances,
  getChannels,
} from '../services/yellowConnection';

const router = Router();

const CHAIN_ID = process.env.CHAIN_ID ? parseInt(process.env.CHAIN_ID, 10) : 8453;

/**
 * POST /api/channel/create
 * Request channel creation from the clearnode.
 * Returns channel params + broker signature for the frontend to call Custody.create().
 */
router.post('/create', async (req: Request, res: Response) => {
  try {
    const { userAddress, token } = req.body;

    if (!userAddress || !token) {
      return res.status(400).json({ error: 'userAddress and token are required' });
    }

    const addr = getAddress(userAddress as Address);
    const chainId = req.body.chainId || CHAIN_ID;
    console.log('[create] chain_id being sent to clearnode:', chainId, '(from request:', req.body.chainId, ', env default:', CHAIN_ID, ')');

    const channelInfo = await requestCreateChannel(addr, chainId, token);

    return res.json(channelInfo);
  } catch (error: any) {
    const msg = error.message || '';
    if (msg.includes('No active session key') || msg.includes('Engine WS not connected')) {
      return res.status(401).json({ error: 'Session key not active. Please reconnect your wallet.', message: msg });
    }
    console.error('Error creating channel:', msg);
    res.status(500).json({ error: 'Failed to create channel', message: msg });
  }
});

/**
 * POST /api/channel/resize
 * Request channel resize from the clearnode.
 * Returns updated state + broker signature for the frontend to call Custody.resize().
 */
router.post('/resize', async (req: Request, res: Response) => {
  try {
    const { userAddress, channelId, resizeAmount, allocateAmount } = req.body;

    if (!userAddress || !channelId) {
      return res.status(400).json({ error: 'userAddress and channelId are required' });
    }

    const addr = getAddress(userAddress as Address);

    const channelInfo = await requestResizeChannel(
      addr,
      channelId,
      resizeAmount || '0',
      allocateAmount || '0',
    );

    return res.json(channelInfo);
  } catch (error: any) {
    const msg = error.message || '';
    if (msg.includes('No active session key') || msg.includes('Engine WS not connected')) {
      return res.status(401).json({ error: 'Session key not active. Please reconnect your wallet.', message: msg });
    }
    console.error('Error resizing channel:', msg);
    res.status(500).json({ error: 'Failed to resize channel', message: msg });
  }
});

/**
 * GET /api/channel/balances?address=0x...
 * Get unified (ledger) balances for a user from the clearnode.
 */
router.get('/balances', async (req: Request, res: Response) => {
  try {
    const userAddress = req.query.address as string;

    if (!userAddress) {
      return res.status(400).json({ error: 'address query param is required' });
    }

    const addr = getAddress(userAddress as Address);
    const balances = await getLedgerBalances(addr);

    console.log(`[balances] ${addr}: ${JSON.stringify(balances)}`);
    return res.json({ balances });
  } catch (error: any) {
    console.error('Error getting balances:', error);
    res.status(500).json({ error: 'Failed to get balances', message: error.message });
  }
});

/**
 * GET /api/channel/list?address=0x...
 * Get user's channels from the clearnode.
 */
router.get('/list', async (req: Request, res: Response) => {
  try {
    const userAddress = req.query.address as string;

    const addr = userAddress ? getAddress(userAddress as Address) : undefined;
    const channels = await getChannels(addr);

    return res.json({ channels });
  } catch (error: any) {
    console.error('Error listing channels:', error);
    res.status(500).json({ error: 'Failed to list channels', message: error.message });
  }
});

/**
 * POST /api/channel/close
 * Request channel close from clearnode.
 * Body: { address, channelId, fundsDestination }
 */
router.post('/close', async (req: Request, res: Response) => {
  try {
    const { address, channelId, fundsDestination } = req.body;

    if (!address || !channelId || !fundsDestination) {
      return res.status(400).json({
        error: 'address, channelId, and fundsDestination are required'
      });
    }

    const addr = getAddress(address as Address);
    const closeInfo = await requestCloseChannel(addr, channelId as `0x${string}`, fundsDestination as Address);

    return res.json(closeInfo);
  } catch (error: any) {
    console.error('Error closing channel:', error);
    res.status(500).json({ error: 'Failed to close channel', message: error.message });
  }
});

export default router;
