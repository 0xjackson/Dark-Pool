import { createWalletClient, createPublicClient, http, Hex, Chain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet, sepolia, base, baseSepolia, polygon } from 'viem/chains';

const ENGINE_WALLET_KEY = process.env.ENGINE_WALLET_KEY as Hex | undefined;
const RPC_URL = process.env.RPC_URL || 'http://localhost:8545';
const CHAIN_ID = process.env.CHAIN_ID ? parseInt(process.env.CHAIN_ID, 10) : undefined;

const CHAIN_MAP: Record<number, Chain> = {
  1: mainnet,
  11155111: sepolia,
  8453: base,
  84532: baseSepolia,
  137: polygon,
};

function getChain(): Chain {
  if (CHAIN_ID && CHAIN_MAP[CHAIN_ID]) {
    return CHAIN_MAP[CHAIN_ID];
  }
  return mainnet;
}

export function getEngineWalletClient() {
  if (!ENGINE_WALLET_KEY) throw new Error('ENGINE_WALLET_KEY not set');
  const account = privateKeyToAccount(ENGINE_WALLET_KEY);
  return createWalletClient({
    account,
    chain: getChain(),
    transport: http(RPC_URL),
  });
}

export function getPublicClient() {
  return createPublicClient({
    chain: getChain(),
    transport: http(RPC_URL),
  });
}
