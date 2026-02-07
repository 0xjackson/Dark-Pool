import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

export function generateSessionKey(): { privateKey: `0x${string}`; address: `0x${string}` } {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  return { privateKey, address: account.address };
}
