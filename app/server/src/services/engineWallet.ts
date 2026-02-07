import { createWalletClient, createPublicClient, http, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';

const ENGINE_WALLET_KEY = process.env.ENGINE_WALLET_KEY as Hex | undefined;
const RPC_URL = process.env.RPC_URL || 'http://localhost:8545';

export function getEngineWalletClient() {
  if (!ENGINE_WALLET_KEY) throw new Error('ENGINE_WALLET_KEY not set');
  const account = privateKeyToAccount(ENGINE_WALLET_KEY);
  return createWalletClient({
    account,
    chain: mainnet, // Update to match deployment chain
    transport: http(RPC_URL),
  });
}

export function getPublicClient() {
  return createPublicClient({
    chain: mainnet, // Update to match deployment chain
    transport: http(RPC_URL),
  });
}
