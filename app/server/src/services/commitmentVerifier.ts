import { ethers } from 'ethers';

const RPC_URL = process.env.RPC_URL || 'http://localhost:8545';
const ROUTER_ADDRESS = process.env.ROUTER_ADDRESS || '';

const ROUTER_ABI = [
  'function commitments(bytes32) view returns (address user, bytes32 orderHash, uint256 timestamp, uint8 status)',
];

// Status enum matching the contract
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
 * Compute the order hash matching the contract's keccak256(abi.encode(OrderDetails))
 *
 * OrderDetails struct fields:
 *   bytes32 orderId, address user, address sellToken, address buyToken,
 *   uint256 sellAmount, uint256 minBuyAmount, uint256 expiresAt
 */
export function computeOrderHash(
  orderId: string,
  user: string,
  sellToken: string,
  buyToken: string,
  sellAmount: string,
  minBuyAmount: string,
  expiresAt: number
): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'address', 'address', 'address', 'uint256', 'uint256', 'uint256'],
      [orderId, user, sellToken, buyToken, sellAmount, minBuyAmount, expiresAt]
    )
  );
}

/**
 * Verify that submitted order details match the on-chain commitment.
 *
 * Reads the commitment from the DarkPoolRouter contract and checks:
 * 1. Commitment exists and is active
 * 2. keccak256(abi.encode(submittedDetails)) === commitment.orderHash
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
    const [commitUser, commitHash, , commitStatus] = commitment;

    // Check commitment is active
    if (Number(commitStatus) !== STATUS_ACTIVE) {
      return 'Commitment not found or not active on-chain';
    }

    // Compute expected hash from submitted details
    const expectedHash = computeOrderHash(
      orderId,
      user,
      sellToken,
      buyToken,
      sellAmount,
      minBuyAmount,
      expiresAt
    );

    // Verify hash matches
    if (expectedHash !== commitHash) {
      return 'Order details do not match on-chain commitment';
    }

    return null; // valid
  } catch (error: any) {
    console.error('Error verifying commitment:', error);
    return `Failed to verify on-chain commitment: ${error.message}`;
  }
}
