const snarkjs = require('snarkjs');
const path = require('path');

const WASM_PATH = path.join(__dirname, '../build/settlementMatch_js/settlementMatch.wasm');
const ZKEY_PATH = path.join(__dirname, '../build/settlementMatch_final.zkey');
const VKEY_PATH = path.join(__dirname, '../build/verification_key.json');

/**
 * Generate a Groth16 proof and verify it.
 * Returns { proof, publicSignals, valid }.
 * If witness generation fails (invalid inputs), throws.
 */
async function proveAndVerify(input) {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM_PATH, ZKEY_PATH);
  const vkey = require(VKEY_PATH);
  const valid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  return { proof, publicSignals, valid };
}

/**
 * Compute nested Poseidon hash matching the contract and circuit.
 * h1 = Poseidon(5)(orderId, user, sellToken, buyToken, sellAmount)
 * hash = Poseidon(3)(h1, minBuyAmount, expiresAt)
 */
async function computeOrderHash(orderId, user, sellToken, buyToken, sellAmount, minBuyAmount, expiresAt) {
  // Lazy-load circomlibjs
  const { buildPoseidon } = require('circomlibjs');
  const poseidon = await buildPoseidon();

  const h1 = poseidon([
    BigInt(orderId),
    BigInt(user),
    BigInt(sellToken),
    BigInt(buyToken),
    BigInt(sellAmount)
  ]);

  const hash = poseidon([h1, BigInt(minBuyAmount), BigInt(expiresAt)]);
  return poseidon.F.toString(hash);
}

/**
 * Build a valid test input set for the circuit.
 * Returns { input, seller, buyer, sellerHash, buyerHash }.
 */
async function buildValidInput(overrides = {}) {
  // Default seller: sells 100 TokenA for >= 90 TokenB, expires in the future
  const seller = {
    orderId: '123456789',
    user: '1001',          // simplified addresses for testing
    sellToken: '2001',     // TokenA
    buyToken: '3001',      // TokenB
    sellAmount: '100',
    minBuyAmount: '90',
    expiresAt: '9999999999', // far future
    ...overrides.seller,
  };

  // Default buyer: sells 95 TokenB for >= 90 TokenA
  const buyer = {
    orderId: '987654321',
    user: '1002',
    sellToken: '3001',     // TokenB (must match seller.buyToken)
    buyToken: '2001',      // TokenA (must match seller.sellToken)
    sellAmount: '95',
    minBuyAmount: '90',
    expiresAt: '9999999999',
    ...overrides.buyer,
  };

  const sellerHash = await computeOrderHash(
    seller.orderId, seller.user, seller.sellToken, seller.buyToken,
    seller.sellAmount, seller.minBuyAmount, seller.expiresAt
  );

  const buyerHash = await computeOrderHash(
    buyer.orderId, buyer.user, buyer.sellToken, buyer.buyToken,
    buyer.sellAmount, buyer.minBuyAmount, buyer.expiresAt
  );

  const input = {
    // Private — seller
    sellerOrderId: seller.orderId,
    sellerUser: seller.user,
    sellerSellToken: seller.sellToken,
    sellerBuyToken: seller.buyToken,
    sellerSellAmount: seller.sellAmount,
    sellerMinBuyAmount: seller.minBuyAmount,
    sellerExpiresAt: seller.expiresAt,

    // Private — buyer
    buyerOrderId: buyer.orderId,
    buyerUser: buyer.user,
    buyerSellToken: buyer.sellToken,
    buyerBuyToken: buyer.buyToken,
    buyerSellAmount: buyer.sellAmount,
    buyerMinBuyAmount: buyer.minBuyAmount,
    buyerExpiresAt: buyer.expiresAt,

    // Public
    sellerCommitmentHash: sellerHash,
    buyerCommitmentHash: buyerHash,
    sellerFillAmount: overrides.sellerFillAmount || '100',
    buyerFillAmount: overrides.buyerFillAmount || '95',
    sellerSettledSoFar: overrides.sellerSettledSoFar || '0',
    buyerSettledSoFar: overrides.buyerSettledSoFar || '0',
    currentTimestamp: overrides.currentTimestamp || '1000000000',
  };

  return { input, seller, buyer, sellerHash, buyerHash };
}

module.exports = { proveAndVerify, computeOrderHash, buildValidInput };
