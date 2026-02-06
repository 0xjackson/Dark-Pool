import { MAINNET_TOKENS, SEPOLIA_TOKENS } from '@/config/tokens';

/**
 * Get token symbol from address
 * Looks up the token in the known token lists and returns the symbol
 * Falls back to a shortened address format if token is not recognized
 */
export function getTokenSymbol(address: string, chainId?: number): string {
  const normalizedAddress = address.toLowerCase();

  // Check mainnet tokens
  const mainnetToken = Object.values(MAINNET_TOKENS).find(
    (token) => token.address.toLowerCase() === normalizedAddress
  );
  if (mainnetToken) return mainnetToken.symbol;

  // Check sepolia tokens
  const sepoliaToken = Object.values(SEPOLIA_TOKENS).find(
    (token) => token.address.toLowerCase() === normalizedAddress
  );
  if (sepoliaToken) return sepoliaToken.symbol;

  // Fallback to shortened address
  return address.slice(-6).toUpperCase();
}

/**
 * Get token info from address
 */
export function getTokenInfo(address: string, chainId?: number) {
  const normalizedAddress = address.toLowerCase();

  // Check mainnet tokens
  const mainnetToken = Object.values(MAINNET_TOKENS).find(
    (token) => token.address.toLowerCase() === normalizedAddress
  );
  if (mainnetToken) return mainnetToken;

  // Check sepolia tokens
  const sepoliaToken = Object.values(SEPOLIA_TOKENS).find(
    (token) => token.address.toLowerCase() === normalizedAddress
  );
  if (sepoliaToken) return sepoliaToken;

  return null;
}
