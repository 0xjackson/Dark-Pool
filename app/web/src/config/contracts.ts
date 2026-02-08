/**
 * DarkPoolRouter contract address
 * TODO: Set per-chain addresses after deployment
 */
export const ROUTER_ADDRESS = (process.env.NEXT_PUBLIC_ROUTER_ADDRESS ||
  '0x0000000000000000000000000000000000000000') as `0x${string}`;

/**
 * Yellow Network Custody contract address
 */
export const CUSTODY_ADDRESS = (process.env.NEXT_PUBLIC_CUSTODY_ADDRESS ||
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
    stateMutability: 'payable',
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
  {
    name: 'proveAndSettle',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'sellerOrderId', type: 'bytes32' },
      { name: 'buyerOrderId', type: 'bytes32' },
      { name: 'sellerFillAmount', type: 'uint256' },
      { name: 'buyerFillAmount', type: 'uint256' },
      { name: 'proofTimestamp', type: 'uint256' },
      { name: 'a', type: 'uint256[2]' },
      { name: 'b', type: 'uint256[2][2]' },
      { name: 'c', type: 'uint256[2]' },
    ],
    outputs: [],
  },
  {
    name: 'markFullySettled',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'orderId', type: 'bytes32' }],
    outputs: [],
  },
  {
    name: 'revealAndSettle',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'sellerOrderId', type: 'bytes32' },
      { name: 'buyerOrderId', type: 'bytes32' },
      {
        name: 'seller',
        type: 'tuple',
        components: [
          { name: 'orderId', type: 'bytes32' },
          { name: 'user', type: 'address' },
          { name: 'sellToken', type: 'address' },
          { name: 'buyToken', type: 'address' },
          { name: 'sellAmount', type: 'uint256' },
          { name: 'minBuyAmount', type: 'uint256' },
          { name: 'expiresAt', type: 'uint256' },
        ],
      },
      {
        name: 'buyer',
        type: 'tuple',
        components: [
          { name: 'orderId', type: 'bytes32' },
          { name: 'user', type: 'address' },
          { name: 'sellToken', type: 'address' },
          { name: 'buyToken', type: 'address' },
          { name: 'sellAmount', type: 'uint256' },
          { name: 'minBuyAmount', type: 'uint256' },
          { name: 'expiresAt', type: 'uint256' },
        ],
      },
      { name: 'sellerFillAmount', type: 'uint256' },
      { name: 'buyerFillAmount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

/**
 * Yellow Custody ABI — deposit, create, resize, and balance query functions.
 * Used by the deposit flow to interact with the Custody contract on-chain.
 */
export const CUSTODY_ABI = [
  {
    name: 'deposit',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'create',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'ch',
        type: 'tuple',
        components: [
          { name: 'participants', type: 'address[]' },
          { name: 'adjudicator', type: 'address' },
          { name: 'challenge', type: 'uint64' },
          { name: 'nonce', type: 'uint64' },
        ],
      },
      {
        name: 'initial',
        type: 'tuple',
        components: [
          { name: 'intent', type: 'uint8' },
          { name: 'version', type: 'uint256' },
          { name: 'data', type: 'bytes' },
          {
            name: 'allocations',
            type: 'tuple[]',
            components: [
              { name: 'destination', type: 'address' },
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
          },
          { name: 'sigs', type: 'bytes[]' },
        ],
      },
    ],
    outputs: [{ name: 'channelId', type: 'bytes32' }],
  },
  {
    name: 'resize',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'channelId', type: 'bytes32' },
      {
        name: 'candidate',
        type: 'tuple',
        components: [
          { name: 'intent', type: 'uint8' },
          { name: 'version', type: 'uint256' },
          { name: 'data', type: 'bytes' },
          {
            name: 'allocations',
            type: 'tuple[]',
            components: [
              { name: 'destination', type: 'address' },
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
          },
          { name: 'sigs', type: 'bytes[]' },
        ],
      },
      {
        name: 'proofs',
        type: 'tuple[]',
        components: [
          { name: 'intent', type: 'uint8' },
          { name: 'version', type: 'uint256' },
          { name: 'data', type: 'bytes' },
          {
            name: 'allocations',
            type: 'tuple[]',
            components: [
              { name: 'destination', type: 'address' },
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
          },
          { name: 'sigs', type: 'bytes[]' },
        ],
      },
    ],
    outputs: [],
  },
  {
    name: 'getAccountsBalances',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'accounts', type: 'address[]' },
      { name: 'tokens', type: 'address[]' },
    ],
    outputs: [{ name: '', type: 'uint256[][]' }],
  },
  {
    name: 'channels',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'channelId', type: 'bytes32' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'intent', type: 'uint8' },
          { name: 'version', type: 'uint256' },
          { name: 'data', type: 'bytes' },
          {
            name: 'allocations',
            type: 'tuple[]',
            components: [
              { name: 'destination', type: 'address' },
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
          },
          { name: 'sigs', type: 'bytes[]' },
        ],
      },
    ],
  },
] as const;
