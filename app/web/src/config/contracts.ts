/**
 * DarkPoolRouter contract address
 * TODO: Set per-chain addresses after deployment
 */
export const ROUTER_ADDRESS = (process.env.NEXT_PUBLIC_ROUTER_ADDRESS ||
  '0x0000000000000000000000000000000000000000') as `0x${string}`;

/**
 * Minimal ERC20 ABI for allowance checks and approvals
 */
export const ERC20_ABI = [
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

/**
 * DarkPoolRouter ABI - only the functions the frontend calls
 */
export const ROUTER_ABI = [
  {
    name: 'depositAndCommit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'depositAmount', type: 'uint256' },
      { name: 'orderId', type: 'bytes32' },
      { name: 'orderHash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    name: 'commitOnly',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'orderId', type: 'bytes32' },
      { name: 'orderHash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    name: 'cancel',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'orderId', type: 'bytes32' }],
    outputs: [],
  },
  {
    name: 'commitments',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'orderId', type: 'bytes32' }],
    outputs: [
      { name: 'user', type: 'address' },
      { name: 'orderHash', type: 'bytes32' },
      { name: 'timestamp', type: 'uint256' },
      { name: 'settledAmount', type: 'uint256' },
      { name: 'status', type: 'uint8' },
    ],
  },
] as const;
