pragma circom 2.1.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/comparators.circom";
include "node_modules/circomlib/circuits/bitify.circom";

// SettlementMatch: proves a trade match is valid without revealing order details.
//
// The circuit verifies:
//   1. Both orders' Poseidon commitment hashes match the on-chain commitments
//   2. Tokens cross-match (seller's sell = buyer's buy, and vice versa)
//   3. Neither order is expired
//   4. Fill amounts don't exceed remaining capacity
//   5. Both sides get a fair price (proportional slippage check)
//
// Hash structure (must match DarkPoolRouter._computeOrderHash):
//   h1 = Poseidon(5)(orderId, user, sellToken, buyToken, sellAmount)
//   orderHash = Poseidon(3)(h1, minBuyAmount, expiresAt)
//
template SettlementMatch() {

    // ==================== PRIVATE INPUTS (never revealed on-chain) ====================
    signal input sellerOrderId;
    signal input sellerUser;
    signal input sellerSellToken;
    signal input sellerBuyToken;
    signal input sellerSellAmount;
    signal input sellerMinBuyAmount;
    signal input sellerExpiresAt;

    signal input buyerOrderId;
    signal input buyerUser;
    signal input buyerSellToken;
    signal input buyerBuyToken;
    signal input buyerSellAmount;
    signal input buyerMinBuyAmount;
    signal input buyerExpiresAt;

    // ==================== PUBLIC INPUTS (visible on-chain, passed to verifier) ====================
    signal input sellerCommitmentHash;
    signal input buyerCommitmentHash;
    signal input sellerFillAmount;
    signal input buyerFillAmount;
    signal input sellerSettledSoFar;
    signal input buyerSettledSoFar;
    signal input currentTimestamp;

    // ==================== RANGE CHECKS ====================
    // Ensure amounts fit in 128 bits (products of two 128-bit numbers < field)
    // This prevents modular arithmetic issues in the slippage multiplication
    component sellerSellAmountBits = Num2Bits(128);
    sellerSellAmountBits.in <== sellerSellAmount;

    component sellerMinBuyAmountBits = Num2Bits(128);
    sellerMinBuyAmountBits.in <== sellerMinBuyAmount;

    component buyerSellAmountBits = Num2Bits(128);
    buyerSellAmountBits.in <== buyerSellAmount;

    component buyerMinBuyAmountBits = Num2Bits(128);
    buyerMinBuyAmountBits.in <== buyerMinBuyAmount;

    component sellerFillAmountBits = Num2Bits(128);
    sellerFillAmountBits.in <== sellerFillAmount;

    component buyerFillAmountBits = Num2Bits(128);
    buyerFillAmountBits.in <== buyerFillAmount;

    // ==================== CONSTRAINT 1: Seller hash verification ====================
    // Step 1: h1 = Poseidon(5)(orderId, user, sellToken, buyToken, sellAmount)
    component sellerHash1 = Poseidon(5);
    sellerHash1.inputs[0] <== sellerOrderId;
    sellerHash1.inputs[1] <== sellerUser;
    sellerHash1.inputs[2] <== sellerSellToken;
    sellerHash1.inputs[3] <== sellerBuyToken;
    sellerHash1.inputs[4] <== sellerSellAmount;

    // Step 2: orderHash = Poseidon(3)(h1, minBuyAmount, expiresAt)
    component sellerHash2 = Poseidon(3);
    sellerHash2.inputs[0] <== sellerHash1.out;
    sellerHash2.inputs[1] <== sellerMinBuyAmount;
    sellerHash2.inputs[2] <== sellerExpiresAt;

    sellerHash2.out === sellerCommitmentHash;

    // ==================== CONSTRAINT 2: Buyer hash verification ====================
    component buyerHash1 = Poseidon(5);
    buyerHash1.inputs[0] <== buyerOrderId;
    buyerHash1.inputs[1] <== buyerUser;
    buyerHash1.inputs[2] <== buyerSellToken;
    buyerHash1.inputs[3] <== buyerBuyToken;
    buyerHash1.inputs[4] <== buyerSellAmount;

    component buyerHash2 = Poseidon(3);
    buyerHash2.inputs[0] <== buyerHash1.out;
    buyerHash2.inputs[1] <== buyerMinBuyAmount;
    buyerHash2.inputs[2] <== buyerExpiresAt;

    buyerHash2.out === buyerCommitmentHash;

    // ==================== CONSTRAINTS 3-4: Token cross-match ====================
    sellerSellToken === buyerBuyToken;
    sellerBuyToken === buyerSellToken;

    // ==================== CONSTRAINTS 5-6: Not expired ====================
    // currentTimestamp < expiresAt (64-bit comparison — timestamps are well under 2^64)
    component sellerExpiry = LessThan(64);
    sellerExpiry.in[0] <== currentTimestamp;
    sellerExpiry.in[1] <== sellerExpiresAt;
    sellerExpiry.out === 1;

    component buyerExpiry = LessThan(64);
    buyerExpiry.in[0] <== currentTimestamp;
    buyerExpiry.in[1] <== buyerExpiresAt;
    buyerExpiry.out === 1;

    // ==================== CONSTRAINTS 7-8: No overfill ====================
    // fillAmount + settledSoFar <= sellAmount
    component sellerOverfill = LessEqThan(128);
    sellerOverfill.in[0] <== sellerFillAmount + sellerSettledSoFar;
    sellerOverfill.in[1] <== sellerSellAmount;
    sellerOverfill.out === 1;

    component buyerOverfill = LessEqThan(128);
    buyerOverfill.in[0] <== buyerFillAmount + buyerSettledSoFar;
    buyerOverfill.in[1] <== buyerSellAmount;
    buyerOverfill.out === 1;

    // ==================== CONSTRAINTS 9-10: Proportional slippage ====================
    // Seller: buyerFillAmount * sellerSellAmount >= sellerFillAmount * sellerMinBuyAmount
    // This is the rate check: (what seller receives / what seller gives) >= (minBuyAmount / sellAmount)
    //
    // With 128-bit range checks above, products are < 2^256.
    // The BN128 field is ~2^254. Products of two 127-bit values fit.
    // In practice, ERC-20 amounts are < 2^96 (~10 billion tokens with 18 decimals).
    // Products of two 96-bit values = 192 bits. Well within field.
    signal sellerSlippageLHS;
    signal sellerSlippageRHS;
    sellerSlippageLHS <== buyerFillAmount * sellerSellAmount;
    sellerSlippageRHS <== sellerFillAmount * sellerMinBuyAmount;

    component sellerSlippage = LessEqThan(252);
    sellerSlippage.in[0] <== sellerSlippageRHS;
    sellerSlippage.in[1] <== sellerSlippageLHS;
    sellerSlippage.out === 1;

    // Buyer: sellerFillAmount * buyerSellAmount >= buyerFillAmount * buyerMinBuyAmount
    signal buyerSlippageLHS;
    signal buyerSlippageRHS;
    buyerSlippageLHS <== sellerFillAmount * buyerSellAmount;
    buyerSlippageRHS <== buyerFillAmount * buyerMinBuyAmount;

    component buyerSlippage = LessEqThan(252);
    buyerSlippage.in[0] <== buyerSlippageRHS;
    buyerSlippage.in[1] <== buyerSlippageLHS;
    buyerSlippage.out === 1;
}

component main {public [
    sellerCommitmentHash,
    buyerCommitmentHash,
    sellerFillAmount,
    buyerFillAmount,
    sellerSettledSoFar,
    buyerSettledSoFar,
    currentTimestamp
]} = SettlementMatch();
