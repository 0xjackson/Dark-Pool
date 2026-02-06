export const EIP712_DOMAIN = {
  name: 'DarkPool',
  version: '1',
} as const;

export const ORDER_TYPES = {
  Order: [
    { name: 'user', type: 'address' },
    { name: 'baseToken', type: 'address' },
    { name: 'quoteToken', type: 'address' },
    { name: 'quantity', type: 'uint256' },
    { name: 'price', type: 'uint256' },
    { name: 'varianceBps', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'chainId', type: 'uint256' },
    { name: 'orderType', type: 'string' },
  ],
} as const;
