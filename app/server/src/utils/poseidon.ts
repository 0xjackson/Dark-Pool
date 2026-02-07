/**
 * Poseidon hash utility for Dark Pool order commitments (backend).
 *
 * Same nested hash structure as frontend — uses circomlibjs Poseidon.
 * Ensures hash consistency between frontend, backend, contract, and circuit.
 *
 * Hash structure (poseidon-solidity ships T2-T6 only):
 *   h1        = Poseidon(orderId, user, sellToken, buyToken, sellAmount)       // 5 inputs → T6
 *   orderHash = Poseidon(h1, minBuyAmount, expiresAt)                          // 3 inputs → T4
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let poseidonInstance: any = null;

export const SNARK_SCALAR_FIELD = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617'
);

async function getPoseidon() {
  if (!poseidonInstance) {
    const { buildPoseidon } = await import('circomlibjs');
    poseidonInstance = await buildPoseidon();
  }
  return poseidonInstance;
}

/**
 * Compute nested Poseidon hash of order details.
 * Returns a 0x-prefixed bytes32 hex string matching the contract's _computeOrderHash.
 */
export async function computeOrderHash(
  orderId: string,
  user: string,
  sellToken: string,
  buyToken: string,
  sellAmount: string,
  minBuyAmount: string,
  expiresAt: number
): Promise<string> {
  const poseidon = await getPoseidon();

  // Step 1: PoseidonT6 equivalent — 5 inputs
  const h1 = poseidon([
    BigInt(orderId),
    BigInt(user),
    BigInt(sellToken),
    BigInt(buyToken),
    BigInt(sellAmount),
  ]);

  // Step 2: PoseidonT4 equivalent — 3 inputs
  const hash = poseidon([h1, BigInt(minBuyAmount), BigInt(expiresAt)]);

  const hashStr = poseidon.F.toString(hash) as string;
  return '0x' + BigInt(hashStr).toString(16).padStart(64, '0');
}
