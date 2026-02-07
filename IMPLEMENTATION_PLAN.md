# Dark Pool Implementation Plan

## Overview

Dark Pool is a private, peer-to-peer trading protocol for large crypto trades. Users can submit encrypted orders that get matched privately, with settlement happening atomically through Yellow Network. The system provides MEV protection through commit-reveal privacy and slippage protection through on-chain constraints.

**Key design decision:** No EIP-712 signatures for order authorization. User authorization is proven through the on-chain `depositAndCommit` transaction — `msg.sender` is baked into the commitment hash. The only EIP-712 signature is for Yellow Network session key authorization (once per 30-day session), which delegates limited settlement authority to the engine.

> **Settlement architecture is fully defined in [SETTLEMENT_IMPLEMENTATION.md](./SETTLEMENT_IMPLEMENTATION.md)** — covers session keys, App Sessions, the Judge governance model, engine authentication, asset identifiers, balance querying, and the complete fund flow with code-level references. **All design questions are resolved.**

---

## Architecture Summary

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│  ┌──────────┐     ┌──────────────┐     ┌─────────────┐                 │
│  │    UI    │────►│   Backend    │────►│   Warlock   │                 │
│  │ (Next.js)│◄────│   (Node)     │◄────│  (Go gRPC)  │                 │
│  └──────────┘     └──────────────┘     └─────────────┘                 │
│       │                  │                    │                         │
│       │                  ▼                    ▼                         │
│       │           ┌──────────┐         ┌───────────┐                   │
│       │           │ Database │         │  Yellow   │                   │
│       │           │(Postgres)│         │  Network  │                   │
│       │           └──────────┘         └───────────┘                   │
│       │                                      │                         │
│       │                                ┌───────────┐                   │
│       └───────────────────────────────►│  Router   │                   │
│              approve + depositAndCommit │ Contract  │                   │
│                                        └───────────┘                   │
│                                              │                         │
│                                        ┌───────────┐                   │
│                                        │  Custody  │                   │
│                                        │ Contract  │                   │
│                                        └───────────┘                   │
│                              User's Wallet                              │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| Frontend | Next.js 14 + wagmi v2 + RainbowKit v2 | Wallet connection, UI |
| Backend | Node.js + Express + WebSocket | API, order verification, Yellow SDK |
| Matching Engine | Warlock (Go + gRPC) | Private orderbook matching |
| Database | PostgreSQL | Order storage, history |
| Contracts | Solidity + Foundry | DarkPoolRouter, commitments, ZK verifier |
| ZK Proofs | Circom + Groth16 + Poseidon | Private settlement (no order detail reveal) |
| Settlement | Yellow Network App Sessions | Atomic P2P transfers (cross-chain via unified balance) |
| Custody | Yellow Custody Contract | Fund management (deployed on multiple chains) |

---

## Complete User Flow

```
┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌───────┐
│ APPROVE │───►│ DEPOSIT │───►│  MATCH  │───►│ SETTLE  │───►│WITHDRAW│
│(1st time)│   │+ COMMIT │    │         │    │         │    │       │
└─────────┘    └─────────┘    └─────────┘    └─────────┘    └───────┘
```

---

## Step 1: Approve + Deposit + Commit (User Action)

The user deposits tokens and commits the order hash in a single on-chain call. First-time users also need to approve the router.

### Wallet Interactions

| Scenario | Signatures |
|----------|-----------|
| First time ever (new token) | 3 — `approve` + EIP-712 session key auth + `depositAndCommit` |
| First trade in session (has approval) | 2 — EIP-712 session key auth + `depositAndCommit` |
| Subsequent trades (active session key) | 1 — `depositAndCommit` |
| User with existing Yellow balance | 1 — `commitOnly` |

### How Authorization Works

No EIP-712 signatures needed. When the user calls `depositAndCommit`, `msg.sender` is recorded in the commitment. The order hash is `poseidon(OrderDetails)` (Poseidon hash for ZK compatibility) where `OrderDetails` includes the user's address:

```solidity
struct OrderDetails {
    bytes32 orderId;
    address user;       // ← msg.sender, baked into hash
    address sellToken;
    address buyToken;
    uint256 sellAmount;
    uint256 minBuyAmount;
    uint256 expiresAt;
}
```

The hash alone proves: who placed the order, what tokens, what amounts, and when it expires. No separate signature can add anything the hash doesn't already cover.

### Frontend Flow (useSubmitTrade hook)

```typescript
// 1. Compute order hash using Poseidon (ZK-friendly hash, enables private settlement)
// Poseidon produces the same bytes32 commitment but can be verified inside a ZK circuit
// in ~250 constraints vs keccak256's ~150,000 — enabling sub-second proof generation
import { buildPoseidon } from 'circomlibjs';
const poseidon = await buildPoseidon();
const orderHash = poseidon([orderId, address, sellToken, buyToken, sellAmount, minBuyAmount, expiresAt]);

// 2. Check allowance, approve if needed (MaxUint256 = one-time)
if (allowance < sellAmount) {
  await walletClient.writeContract({
    address: sellToken, abi: ERC20_ABI,
    functionName: 'approve', args: [ROUTER_ADDRESS, maxUint256],
  });
}

// 3. Deposit + commit on-chain
await walletClient.writeContract({
  address: ROUTER_ADDRESS, abi: ROUTER_ABI,
  functionName: 'depositAndCommit',
  args: [sellToken, sellAmount, orderId, orderHash],
});

// 4. Send order details to backend (private, over HTTPS)
await submitOrder(orderRequest);
```

### Anti-Poisoning: On-Chain Verification

The backend verifies the submitted order details match the on-chain commitment before accepting:

```typescript
// Backend reads commitment from DarkPoolRouter via RPC (~50ms)
const commitment = await contract.commitments(orderId);

// Recompute Poseidon hash from submitted details (same hash function as frontend)
const expectedHash = poseidon([orderId, user, sellToken, buyToken, sellAmount, minBuyAmount, expiresAt]);

// If hash doesn't match, reject — prevents order book poisoning
if (expectedHash !== commitment.orderHash) {
  return res.status(403).json({ error: 'Commitment mismatch' });
}
```

---

## Step 2: Matching (Off-Chain)

Matching happens in the Warlock engine (Go/gRPC). Orders are private until settlement.

### Matching Logic

```
Warlock receives order via gRPC
    ↓
Checks for compatible counterparty:
  - Tokens match (seller.sell = buyer.buy)
  - Neither expired
  - buyer.sellAmount >= seller.minBuyAmount
  - seller.sellAmount >= buyer.minBuyAmount
    ↓
Match found → trigger settlement
```

---

## Step 3: Settlement

When a match is found, settlement happens in two phases:
1. On-chain verification (reveal + validate)
2. Yellow App Session (atomic swap)

### Settlement Flow

```typescript
// PHASE 1: ON-CHAIN VERIFICATION (engine calls contract)
// With ZK (production) — order details stay private:
const proof = await snarkjs.groth16.fullProve(inputs, wasmPath, zkeyPath);
await router.proveAndSettle(sellerOrderId, buyerOrderId, sellerFillAmount, buyerFillAmount, proof);

// Without ZK (fallback/testing):
await router.revealAndSettle(sellerOrderId, buyerOrderId, sellerDetails, buyerDetails, sellerFillAmount, buyerFillAmount);

// PHASE 2: YELLOW APP SESSION (atomic P2P swap)
const session = await yellowSDK.createAppSession({ ... });   // per partial fill
await yellowSDK.closeAppSession({ ... });                     // swapped allocations

// PHASE 3: FINALIZE (per order, when fully filled)
await router.markFullySettled(orderId);
```

### What proveAndSettle Verifies (via ZK proof)

1. Both commitment hashes match order details (Poseidon hash, private)
2. Neither order has expired
3. Tokens match cross-wise (seller.sell = buyer.buy)
4. Fill amounts don't exceed remaining (supports partial fills)
5. Proportional slippage constraints met (rate-based, not total-based)

All verified cryptographically — order details never appear on-chain.

### What revealAndSettle Verifies (fallback, order details public)

1. Both orders are `Active`
2. `poseidon(seller.*) == sellerC.orderHash` (hash integrity, via `poseidon-solidity` on-chain library)
3. `poseidon(buyer.*) == buyerC.orderHash`
4. Neither order has expired
5. Tokens match cross-wise (seller.sell = buyer.buy)
6. Fill amounts don't exceed remaining (partial fill support)
7. Proportional slippage constraints met

### Why MEV Can't Attack

- Orders hidden via commit-reveal (public sees meaningless hash)
- Matching is off-chain and private
- Settlement is P2P (no pool to sandwich)
- By the time reveal happens, trade is already being settled

---

## Smart Contract: DarkPoolRouter.sol

```solidity
contract DarkPoolRouter {
    using SafeERC20 for IERC20;

    IYellowCustody public immutable custody;
    address public immutable engine;

    mapping(bytes32 => Commitment) public commitments;

    enum Status { None, Active, Settled, Cancelled }

    struct Commitment {
        address user;
        bytes32 orderHash;
        uint256 timestamp;
        uint256 settledAmount;   // tracks cumulative fills (partial fill support)
        Status status;
    }

    struct OrderDetails {
        bytes32 orderId;
        address user;
        address sellToken;
        address buyToken;
        uint256 sellAmount;
        uint256 minBuyAmount;
        uint256 expiresAt;
    }

    // User functions
    function depositAndCommit(address token, uint256 depositAmount, bytes32 orderId, bytes32 orderHash) external;
    function commitOnly(bytes32 orderId, bytes32 orderHash) external;
    function cancel(bytes32 orderId) external;

    // Engine functions
    function proveAndSettle(bytes32 sellerOrderId, bytes32 buyerOrderId, uint256 sellerFillAmount, uint256 buyerFillAmount, bytes calldata proof) external;
    function revealAndSettle(bytes32 sellerOrderId, bytes32 buyerOrderId, OrderDetails calldata seller, OrderDetails calldata buyer, uint256 sellerFillAmount, uint256 buyerFillAmount) external;
    function markFullySettled(bytes32 orderId) external;
}
```

---

## Security

### MEV Protection
- Orders hidden via commit-reveal (Poseidon hash commitment)
- Matching is off-chain and private
- Settlement is P2P (no pool to sandwich)
- ZK proof settlement keeps order details private even after settlement (no reveal)
- `revealAndSettle` fallback reveals details, but matching is already complete

### Order Book Poisoning Prevention
- Backend reads on-chain commitment hash via RPC before accepting order
- Recomputes `poseidon(OrderDetails)` from submitted data (same hash as frontend and ZK circuit)
- Rejects if hash doesn't match — attacker can't fake a commitment

### Slippage Protection
- `minBuyAmount` enforced on-chain in `revealAndSettle`
- Cannot settle below user's minimum

### Replay Protection
- Order status tracked (Active → Settled)
- `settledAmount` tracks cumulative fills, prevents overfilling
- Cannot reuse commitments
- `require(status == Status.None, "Order exists")` prevents double-commit

### Funds Safety
- Funds held in Yellow Custody (audited)
- User can always cancel active orders
- User can always withdraw from Yellow

---

## Signature Summary

### User Signatures

| Action | Wallet Interactions |
|--------|---------------------|
| First ever (new token, new session) | 3 (approve + EIP-712 session key auth + depositAndCommit) |
| First trade in session | 2 (EIP-712 session key auth + depositAndCommit) |
| Subsequent trades (active session key) | 1 (depositAndCommit) |
| Order with existing Yellow balance | 1 (commitOnly) |
| Cancel order | 1 (cancel tx) |
| Check balance | 0 (on-chain view function, no auth) |
| Withdraw | 1 (custody.withdrawal tx) |

### Engine Signatures (per settlement, automated)

| Action | Key Used | Purpose |
|--------|----------|---------|
| Generate ZK proof | N/A (computation, not signing) | Prove settlement validity without revealing order details |
| `proveAndSettle` tx | Engine wallet | On-chain verification gate (ZK proof, no order details revealed) |
| App Session create (seller sig) | Seller's stored session key | Fund-owner consent |
| App Session create (buyer sig) | Buyer's stored session key | Fund-owner consent |
| App Session close | Engine session key | Swap allocations (weight 100) |
| `markFullySettled` tx | Engine wallet | On-chain finalization (per order) |

---

## Resolved Questions

### 1. App Session Signatures — RESOLVED
"Game with Judge" governance model: `weights: [0, 0, 100]`, `quorum: 100`, `challenge: 0`. Users' session keys sign creation (fund-owner consent for non-zero allocations). Engine signs close alone (weight 100 meets quorum). Engine collects both user signatures server-side using stored session key private keys. See [SETTLEMENT_IMPLEMENTATION.md](./SETTLEMENT_IMPLEMENTATION.md).

### 2. Multi-Chain Support
Starting with single chain. Add multi-chain later.

### 3. Yellow App Sessions Integration — RESOLVED
Full settlement flow designed and all technical details confirmed with code-level references. See [SETTLEMENT_IMPLEMENTATION.md](./SETTLEMENT_IMPLEMENTATION.md).

### 4. Engine Authentication — RESOLVED
Engine authenticates as itself with Yellow (`application: "clearnode"`, empty allowances, 1yr expiry). Maintains one persistent WS connection. Messages signed by user session keys are sent over engine's connection — Yellow validates signatures, not sender identity. Confirmed in Clearnode source.

### 5. Asset Identifiers — RESOLVED
App Sessions use lowercase string symbols (`"usdc"`, `"weth"`), not token addresses. Engine queries `get_assets` at boot to build a token-address-to-symbol map.

### 6. Balance Querying — RESOLVED
`Custody.getAccountsBalances()` is a public on-chain view function. No JWT, no WS, no auth. Direct `eth_call`.

### 7. Session Key Expiry — RESOLVED
30 days, no enforced maximum. Explicit revocation via `revoke_session_key` when user logs out or all orders filled. JWT (24h) is separate and irrelevant for settlement.

### 8. BN128 Field Bounds — RESOLVED
All ZK circuit inputs must be < SNARK_SCALAR_FIELD (~2^254). No limb splitting needed: Poseidon outputs are field elements (always fit), practical amounts < 2^128, addresses 160-bit, timestamps tiny. Only `orderId` needs explicit handling — mask to 253 bits. See [SETTLEMENT_IMPLEMENTATION.md](./SETTLEMENT_IMPLEMENTATION.md).

### 9. On-Chain Poseidon for Fallback — RESOLVED
`revealAndSettle` uses `poseidon-solidity` library for on-chain hash verification. Both `proveAndSettle` (ZK) and `revealAndSettle` (fallback) verify against the same Poseidon commitment. See [SETTLEMENT_IMPLEMENTATION.md](./SETTLEMENT_IMPLEMENTATION.md).
