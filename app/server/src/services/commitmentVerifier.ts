import { ethers } from 'ethers';
import { computeOrderHash } from '../utils/poseidon';

const RPC_URL = process.env.RPC_URL || 'http://localhost:8545';
const ROUTER_ADDRESS = process.env.ROUTER_ADDRESS || '';

// Updated ABI: commitments now returns settledAmount between timestamp and status
const ROUTER_ABI = [
  'function commitments(bytes32) view returns (address user, bytes32 orderHash, uint256 timestamp, uint256 settledAmount, uint8 status)',
];

const STATUS_ACTIVE = 1;

let provider: ethers.JsonRpcProvider | null = null;
let routerContract: ethers.Contract | null = null;

function getContract(): ethers.Contract {
  if (!ROUTER_ADDRESS) {
    throw new Error('ROUTER_ADDRESS environment variable is required');
  }

  if (!provider) {
    provider = new ethers.JsonRpcProvider(RPC_URL);
  }

  if (!routerContract) {
    routerContract = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, provider);
  }

  return routerContract;
}

/**
 * Verify that submitted order details match the on-chain commitment.
 *
 * Reads the commitment from the DarkPoolRouter contract and checks:
 * 1. Commitment exists and is active
 * 2. poseidon(submittedDetails) === commitment.orderHash
 *
 * Returns null if valid, or an error string if invalid.
 */
export async function verifyCommitment(
  orderId: string,
  user: string,
  sellToken: string,
  buyToken: string,
  sellAmount: string,
  minBuyAmount: string,
  expiresAt: number
): Promise<string | null> {
  try {
    const contract = getContract();

    const commitment = await contract.commitments(orderId);
    const [, commitHash, , , commitStatus] = commitment;

    if (Number(commitStatus) !== STATUS_ACTIVE) {
      return 'Commitment not found or not active on-chain';
    }

    // Compute expected Poseidon hash from submitted details
    const expectedHash = await computeOrderHash(
      orderId,
      user,
      sellToken,
      buyToken,
      sellAmount,
      minBuyAmount,
      expiresAt
    );

    if (expectedHash !== commitHash) {
      return 'Order details do not match on-chain commitment';
    }

    return null;
  } catch (error: any) {
    console.error('Error verifying commitment:', error);
    return `Failed to verify on-chain commitment: ${error.message}`;
  }
}
