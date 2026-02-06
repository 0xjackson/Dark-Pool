# Dark Pool Implementation Plan

## Overview

Dark Pool is a private, peer-to-peer trading protocol for large crypto trades. Users can submit encrypted orders that get matched privately, with settlement happening atomically through Yellow Network. The system provides MEV protection through commit-reveal privacy and slippage protection through on-chain constraints.

**Key design decision:** No EIP-712 signatures. User authorization is proven entirely through the on-chain `depositAndCommit` transaction — `msg.sender` is baked into the commitment hash, making separate signatures redundant.

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
| Contracts | Solidity + Foundry | DarkPoolRouter, commitments |
| Settlement | Yellow Network App Sessions | Atomic P2P transfers |
| Custody | Yellow Custody Contract | Fund management |

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
| First time (new token) | 2 — `approve` + `depositAndCommit` |
| Returning user (has approval) | 1 — `depositAndCommit` |
| User with existing Yellow balance | 1 — `commitOnly` |

### How Authorization Works

No EIP-712 signatures needed. When the user calls `depositAndCommit`, `msg.sender` is recorded in the commitment. The order hash is `keccak256(abi.encode(OrderDetails))` where `OrderDetails` includes the user's address:

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
// 1. Compute order hash matching contract's keccak256(abi.encode(OrderDetails))
const orderHash = keccak256(
  encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' },
     { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
    [orderId, address, sellToken, buyToken, sellAmount, minBuyAmount, expiresAt]
  )
);

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

// Recompute hash from submitted details
const expectedHash = computeOrderHash(orderId, user, sellToken, buyToken, ...);

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
await router.revealAndSettle(sellerOrderId, buyerOrderId, sellerDetails, buyerDetails);
// Contract checks: active status, hash match, expiry, token match, slippage

// PHASE 2: YELLOW APP SESSION (atomic P2P swap)
const session = await yellowSDK.createAppSession({ ... });
await yellowSDK.closeAppSession({ ... }); // swapped allocations

// PHASE 3: FINALIZE
await router.markFullySettled(sellerOrderId, buyerOrderId);
```

### What revealAndSettle Verifies

1. Both orders are `Active`
2. `keccak256(abi.encode(seller)) == sellerC.orderHash` (hash integrity)
3. `keccak256(abi.encode(buyer)) == buyerC.orderHash`
4. Neither order has expired
5. Tokens match cross-wise (seller.sell = buyer.buy)
6. Slippage constraints met (each side gets >= minBuyAmount)

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

    enum Status { None, Active, Settling, Settled, Cancelled }

    struct Commitment {
        address user;
        bytes32 orderHash;
        uint256 timestamp;
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
    function revealAndSettle(bytes32 sellerOrderId, bytes32 buyerOrderId, OrderDetails calldata seller, OrderDetails calldata buyer) external;
    function markFullySettled(bytes32 sellerOrderId, bytes32 buyerOrderId) external;
}
```

---

## Security

### MEV Protection
- Orders hidden via commit-reveal
- Matching is off-chain and private
- Settlement is P2P (no pool to sandwich)
- Reveal + settle is atomic

### Order Book Poisoning Prevention
- Backend reads on-chain commitment hash via RPC before accepting order
- Recomputes `keccak256(abi.encode(OrderDetails))` from submitted data
- Rejects if hash doesn't match — attacker can't fake a commitment

### Slippage Protection
- `minBuyAmount` enforced on-chain in `revealAndSettle`
- Cannot settle below user's minimum

### Replay Protection
- Order status tracked (Active → Settling → Settled)
- Cannot reuse commitments
- `require(status == Status.None, "Order exists")` prevents double-commit

### Funds Safety
- Funds held in Yellow Custody (audited)
- User can always cancel active orders
- User can always withdraw from Yellow

---

## Signature Summary

| Action | Wallet Interactions |
|--------|---------------------|
| First deposit + order | 2 (approve + depositAndCommit) |
| Subsequent orders (has approval) | 1 (depositAndCommit) |
| Order with existing Yellow balance | 1 (commitOnly) |
| Cancel order | 1 (cancel tx) |
| Withdraw | 1 (withdraw tx) |

---

## Open Questions

### 1. App Session Signatures
Yellow requires participants with non-zero allocations to sign session creation. Need to confirm if governance model `[weights: 0,0,100, quorum: 100]` allows engine-only signing.

### 2. Multi-Chain Support
Starting with single chain. Add multi-chain later.

### 3. Yellow App Sessions Integration
App Sessions (not State Channels) are required for P2P trading. Settlement integration is the next major piece.
