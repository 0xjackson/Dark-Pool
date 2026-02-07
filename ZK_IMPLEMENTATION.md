# ZK Settlement Implementation Spec

This document covers everything needed to add ZK proof-based settlement (`proveAndSettle`) to the Dark Pool protocol. An agent following this spec should be able to implement every piece without guessing.

---

## Overview

Currently, the settlement worker (`app/server/src/services/settlementWorker.ts`) creates Yellow App Sessions to swap funds but **never calls the smart contract** to verify the match is legitimate. We need to add:

1. A **Circom circuit** that proves a match is valid without revealing order details
2. A **Groth16 Solidity verifier** (auto-generated) deployed on-chain
3. A **`proveAndSettle` function** in DarkPoolRouter that verifies the proof
4. A **backend proof generator** that creates proofs for each match
5. **Wiring** in the settlement worker to call proof generation + on-chain settlement
6. **DB/proto changes** to store the order fields needed for proof generation

The `revealAndSettle` fallback stays in the contract untouched — just not wired up in the worker.

---

## Part 1: Database & Proto — Store ZK-Required Order Fields

### Problem

The settlement worker needs all 7 `OrderDetails` fields to generate a ZK proof, but 3 are missing from the DB:

| Field | Contract type | Currently in DB? |
|-------|--------------|-----------------|
| orderId | bytes32 | NO — generated in frontend, not stored |
| user | address | YES — `user_address` |
| sellToken | address | YES — `base_token` (see note) |
| buyToken | address | YES — `quote_token` (see note) |
| sellAmount | uint256 | NO — frontend computes, not stored |
| minBuyAmount | uint256 | NO — frontend computes, not stored |
| expiresAt | uint256 | YES — `expires_at` (as timestamp, needs Unix conversion) |

**Note on sellToken/buyToken**: The frontend sets `sellToken = formData.tokenPair.baseToken.address` and `buyToken = formData.tokenPair.quoteToken.address` regardless of BUY/SELL order_type. So `base_token` in DB = sellToken and `quote_token` = buyToken for the on-chain commitment. This mapping is already established — do not change it.

### 1a. Migration file

Create `warlock/migrations/003_zk_order_fields.up.sql`:

```sql
-- Add on-chain order fields needed for ZK proof generation
ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_id VARCHAR(66);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sell_amount VARCHAR(78);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS min_buy_amount VARCHAR(78);

-- Settlement tracking columns referenced by settlement worker
ALTER TABLE matches ADD COLUMN IF NOT EXISTS settle_tx_hash VARCHAR(66);
ALTER TABLE matches ADD COLUMN IF NOT EXISTS settled_at TIMESTAMP WITH TIME ZONE;
```

Create `warlock/migrations/003_zk_order_fields.down.sql`:

```sql
ALTER TABLE orders DROP COLUMN IF EXISTS order_id;
ALTER TABLE orders DROP COLUMN IF EXISTS sell_amount;
ALTER TABLE orders DROP COLUMN IF EXISTS min_buy_amount;
ALTER TABLE matches DROP COLUMN IF EXISTS settle_tx_hash;
ALTER TABLE matches DROP COLUMN IF EXISTS settled_at;
```

### 1b. Proto update

In `warlock/pkg/api/proto/warlock.proto`, update `SubmitOrderRequest`:

```protobuf
message SubmitOrderRequest {
  string user_address = 1;
  int32 chain_id = 2;
  OrderType order_type = 3;
  string base_token = 4;
  string quote_token = 5;
  string quantity = 6;
  string price = 7;
  int32 variance_bps = 8;
  int64 expires_in_seconds = 9;
  string commitment_hash = 10;
  // Fields 11-12 removed (were order_signature, order_data — EIP-712 remnants)
  string order_id = 13;          // On-chain orderId (bytes32 hex, 253-bit masked)
  string sell_amount = 14;       // Exact wei amount committed on-chain
  string min_buy_amount = 15;    // Exact wei minimum buy amount from commitment
}
```

After editing, regenerate Go code: `cd warlock && pkg/api/proto/generate.sh`

### 1c. Go server update

In `warlock/internal/grpc/server.go`, update the INSERT in `SubmitOrder` (around line 111):

```go
_, err = s.db.Exec(ctx, `
    INSERT INTO orders (
        id, user_address, chain_id, order_type, base_token, quote_token,
        quantity, price, variance_bps, min_price, max_price,
        filled_quantity, remaining_quantity, status,
        commitment_hash, order_id, sell_amount, min_buy_amount, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
`,
    orderID, req.UserAddress, req.ChainId, orderTypeToString(req.OrderType),
    req.BaseToken, req.QuoteToken,
    quantity.String(), price.String(), req.VarianceBps, minPrice.String(), maxPrice.String(),
    "0", quantity.String(), "REVEALED",
    req.CommitmentHash, req.OrderId, req.SellAmount, req.MinBuyAmount, nullTimeOrValue(expiresAt),
)
```

Remove references to `req.OrderSignature` and `req.OrderData`.

### 1d. Backend warlockClient update

In `app/server/src/services/warlockClient.ts`, update the `submitOrder` call to pass the new fields:

```typescript
const result = await warlockClient.submitOrder({
  user_address,
  chain_id,
  order_type,
  base_token,
  quote_token,
  quantity,
  price,
  variance_bps: varianceBps,
  commitment_hash,
  order_id,         // ADD
  sell_amount,      // ADD
  min_buy_amount,   // ADD
});
```

The frontend already sends `order_id`, `sell_amount`, and `min_buy_amount` in the request body (see `app/web/src/hooks/useSubmitTrade.ts` lines 120-134). The backend `orders.ts` route already destructures them (lines 33-34). They just need to be forwarded to Warlock.

---

## Part 2: Circom Circuit

### 2a. Install toolchain

```bash
# Install Circom compiler (v2.1.x)
# On macOS:
brew install circom
# Or from source: https://docs.circom.io/getting-started/installation/

# Install snarkjs globally (for CLI commands during setup)
npm install -g snarkjs

# Download Powers of Tau ceremony file (needed for trusted setup)
# Our circuit is ~5-10k constraints, so 2^15 (32768) is more than enough
mkdir -p circuits/build
curl -L https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_15.ptau \
  -o circuits/build/pot15.ptau
```

### 2b. Install circomlib (Poseidon + comparators)

```bash
cd circuits
npm init -y
npm install circomlib
```

This gives us `node_modules/circomlib/circuits/poseidon.circom` and `comparators.circom`.

### 2c. Write the circuit

Create `circuits/settlementMatch.circom`:

```circom
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
    // Ensure amounts fit in 128 bits (products of two 126-bit numbers < field)
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
```

### 2d. Compile and generate proving artifacts

Create `circuits/build.sh`:

```bash
#!/bin/bash
set -e

CIRCUIT=settlementMatch
BUILD_DIR=build
PTAU=$BUILD_DIR/pot15.ptau

echo "=== Compiling circuit ==="
circom $CIRCUIT.circom --r1cs --wasm --sym -o $BUILD_DIR

echo "=== Circuit info ==="
snarkjs r1cs info $BUILD_DIR/$CIRCUIT.r1cs

echo "=== Generating zkey (Groth16 setup) ==="
snarkjs groth16 setup $BUILD_DIR/$CIRCUIT.r1cs $PTAU $BUILD_DIR/${CIRCUIT}_0000.zkey

echo "=== Contributing to phase 2 ceremony ==="
snarkjs zkey contribute $BUILD_DIR/${CIRCUIT}_0000.zkey $BUILD_DIR/${CIRCUIT}_final.zkey \
  --name="dark-pool contribution" -v -e="$(head -c 64 /dev/urandom | xxd -p)"

echo "=== Exporting verification key ==="
snarkjs zkey export verificationkey $BUILD_DIR/${CIRCUIT}_final.zkey $BUILD_DIR/verification_key.json

echo "=== Generating Solidity verifier ==="
snarkjs zkey export solidityverifier $BUILD_DIR/${CIRCUIT}_final.zkey $BUILD_DIR/Groth16Verifier.sol

echo "=== Copying verifier to contracts ==="
cp $BUILD_DIR/Groth16Verifier.sol ../contracts/src/Groth16Verifier.sol

echo "=== Copying WASM + zkey to backend ==="
mkdir -p ../app/server/circuits
cp $BUILD_DIR/${CIRCUIT}_js/${CIRCUIT}.wasm ../app/server/circuits/
cp $BUILD_DIR/${CIRCUIT}_final.zkey ../app/server/circuits/

echo "=== Done ==="
echo "Artifacts:"
echo "  Solidity verifier: ../contracts/src/Groth16Verifier.sol"
echo "  Circuit WASM:      ../app/server/circuits/$CIRCUIT.wasm"
echo "  Proving key:       ../app/server/circuits/${CIRCUIT}_final.zkey"
```

Make it executable: `chmod +x circuits/build.sh`

Run it: `cd circuits && ./build.sh`

---

## Part 3: Contract Updates

### 3a. Add IZKVerifier interface

Create or add to `contracts/src/interfaces/IZKVerifier.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IZKVerifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[7] calldata input
    ) external view returns (bool);
}
```

**IMPORTANT**: The `uint256[7]` must match the number of public inputs in the circuit (7). Check the generated `Groth16Verifier.sol` — it will have `verifyProof(uint[2], uint[2][2], uint[2], uint[N])` where N is the public input count. If snarkjs generates a different function signature, update the interface to match.

### 3b. Update DarkPoolRouter constructor

Current constructor (line 87-90 of `contracts/src/DarkPoolRouter.sol`):
```solidity
constructor(address _custody, address _engine) {
    custody = IYellowCustody(_custody);
    engine = _engine;
}
```

New constructor:
```solidity
import {IZKVerifier} from "./interfaces/IZKVerifier.sol";

// Add state variable near the top:
IZKVerifier public immutable zkVerifier;

// Updated constructor:
constructor(address _custody, address _engine, address _zkVerifier) {
    custody = IYellowCustody(_custody);
    engine = _engine;
    zkVerifier = IZKVerifier(_zkVerifier);
}
```

### 3c. Add proveAndSettle function

Add this function to `DarkPoolRouter.sol`, alongside the existing `revealAndSettle`:

```solidity
/// @notice Settle a match using a ZK proof — order details stay private.
/// @dev The proof verifies: hash correctness, token match, expiry, no overfill, slippage.
///      The contract reads commitment hashes + settledAmounts from storage and passes
///      them as public inputs. This prevents replay (settledAmount changes after each call,
///      making old proofs invalid).
function proveAndSettle(
    bytes32 sellerOrderId,
    bytes32 buyerOrderId,
    uint256 sellerFillAmount,
    uint256 buyerFillAmount,
    uint256[2] calldata a,
    uint256[2][2] calldata b,
    uint256[2] calldata c
) external {
    require(msg.sender == engine, "Only engine");

    Commitment storage sellerC = commitments[sellerOrderId];
    Commitment storage buyerC = commitments[buyerOrderId];

    require(sellerC.status == Status.Active, "Seller not active");
    require(buyerC.status == Status.Active, "Buyer not active");
    require(sellerFillAmount > 0, "Zero seller fill");
    require(buyerFillAmount > 0, "Zero buyer fill");

    // Build public inputs array — must match circuit's public signal order exactly
    uint256[7] memory pubInputs = [
        uint256(sellerC.orderHash),   // [0] sellerCommitmentHash
        uint256(buyerC.orderHash),    // [1] buyerCommitmentHash
        sellerFillAmount,             // [2] sellerFillAmount
        buyerFillAmount,              // [3] buyerFillAmount
        sellerC.settledAmount,        // [4] sellerSettledSoFar
        buyerC.settledAmount,         // [5] buyerSettledSoFar
        block.timestamp               // [6] currentTimestamp
    ];

    require(zkVerifier.verifyProof(a, b, c, pubInputs), "Invalid proof");

    // Update settled amounts (order stays Active for more partial fills)
    sellerC.settledAmount += sellerFillAmount;
    buyerC.settledAmount += buyerFillAmount;

    emit OrdersSettling(sellerOrderId, buyerOrderId);
}
```

**Key design points:**
- `sellerC.orderHash` and `settledAmount` are read from storage, NOT passed by caller. This prevents the engine from lying about commitment hashes or settled amounts.
- `block.timestamp` is used as the current time, matching what the circuit checked against for expiry.
- After a successful `proveAndSettle`, `settledAmount` changes, which means the same proof can never be replayed (the public inputs would be different).
- `sellerFillAmount > 0` is belt-and-suspenders (the circuit also prevents meaningless proofs, but this is cheap to check).

### 3d. Update existing tests

The constructor change from `(custody, engine)` to `(custody, engine, zkVerifier)` breaks all existing tests.

In `contracts/test/DarkPoolRouter.t.sol`:

1. Create a `MockZKVerifier` that always returns true:
```solidity
contract MockZKVerifier {
    function verifyProof(
        uint256[2] calldata,
        uint256[2][2] calldata,
        uint256[2] calldata,
        uint256[7] calldata
    ) external pure returns (bool) {
        return true;
    }
}
```

2. Update `setUp()`:
```solidity
MockZKVerifier mockVerifier;

function setUp() public {
    // ... existing setup ...
    mockVerifier = new MockZKVerifier();
    router = new DarkPoolRouter(address(custody), engine, address(mockVerifier));
}
```

3. All 20 existing tests should still pass after this change.

### 3e. Add proveAndSettle tests

Add new tests using `MockZKVerifier` (returns true, so the proof passes automatically — we're testing the contract logic, not the proof):

```solidity
function test_ProveAndSettle_FullLifecycle() public {
    // Commit seller + buyer
    // Call proveAndSettle with mock proof
    // Verify settledAmount updated
    // Call markFullySettled
    // Verify status = Settled
}

function test_ProveAndSettle_PartialFills() public {
    // Commit seller (100 tokens)
    // proveAndSettle with fill = 60
    // Verify settledAmount = 60, status = Active
    // proveAndSettle with second buyer, fill = 40
    // Verify settledAmount = 100
}

function test_RevertProveAndSettle_InvalidProof() public {
    // Deploy a RejectingZKVerifier that always returns false
    // Call proveAndSettle — should revert "Invalid proof"
}

function test_RevertProveAndSettle_NotEngine() public {
    // Call from non-engine address — should revert
}
```

---

## Part 4: Backend Proof Generator

### 4a. Install snarkjs in backend

```bash
cd app/server
npm install snarkjs
```

Also add TypeScript types. Create `app/server/src/types/snarkjs.d.ts`:

```typescript
declare module 'snarkjs' {
  export const groth16: {
    fullProve(
      input: Record<string, bigint | string>,
      wasmPath: string,
      zkeyPath: string
    ): Promise<{
      proof: {
        pi_a: [string, string, string];
        pi_b: [[string, string], [string, string], [string, string]];
        pi_c: [string, string, string];
        protocol: string;
        curve: string;
      };
      publicSignals: string[];
    }>;

    verify(
      verificationKey: object,
      publicSignals: string[],
      proof: object
    ): Promise<boolean>;
  };
}
```

### 4b. Create proof generator service

Create `app/server/src/services/proofGenerator.ts`:

```typescript
import * as snarkjs from 'snarkjs';
import * as path from 'path';

const CIRCUIT_WASM = path.join(__dirname, '../../circuits/settlementMatch.wasm');
const ZKEY_PATH = path.join(__dirname, '../../circuits/settlementMatch_final.zkey');

export interface OrderDetailsForProof {
  orderId: string;        // bytes32 hex
  user: string;           // address hex
  sellToken: string;      // address hex
  buyToken: string;       // address hex
  sellAmount: string;     // uint256 decimal string
  minBuyAmount: string;   // uint256 decimal string
  expiresAt: number;      // Unix timestamp
}

export interface ProofResult {
  a: [string, string];
  b: [[string, string], [string, string]];
  c: [string, string];
  publicSignals: string[];
}

export async function generateSettlementProof(
  seller: OrderDetailsForProof,
  buyer: OrderDetailsForProof,
  sellerFillAmount: string,
  buyerFillAmount: string,
  sellerSettledSoFar: string,
  buyerSettledSoFar: string,
  currentTimestamp: number
): Promise<ProofResult> {

  const input = {
    // Private inputs — seller
    sellerOrderId: BigInt(seller.orderId).toString(),
    sellerUser: BigInt(seller.user).toString(),
    sellerSellToken: BigInt(seller.sellToken).toString(),
    sellerBuyToken: BigInt(seller.buyToken).toString(),
    sellerSellAmount: seller.sellAmount,
    sellerMinBuyAmount: seller.minBuyAmount,
    sellerExpiresAt: seller.expiresAt.toString(),

    // Private inputs — buyer
    buyerOrderId: BigInt(buyer.orderId).toString(),
    buyerUser: BigInt(buyer.user).toString(),
    buyerSellToken: BigInt(buyer.sellToken).toString(),
    buyerBuyToken: BigInt(buyer.buyToken).toString(),
    buyerSellAmount: buyer.sellAmount,
    buyerMinBuyAmount: buyer.minBuyAmount,
    buyerExpiresAt: buyer.expiresAt.toString(),

    // Public inputs
    sellerCommitmentHash: BigInt(seller.orderId).toString(), // WRONG — see below
    buyerCommitmentHash: BigInt(buyer.orderId).toString(),   // WRONG — see below
    sellerFillAmount,
    buyerFillAmount,
    sellerSettledSoFar,
    buyerSettledSoFar,
    currentTimestamp: currentTimestamp.toString(),
  };

  // IMPORTANT: The commitment hashes above are PLACEHOLDERS.
  // The actual sellerCommitmentHash and buyerCommitmentHash are the
  // Poseidon hashes stored on-chain (commitment.orderHash).
  // The settlement worker must compute these using computeOrderHash()
  // from ../utils/poseidon.ts and pass them in.
  // When wiring this into the settlement worker, replace the placeholder
  // lines with the actual Poseidon hashes.
  //
  // Actually — the circuit COMPUTES the hash from the private inputs
  // and checks it equals the public input. So the public inputs should
  // be the on-chain commitment hashes (read from DB commitment_hash column).

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    CIRCUIT_WASM,
    ZKEY_PATH
  );

  // Convert proof to Solidity-compatible format
  // snarkjs outputs [x, y, z] for G1 points — Solidity needs [x, y]
  // snarkjs outputs [[x1,y1],[x2,y2],[1,0]] for G2 — Solidity needs [[x1,x2],[y1,y2]]
  return {
    a: [proof.pi_a[0], proof.pi_a[1]] as [string, string],
    b: [
      [proof.pi_b[0][1], proof.pi_b[0][0]],  // NOTE: b coordinates are REVERSED
      [proof.pi_b[1][1], proof.pi_b[1][0]],
    ] as [[string, string], [string, string]],
    c: [proof.pi_c[0], proof.pi_c[1]] as [string, string],
    publicSignals,
  };
}
```

**CRITICAL NOTE about proof formatting**: snarkjs Groth16 outputs the B point (G2) with coordinates in a specific order that needs to be reversed for the Solidity verifier. The code above does this reversal. If proofs fail on-chain but verify in JS, this is likely the issue. Check the generated `Groth16Verifier.sol` to confirm the expected parameter order.

### 4c. Fixing the commitment hash public inputs

The proof generator needs the actual commitment hashes (Poseidon outputs stored on-chain). The settlement worker should:

1. Read `commitment_hash` from the orders table for both seller and buyer
2. Pass these as `sellerCommitmentHash` and `buyerCommitmentHash` public inputs

Update the proof generator to accept these as parameters:

```typescript
export async function generateSettlementProof(
  seller: OrderDetailsForProof,
  buyer: OrderDetailsForProof,
  sellerCommitmentHash: string,  // from DB commitment_hash column
  buyerCommitmentHash: string,   // from DB commitment_hash column
  sellerFillAmount: string,
  buyerFillAmount: string,
  sellerSettledSoFar: string,
  buyerSettledSoFar: string,
  currentTimestamp: number
): Promise<ProofResult> {
  const input = {
    // ... private inputs same as above ...

    // Public inputs — use actual on-chain hashes
    sellerCommitmentHash: BigInt(sellerCommitmentHash).toString(),
    buyerCommitmentHash: BigInt(buyerCommitmentHash).toString(),
    sellerFillAmount,
    buyerFillAmount,
    sellerSettledSoFar,
    buyerSettledSoFar,
    currentTimestamp: currentTimestamp.toString(),
  };
  // ... rest same ...
}
```

---

## Part 5: Settlement Worker Update

### 5a. Add engine wallet for on-chain transactions

Create `app/server/src/services/engineWallet.ts`:

```typescript
import { createWalletClient, createPublicClient, http, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains'; // or the correct chain

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
```

### 5b. Update settlement worker

In `app/server/src/services/settlementWorker.ts`, add the on-chain settlement step between match claim and App Session creation.

The updated `settleMatch` flow should be:

```
1. Claim match atomically (existing)
2. Load session keys (existing)
3. Load full order details from DB (NEW)
4. Generate ZK proof (NEW)
5. Call proveAndSettle on-chain (NEW)
6. Create App Session on Yellow (existing)
7. Close App Session (existing)
8. Check if orders fully filled → call markFullySettled (NEW)
9. Update match status → SETTLED (existing, + store settle_tx_hash)
10. Notify via WebSocket (existing)
```

Key changes to `settleMatch`:

```typescript
// NEW STEP 3: Load full order details
const sellerOrder = await loadOrderDetails(match.sell_order_id);
const buyerOrder = await loadOrderDetails(match.buy_order_id);

// NEW STEP 4: Generate ZK proof
const proof = await generateSettlementProof(
  {
    orderId: sellerOrder.order_id,
    user: sellerOrder.user_address,
    sellToken: sellerOrder.base_token,
    buyToken: sellerOrder.quote_token,
    sellAmount: sellerOrder.sell_amount,
    minBuyAmount: sellerOrder.min_buy_amount,
    expiresAt: Math.floor(new Date(sellerOrder.expires_at).getTime() / 1000),
  },
  {
    orderId: buyerOrder.order_id,
    user: buyerOrder.user_address,
    sellToken: buyerOrder.base_token,
    buyToken: buyerOrder.quote_token,
    sellAmount: buyerOrder.sell_amount,
    minBuyAmount: buyerOrder.min_buy_amount,
    expiresAt: Math.floor(new Date(buyerOrder.expires_at).getTime() / 1000),
  },
  sellerOrder.commitment_hash,
  buyerOrder.commitment_hash,
  match.quantity,      // sellerFillAmount
  quoteAmount,         // buyerFillAmount
  '0',                 // sellerSettledSoFar (read from on-chain or DB)
  '0',                 // buyerSettledSoFar
  Math.floor(Date.now() / 1000)  // close to block.timestamp
);

// NEW STEP 5: Call proveAndSettle on-chain
const walletClient = getEngineWalletClient();
const publicClient = getPublicClient();

const txHash = await walletClient.writeContract({
  address: ROUTER_ADDRESS,
  abi: ROUTER_ABI,  // Must include proveAndSettle
  functionName: 'proveAndSettle',
  args: [
    sellerOrder.order_id,   // sellerOrderId
    buyerOrder.order_id,    // buyerOrderId
    BigInt(match.quantity),  // sellerFillAmount
    BigInt(quoteAmount),     // buyerFillAmount
    proof.a.map(BigInt),
    proof.b.map(row => row.map(BigInt)),
    proof.c.map(BigInt),
  ],
});

await publicClient.waitForTransactionReceipt({ hash: txHash });

// Store tx hash
await db.query(
  `UPDATE matches SET settle_tx_hash = $2 WHERE id = $1`,
  [match.id, txHash],
);
```

Add a helper to load full order details:

```typescript
async function loadOrderDetails(orderId: string) {
  const result = await db.query(
    `SELECT id, user_address, base_token, quote_token,
            order_id, sell_amount, min_buy_amount, commitment_hash,
            quantity, price, expires_at
     FROM orders WHERE id = $1`,
    [orderId],
  );
  if (result.rows.length === 0) throw new Error(`Order not found: ${orderId}`);
  return result.rows[0];
}
```

### 5c. Add markFullySettled call

After the App Session closes successfully, check if each order is fully filled:

```typescript
// After closeAppSession and status update...

// Check if seller is fully filled
const sellerRemaining = await db.query(
  `SELECT remaining_quantity FROM orders WHERE id = $1`,
  [match.sell_order_id],
);
if (sellerRemaining.rows[0]?.remaining_quantity === '0') {
  await walletClient.writeContract({
    address: ROUTER_ADDRESS,
    abi: ROUTER_ABI,
    functionName: 'markFullySettled',
    args: [sellerOrder.order_id],
  });
}

// Same for buyer
```

### 5d. Update ROUTER_ABI

The settlement worker needs the `proveAndSettle` and `markFullySettled` function ABIs. Add them to wherever the ABI is defined for the backend (or import from a shared config):

```typescript
const ROUTER_ABI = [
  // ... existing entries ...
  'function proveAndSettle(bytes32 sellerOrderId, bytes32 buyerOrderId, uint256 sellerFillAmount, uint256 buyerFillAmount, uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c) external',
  'function markFullySettled(bytes32 orderId) external',
  'function commitments(bytes32) view returns (address user, bytes32 orderHash, uint256 timestamp, uint256 settledAmount, uint8 status)',
];
```

---

## Part 6: Environment & Config

### 6a. Required environment variables

Add to `.env.example`:

```
# Engine wallet (signs on-chain txs: proveAndSettle, markFullySettled)
ENGINE_WALLET_KEY=0x...

# Yellow Network
YELLOW_WS_URL=wss://clearnet-sandbox.yellow.com/ws

# Contract addresses
ROUTER_ADDRESS=0x...
RPC_URL=http://localhost:8545

# Session key encryption (for future — currently plaintext)
SESSION_KEY_ENCRYPTION_SECRET=...
```

### 6b. Circuit artifacts location

The build script copies artifacts to `app/server/circuits/`. The proof generator loads from there. Make sure this directory is included in Docker builds and `.gitignore` doesn't exclude it.

Add to `app/server/.gitignore` (or root):
```
# Circuit artifacts are build outputs — regenerate with circuits/build.sh
# Include them in the repo for deployment convenience
!app/server/circuits/
```

---

## Part 7: Verification Checklist

After implementing everything, verify:

- [ ] `circom settlementMatch.circom` compiles without errors
- [ ] `snarkjs r1cs info` shows reasonable constraint count (~5-10k)
- [ ] `Groth16Verifier.sol` is generated and compiles with Forge
- [ ] DarkPoolRouter constructor takes 3 params (custody, engine, zkVerifier)
- [ ] All 20 existing tests still pass (with MockZKVerifier)
- [ ] New proveAndSettle tests pass (with MockZKVerifier)
- [ ] `npm run build` succeeds in `app/server/` (snarkjs types resolve)
- [ ] Proto generates without errors after field changes
- [ ] Warlock builds: `go build ./...` from `warlock/`
- [ ] Settlement worker loads circuit artifacts at startup
- [ ] Proof generation takes < 2 seconds for test inputs
- [ ] Generated proof verifies in JS: `snarkjs.groth16.verify(vkey, publicSignals, proof)`
- [ ] On-chain verification works in Foundry test with real proof (optional — can be E2E)

---

## Part 8: File Inventory

New files:
- `circuits/settlementMatch.circom` — The ZK circuit
- `circuits/build.sh` — Compile + setup script
- `circuits/package.json` — circomlib dependency
- `circuits/build/` — Compiled artifacts (generated)
- `contracts/src/Groth16Verifier.sol` — Auto-generated Solidity verifier
- `contracts/src/interfaces/IZKVerifier.sol` — Verifier interface
- `app/server/src/services/proofGenerator.ts` — Backend proof generation
- `app/server/src/services/engineWallet.ts` — Engine wallet client for on-chain txs
- `app/server/src/types/snarkjs.d.ts` — TypeScript types for snarkjs
- `app/server/circuits/` — Circuit WASM + proving key (generated)
- `warlock/migrations/003_zk_order_fields.up.sql` — DB migration
- `warlock/migrations/003_zk_order_fields.down.sql` — Down migration

Modified files:
- `contracts/src/DarkPoolRouter.sol` — Add `proveAndSettle`, `zkVerifier`, updated constructor
- `contracts/test/DarkPoolRouter.t.sol` — MockZKVerifier, updated setUp, new tests
- `warlock/pkg/api/proto/warlock.proto` — Add order_id/sell_amount/min_buy_amount fields
- `warlock/internal/grpc/server.go` — Store new fields in INSERT
- `app/server/src/services/settlementWorker.ts` — Add proof gen + on-chain calls
- `app/server/src/routes/orders.ts` — Pass new fields to warlockClient (if not already)
- `app/server/package.json` — Add snarkjs dependency
- `.env.example` — Add missing env vars

---

## Ordering & Dependencies

```
1. DB migration (003) ← standalone, do first
2. Proto + Go update ← depends on migration
3. Install Circom toolchain + circomlib ← standalone
4. Write circuit + compile + trusted setup ← depends on toolchain
5. Generate Solidity verifier ← depends on circuit
6. Contract updates (IZKVerifier, constructor, proveAndSettle) ← depends on verifier
7. Update existing tests + add new tests ← depends on contract updates
8. Install snarkjs in backend ← standalone
9. Proof generator service ← depends on circuit artifacts + snarkjs
10. Engine wallet service ← standalone
11. Settlement worker wiring ← depends on 9, 10, and contract deployment
```

Steps 1-2 and 3-5 can be done in parallel. Steps 6-7 and 8-10 can be done in parallel. Step 11 is the final integration.
