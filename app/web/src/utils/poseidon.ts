/**
 * Poseidon hash utility for Dark Pool order commitments.
 *
 * Uses circomlibjs Poseidon — same algorithm, field, and constants as:
 * - poseidon-solidity PoseidonT6 + PoseidonT4 (on-chain verification in revealAndSettle)
 * - circomlib Poseidon templates (ZK circuit verification in proveAndSettle)
 *
 * Nested hash structure (poseidon-solidity ships T2-T6 only, no T8 for 7 inputs):
 *   h1        = Poseidon(orderId, user, sellToken, buyToken, sellAmount)       // 5 inputs → T6
 *   orderHash = Poseidon(h1, minBuyAmount, expiresAt)                          // 3 inputs → T4
 *
 * All inputs are converted to BigInt field elements before hashing.
 * Addresses are treated as uint160 (same as Solidity's uint256(uint160(addr))).
 * The output is a BN128 field element (~254 bits), always < SNARK_SCALAR_FIELD.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let poseidonInstance: any = null;

const SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const FIELD_MASK_253 = (1n << 253n) - 1n;

async function getPoseidon() {
  if (!poseidonInstance) {
    // Dynamic import — circomlibjs is a large module, load lazily
    const { buildPoseidon } = await import('circomlibjs');
    poseidonInstance = await buildPoseidon();
  }
  return poseidonInstance;
}

/**
 * Generate an orderId masked to 253 bits (always < SNARK_SCALAR_FIELD).
 * Takes a raw 256-bit keccak256 hash and masks the top 3 bits to zero.
 * 253-bit IDs give ~10^76 unique values — collision probability is effectively zero.
 */
export function maskOrderId(rawKeccak: `0x${string}`): `0x${string}` {
  const masked = BigInt(rawKeccak) & FIELD_MASK_253;
  return ('0x' + masked.toString(16).padStart(64, '0')) as `0x${string}`;
}

/**
 * Compute nested Poseidon hash of order details.
 * Returns a bytes32 hex string compatible with the contract's _computeOrderHash.
 *
 * Hash structure:
 *   h1        = Poseidon(orderId, user, sellToken, buyToken, sellAmount)
 *   orderHash = Poseidon(h1, minBuyAmount, expiresAt)
 *
 * @param orderId - bytes32, must be < SNARK_SCALAR_FIELD (use maskOrderId)
 * @param user - address (0x...)
 * @param sellToken - address (0x...)
 * @param buyToken - address (0x...)
 * @param sellAmount - uint256 as bigint
 * @param minBuyAmount - uint256 as bigint
 * @param expiresAt - uint256 as bigint
 */
export async function computeOrderHash(
  orderId: `0x${string}`,
  user: `0x${string}`,
  sellToken: `0x${string}`,
  buyToken: `0x${string}`,
  sellAmount: bigint,
  minBuyAmount: bigint,
  expiresAt: bigint
): Promise<`0x${string}`> {
  const poseidon = await getPoseidon();

  // Step 1: PoseidonT6 equivalent — 5 inputs
  const h1 = poseidon([
    BigInt(orderId),
    BigInt(user),           // address → uint160 → fits in field
    BigInt(sellToken),
    BigInt(buyToken),
    sellAmount,
  ]);

  // Step 2: PoseidonT4 equivalent — 3 inputs (h1 is a field element, passed directly)
  const hash = poseidon([h1, minBuyAmount, expiresAt]);

  // Convert field element to bytes32 hex string
  const hashBigInt = poseidon.F.toString(hash) as string;
  const hex = BigInt(hashBigInt).toString(16).padStart(64, '0');
  return ('0x' + hex) as `0x${string}`;
}

export { SNARK_SCALAR_FIELD, FIELD_MASK_253 };
