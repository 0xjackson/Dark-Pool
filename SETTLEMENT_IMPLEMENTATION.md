# Settlement Implementation Plan

## Context

The Dark Pool currently handles everything up to matching: users deposit, commit order hashes on-chain, and Warlock matches compatible orders. But after a match is found, nothing happens — funds sit in custody and `settlement_status` stays `PENDING` forever.

This document describes the complete settlement architecture using Yellow Network's App Sessions, Session Keys, and the Nitrolite SDK (`@erc7824/nitrolite`).

**All design questions are resolved.** This document is the authoritative reference for implementation.

---

## Architecture Overview

```
                    USER ONLINE (2 sigs max)                     ENGINE ONLY (automated)
               ┌──────────────────────────┐        ┌──────────────────────────────┐
               │                          │        │                              │
               │  ┌────────────────────┐  │        │   ┌───────────────┐          │
               │  │  Session Key Auth  │  │        │   │    Match      │          │
               │  │  (EIP-712, once    │  │        │   │   (Warlock)   │          │
               │  │   per 30-day       │  │        │   └───────┬───────┘          │
               │  │   session)         │  │        │           │                  │
               │  └────────┬───────────┘  │        │           ▼                  │
               │           │              │        │   ┌───────────────┐          │
               │  ┌────────▼───────────┐  │        │   │revealAndSettle│          │
               │  │ depositAndCommit   │  │        │   │  (on-chain    │          │
               │  │ (on-chain, single  │  │        │   │   verification│          │
               │  │  tx: deposit to    │  │        │   │   gate)       │          │
               │  │  user's custody +  │  │        │   └───────┬───────┘          │
               │  │  store commitment) │  │        │           │                  │
               │  └────────────────────┘  │        │           ▼                  │
               │                          │        │   ┌───────────────┐          │
               │  User walks away         │        │   │ Create App    │          │
               │                          │        │   │ Session       │          │
               └──────────────────────────┘        │   │ (engine signs │          │
                                                   │   │  w/ stored    │          │
                                                   │   │  session keys)│          │
                                                   │   └───────┬───────┘          │
                                                   │           │                  │
                                                   │           ▼                  │
                                                   │   ┌───────────────┐          │
                                                   │   │ Close Session │          │
                                                   │   │ (engine signs │          │
                                                   │   │  alone, swaps │          │
                                                   │   │  allocations) │          │
                                                   │   └───────┬───────┘          │
                                                   │           │                  │
                                                   │           ▼                  │
                                                   │   ┌───────────────┐          │
                                                   │   │markFullySettled│         │
                                                   │   │  (on-chain)   │          │
                                                   │   └───────────────┘          │
                                                   │                              │
                                                   └──────────────────────────────┘

                                                   Users withdraw from unified
                                                   balance whenever they want
                                                   (on-chain call, no auth needed).
```

---

## User Experience: Signature Count

### First Time Ever (new token)

| # | Action | Type |
|---|--------|------|
| 1 | Approve Router to spend token | On-chain tx |
| 2 | EIP-712 session key authorization | Off-chain sig (no gas) |
| 3 | `depositAndCommit()` | On-chain tx |

3 wallet popups, but approve is a one-time action per token.

### First Trade in Session

| # | Action | Type |
|---|--------|------|
| 1 | EIP-712 session key authorization | Off-chain sig (no gas) |
| 2 | `depositAndCommit()` | On-chain tx |

**2 wallet popups.** Session key auth happens once at wallet connect — covers all trades for 30 days.

### Subsequent Trades (active session key)

| # | Action | Type |
|---|--------|------|
| 1 | `depositAndCommit()` | On-chain tx |

**1 wallet popup.** Session key is already active.

### Withdraw (whenever)

| # | Action | Type |
|---|--------|------|
| 1 | `custody.withdrawal()` | On-chain tx |

---

## Contract: DarkPoolRouter.sol (IMPLEMENTED)

### IYellowCustody Interface

The Yellow Custody contract's `deposit` function takes an `account` parameter, allowing the Router to credit a specific user's unified balance:

```solidity
// contracts/src/interfaces/IYellowCustody.sol
interface IYellowCustody {
    function deposit(address account, address token, uint256 amount) external payable;
}
```

Source reference: `.reference/nitrolite/sdk/src/abis/generated.ts` — confirmed the `account` parameter exists in the canonical ABI.

### depositAndCommit

```solidity
// contracts/src/DarkPoolRouter.sol
uint256 constant SNARK_SCALAR_FIELD =
    21888242871839275222246405745257275088548364400416034343698204186575808495617;

function depositAndCommit(address token, uint256 depositAmount, bytes32 orderId, bytes32 orderHash) external {
    require(commitments[orderId].status == Status.None, "Order exists");

    // Defensive: ensure orderId and orderHash fit in BN128 scalar field for ZK compatibility.
    // Poseidon hashes are field elements by construction. orderId must be masked to 253 bits
    // by the frontend. Practical amounts (< 2^128) always fit.
    require(uint256(orderId) < SNARK_SCALAR_FIELD, "orderId exceeds field");
    require(uint256(orderHash) < SNARK_SCALAR_FIELD, "orderHash exceeds field");

    IERC20(token).safeTransferFrom(msg.sender, address(this), depositAmount);

    IERC20(token).approve(address(custody), depositAmount);
    custody.deposit(msg.sender, token, depositAmount);  // credits USER's balance

    commitments[orderId] =
        Commitment({user: msg.sender, orderHash: orderHash, timestamp: block.timestamp, settledAmount: 0, status: Status.Active});

    emit OrderCommitted(orderId, msg.sender, orderHash);
}
```

`commitOnly()` and `cancel()` are unchanged. `revealAndSettle()` and `markFullySettled()` are updated for partial fills and ZK — see below.

---

## Partial Fill Support

Orders can match partially. If User A sells 100 ETH and User B buys 60 ETH, a match is created for 60 ETH. User A's remaining 40 ETH stays active for future matching.

### Contract Changes for Partial Fills

```solidity
struct Commitment {
    address user;
    bytes32 orderHash;
    uint256 timestamp;
    uint256 settledAmount;    // tracks cumulative filled amount
    Status status;            // Active until fully settled or cancelled
}

// Settling status removed — each match is tracked off-chain in matches table
enum Status { None, Active, Settled, Cancelled }
```

`revealAndSettle` (or `proveAndSettle` with ZK) accepts fill amounts per match:
- Verifies fill amounts don't exceed remaining (`sellAmount - settledAmount`)
- Uses proportional slippage: `buyerFillAmount * seller.sellAmount >= sellerFillAmount * seller.minBuyAmount`
- Increments `settledAmount` for each side
- Order stays `Active` until fully filled

`markFullySettled` operates per-order (not per-pair) since two sides may complete at different times.

`cancel` is allowed on partially filled orders — cancels the unfilled remainder.

### Warlock Already Supports Partial Fills

The matching engine handles partial fills natively:
- `matchQty = min(incomingOrder.RemainingQuantity, candidate.RemainingQuantity)` (`algorithm.go:88`)
- Orders transition to `PARTIALLY_FILLED` status and remain matchable
- A single order can match against multiple counterparties sequentially

### Each Partial Match = Separate App Session

Yellow App Sessions don't support partial close. Each partial fill creates a separate App Session:
- Match 1 (60 ETH): create session → close with swapped allocations
- Match 2 (40 ETH): create new session → close with swapped allocations
- User's remaining balance stays in Yellow unified custody between fills

---

## ZK Private Settlement (Planned — Circom + Groth16 + Poseidon)

### Why ZK

`revealAndSettle` requires order details as public calldata to verify the commitment hash. With partial fills, this reveals the full order (total size, price limits, remaining amount) on the first fill. ZK eliminates the reveal entirely — the engine proves the settlement is valid without showing order details.

### Stack: Circom + Groth16 + Poseidon

| Component | Choice | Why |
|-----------|--------|-----|
| Circuit language | **Circom** | Most battle-tested on Ethereum (Tornado Cash, WorldID, Semaphore) |
| Proof system | **Groth16** | Cheapest on-chain verification (~200k gas, constant) |
| Hash function | **Poseidon** | ZK-friendly (~250 constraints vs keccak256's ~150,000) |
| JS prover | **snarkjs** | Native Node.js, no external binary needed |
| Solidity verifier | **Auto-generated** | `snarkjs generateverifier` outputs a Solidity contract |
| Frontend hash | **circomlibjs** | Poseidon computation in JS, same BN128 field |
| On-chain hash | **poseidon-solidity** | Poseidon computation in Solidity (for `revealAndSettle` fallback verification) |

### Commitment Hash: keccak256 → Poseidon

Poseidon is a hash designed for ZK circuits — ~250 constraints vs keccak256's ~150,000. Same cryptographic security.

```
// Current (to be replaced)
orderHash = keccak256(abi.encode(orderId, user, sellToken, buyToken, sellAmount, minBuyAmount, expiresAt))

// Production (Poseidon everywhere)
orderHash = poseidon(orderId, user, sellToken, buyToken, sellAmount, minBuyAmount, expiresAt)
```

**The contract's `depositAndCommit` doesn't change** — it stores a `bytes32` hash without computing it. The hash function change is in the frontend (order submission), backend (commitment verification), and `revealAndSettle` on-chain verification (uses `poseidon-solidity` library).

### BN128 Field Bounds

Poseidon and Groth16 operate over the BN128 scalar field (~254 bits):

```
SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617 ≈ 2^254
```

All circuit inputs must be less than this value. This is naturally satisfied:

- **Poseidon hash outputs** — always field elements, always < `SNARK_SCALAR_FIELD` by construction
- **ERC-20 amounts** — practically < 2^128 (even USDT total supply is ~2^100)
- **Addresses** — 160 bits, always fits
- **Timestamps** — ~32 bits, always fits

**One value needs explicit handling:** `orderId` is currently generated via `keccak256(...)` which produces a full 256-bit value (~50% chance of exceeding the field). The snarkjs-generated verifier **rejects** inputs >= `SNARK_SCALAR_FIELD`.

**Fix:** Mask orderId to 253 bits (always < field modulus, still ~10^76 unique IDs):

```typescript
const raw = keccak256(encodeAbiParameters([...], [address, timestamp, nonce]));
const orderId = BigInt(raw) & ((1n << 253n) - 1n);  // always < SNARK_SCALAR_FIELD
```

The contract adds a defensive `require` for belt-and-suspenders safety (see `depositAndCommit` below).

### Poseidon Output → bytes32 Conversion

Poseidon produces a field element (~254 bits), stored as `bytes32` with the top 2 bits always zero. Canonical conversion:

```typescript
// Frontend/Backend (circomlibjs)
const poseidon = await buildPoseidon();
const hash = poseidon([orderId, user, sellToken, buyToken, sellAmount, minBuyAmount, expiresAt]);
const orderHash = '0x' + poseidon.F.toString(hash, 16).padStart(64, '0');  // bytes32
```

No special handling needed — `bytes32` can store 254-bit values. The hash just happens to never use the full 256-bit range.

### The ZK Circuit

```
PRIVATE INPUTS (witness — never revealed on-chain):
  - seller OrderDetails { orderId, user, sellToken, buyToken, sellAmount, minBuyAmount, expiresAt }
  - buyer OrderDetails  { same fields }

PUBLIC INPUTS (visible on-chain):
  - sellerCommitmentHash, buyerCommitmentHash (from contract storage)
  - sellerFillAmount, buyerFillAmount (match amounts)
  - sellerSettledSoFar, buyerSettledSoFar (cumulative settled)
  - currentTimestamp

CIRCUIT PROVES:
  1. poseidon(seller.*) == sellerCommitmentHash        // commitment integrity
  2. poseidon(buyer.*)  == buyerCommitmentHash         // commitment integrity
  3. seller.sellToken == buyer.buyToken                 // token match
  4. seller.buyToken  == buyer.sellToken                // token match
  5. currentTimestamp < seller.expiresAt                // not expired
  6. currentTimestamp < buyer.expiresAt                 // not expired
  7. sellerFillAmount <= seller.sellAmount - sellerSettledSoFar  // no overfill
  8. buyerFillAmount  <= buyer.sellAmount  - buyerSettledSoFar   // no overfill
  9. buyerFillAmount * seller.sellAmount >= sellerFillAmount * seller.minBuyAmount   // seller slippage
  10. sellerFillAmount * buyer.sellAmount >= buyerFillAmount * buyer.minBuyAmount    // buyer slippage
```

Circuit size: ~5,000–10,000 constraints. Proof generation: <1 second. On-chain verification: ~200k gas.

### Contract: `proveAndSettle`

```solidity
uint256 constant SNARK_SCALAR_FIELD =
    21888242871839275222246405745257275088548364400416034343698204186575808495617;

function proveAndSettle(
    bytes32 sellerOrderId,
    bytes32 buyerOrderId,
    uint256 sellerFillAmount,
    uint256 buyerFillAmount,
    bytes calldata proof
) external {
    require(msg.sender == engine, "Only engine");

    Commitment storage sellerC = commitments[sellerOrderId];
    Commitment storage buyerC = commitments[buyerOrderId];

    require(sellerC.status == Status.Active, "Seller not active");
    require(buyerC.status == Status.Active, "Buyer not active");

    // All public inputs must be < SNARK_SCALAR_FIELD for Groth16 verification.
    // Poseidon hashes are field elements (always < field by construction).
    // Practical ERC-20 amounts are always < 2^128, well within the field.
    // block.timestamp is ~32 bits, always fits.
    // The snarkjs-generated verifier also checks this, but we guard here for clarity.
    uint256[] memory publicInputs = new uint256[](7);
    publicInputs[0] = uint256(sellerC.orderHash);   // Poseidon output, always < field
    publicInputs[1] = uint256(buyerC.orderHash);    // Poseidon output, always < field
    publicInputs[2] = sellerFillAmount;
    publicInputs[3] = buyerFillAmount;
    publicInputs[4] = sellerC.settledAmount;
    publicInputs[5] = buyerC.settledAmount;
    publicInputs[6] = block.timestamp;

    require(zkVerifier.verify(proof, publicInputs), "Invalid proof");

    sellerC.settledAmount += sellerFillAmount;
    buyerC.settledAmount += buyerFillAmount;

    emit OrdersSettling(sellerOrderId, buyerOrderId);
}
```

No OrderDetails in calldata. No reveal. Order details stay private through the entire fill lifecycle.

**Why no limb splitting is needed:** Poseidon hashes are field elements (~254 bits), always < `SNARK_SCALAR_FIELD`. Practical ERC-20 amounts are < 2^128. Timestamps are tiny. All values naturally fit in the BN128 scalar field. The contract adds a defensive `require(uint256(orderHash) < SNARK_SCALAR_FIELD)` in `depositAndCommit` for belt-and-suspenders safety (see above).

### What's Visible vs Hidden On-Chain

| | Without ZK | With ZK |
|---|---|---|
| Commitment hash | Visible (opaque) | Same |
| Total order size | **Revealed at first settle** | **Hidden forever** |
| Price limits / minBuyAmount | **Revealed at first settle** | **Hidden forever** |
| Token pair | **Revealed at first settle** | **Hidden forever** |
| Fill amounts per match | Visible | Visible |
| Remaining unfilled amount | **Computable after reveal** | **Unknown** |

### `revealAndSettle` Stays as Fallback

Both functions coexist:
- `proveAndSettle` — private settlement with ZK proof (production path)
- `revealAndSettle` — non-private fallback for debugging, testing, or if ZK proof generation fails

**Critical:** `revealAndSettle` recomputes the commitment hash on-chain to verify order details. Since commitments are now Poseidon hashes, this requires the `poseidon-solidity` library (`forge install poseidon-solidity/poseidon-solidity`). The fallback verifies:

```solidity
import {PoseidonT8} from "poseidon-solidity/PoseidonT8.sol";

// In revealAndSettle:
bytes32 sellerHash = bytes32(PoseidonT8.hash([
    uint256(seller.orderId), uint256(uint160(seller.user)),
    uint256(uint160(seller.sellToken)), uint256(uint160(seller.buyToken)),
    seller.sellAmount, seller.minBuyAmount, seller.expiresAt
]));
require(sellerHash == sellerC.orderHash, "Seller hash mismatch");
```

On-chain Poseidon costs ~100k gas per hash — acceptable for a fallback path. The `poseidon-solidity` library is battle-tested (used by Tornado Cash, Semaphore, WorldID).

---

## Cross-Chain Support (via Yellow Network)

### How It Works

Yellow Network provides cross-chain settlement natively via **unified balance abstraction** — no bridges, no wrapped tokens:

1. User A deposits USDC on **Ethereum** → Custody contract locks it → Clearnode credits unified balance
2. User B deposits USDC on **Base** → Custody contract locks it → Clearnode credits unified balance
3. Warlock matches them (chain-agnostic — matching engine doesn't know about chains)
4. Engine settles via App Session using **unified balance** (off-chain, instant)
5. User A withdraws on Ethereum, User B withdraws on Base

The Clearnode manages a double-entry ledger across chains. Off-chain transfers between users don't need on-chain transactions.

### Evidence from Reference Repos

- **Contract deployments** on 12+ chains: `.reference/nitrolite/contract/deployments/` — Ethereum (1), BSC (56), Polygon (137), Base (8453), Linea (59144), plus testnets
- **Unified balance docs**: `.reference/yellow-docs/docs/protocol/glossary.mdx` — "Cross-chain transfers without bridges"
- **SDK types**: `.reference/nitrolite/sdk/src/rpc/types/common.ts` — `RPCAsset` and `RPCChannelUpdate` include `chainId` fields
- **Cerebro CLI**: `.reference/nitrolite/examples/cerebro/README.md` — "orchestrating cross-chain operations"
- **Implementation checklist**: `.reference/yellow-docs/docs/protocol/implementation-checklist.mdx` — requires testing "cross-chain transfers (via unified balance)"

### What We Need to Build

| Component | Change |
|-----------|--------|
| DarkPoolRouter | Deploy on each supported chain (same contract, different addresses) |
| Frontend | Chain selector for deposit/withdrawal |
| Backend | Track which chain each user deposited on |
| Warlock | No change — already chain-agnostic (matches on token pair, not chain) |
| Yellow integration | No change — unified balance handles cross-chain natively |

Cross-chain is mostly a deployment and UX concern, not an architecture change. Yellow does the hard part.

---

## Key Inventory

Every key in the system, who holds it, and what it's used for:

| Key | Held By | Type | Purpose |
|-----|---------|------|----------|
| **User's wallet** | User (MetaMask) | EOA | EIP-712 session key auth, `depositAndCommit`, `cancel`, `withdraw` |
| **User's session key** | Backend (encrypted in `session_keys` table) | ECDSA keypair | Engine signs App Session creation on user's behalf |
| **Engine wallet** (`ENGINE_WALLET_KEY`) | Backend (env var) | EOA | `revealAndSettle` + `markFullySettled` on-chain txs, Yellow Network auth at boot |
| **Engine session key** (`ENGINE_SESSION_KEY`) | Backend (env var) | ECDSA keypair | Signs `closeAppSession` messages (weight 100), authenticates engine's WS connection to Yellow |

---

## Session Key Architecture

### What Session Keys Are

Session keys are delegation — the user says "I authorize this key to act on my behalf on Yellow Network." The backend stores the private key. Later, the engine uses it to sign settlement messages without the user being present.

### Two Separate Expiries (Critical Distinction)

| | Session Key Registration | JWT |
|---|---|---|
| **Created by** | User's EIP-712 signature during auth flow | Yellow Clearnode, after validating the signature |
| **Expiry** | User-specified (we set **30 days**) | **24 hours**, hardcoded by Clearnode |
| **Stored where** | Yellow's DB + in-memory cache (persists across Clearnode restarts) | Our backend DB (backup only) |
| **Used for** | Validating message signatures ("is this session key still authorized to act for this user?") | WS connection auth ("is this connection allowed to send messages?") |
| **Checked when** | Every time a message signed by this key arrives at Yellow | Every time a WS connection authenticates |

**The user's JWT is NOT needed for settlement.** The engine authenticates its own WS connection with its own JWT. User session key validity is checked against the **registration** (30 days), not the JWT (24h).

Source references:
- Session key cache: `.reference/nitrolite/clearnode/session_key.go:48` — `var sessionKeyCache sync.Map`
- Expiry check: `.reference/nitrolite/clearnode/session_key.go:172` — `if isExpired(entry.expiresAt)` checks registration expiry
- JWT TTL: `.reference/nitrolite/clearnode/auth.go:64` — `sessionTTL: 24 * time.Hour` (hardcoded)
- Session key persistence: `.reference/nitrolite/clearnode/session_key.go:51-63` — `loadSessionKeyCache` loads from DB at startup

### Session Key Parameters

```
application:  "dark-pool"
allowances:   [{ asset: "usdc", amount: "10000" }]    // generous, covers multiple trades
expires_at:   now + 30 days (bigint, Unix seconds)     // no enforced maximum
scope:        "app.create"                             // not currently enforced by Clearnode
```

- `expires_at` is `uint64` (seconds) with **no enforced maximum** — only requirement is "must be in the future"
  - Source: `.reference/nitrolite/clearnode/session_key.go:68-72` — only validates `isExpired(expirationTime)`
- `scope` is stored but **not enforced** — future feature
  - Source: `.reference/nitrolite/clearnode/docs/API.md:123` — "This feature is not yet implemented"

### Session Key Lifecycle

```
CREATED    → Backend generates keypair, stores encrypted in DB (status: PENDING)
REGISTERED → Frontend completes Yellow auth flow (status: ACTIVE in our DB, registered in Yellow's DB)
USED       → Engine signs App Session messages with it during settlement
REVOKED    → Engine calls revoke_session_key when user logs out or all orders filled/cancelled
EXPIRED    → 30 days pass (Yellow rejects signatures, our DB marks EXPIRED)
```

Revocation policy:
- **Single order cancel** — do NOT revoke (key covers other orders in the session)
- **User logs out / disconnects** — revoke if no open orders remain
- **All orders filled** — revoke proactively
- **Natural expiry** — 30 days, user must re-authorize if they return

---

## Engine Authentication with Yellow Network

### Why the Engine Authenticates as Itself

The engine needs a WebSocket connection to Yellow to send `create_app_session` and `close_app_session` messages. Rather than authenticating per-user with stored JWTs (which expire in 24h), the engine authenticates as its own entity.

**This works because Yellow validates message signatures independently of WS connection identity.** The Clearnode code extracts signers from the message payload, not the connection:

- `.reference/nitrolite/clearnode/rpc_router_private.go:429` — `rpcSigners, err := c.Message.GetRequestSignersMap()` extracts signers from message
- `.reference/nitrolite/clearnode/app_session_service.go:420` — validates signatures against registered session keys via global cache
- `.reference/nitrolite/clearnode/session_key.go:167-179` — `GetWalletBySessionKey` looks up by address only, no connection binding
- **No middleware anywhere** checks "does the WS sender match the message signer"

### Engine Boot Sequence

```
Engine starts up:

1. Load keys from environment:
   - ENGINE_WALLET_KEY (EOA with ETH for gas)
   - ENGINE_SESSION_KEY (ECDSA keypair for Yellow protocol signing)
   - SESSION_KEY_ENCRYPTION_SECRET (AES-256-GCM key)

2. Connect to Yellow WebSocket:
   wss://clearnet.yellow.com/ws (production)
   wss://clearnet-sandbox.yellow.com/ws (testing)

3. Authenticate with Yellow (3-step flow):
   auth_request({
     address:     engineWallet.address,
     session_key: engineSessionKey.address,
     application: "clearnode",         // root access — bypasses allowance checks
     allowances:  [],                  // empty — engine doesn't spend its own funds
     expires_at:  now + 1 year,
     scope:       ""
   })
   → receive challenge UUID
   → sign EIP-712 with ENGINE_WALLET_KEY (automated, no human)
   → auth_verify(signature) → receive JWT
   → WS connection authenticated ✓

4. Query available assets:
   Send get_assets RPC → build token address ↔ symbol map
   e.g., { "0xA0b8..." → "usdc", "0xC02a..." → "weth" }

5. Start settlement worker (polls DB for PENDING matches)

6. Schedule re-auth every ~23h (engine has its own key, fully automated)
```

**Engine uses `application: "clearnode"` for root access.** This bypasses spending allowance validation entirely — the engine doesn't move its own funds, it just sends signed messages.

Source: `.reference/nitrolite/clearnode/docs/SessionKeys.md:53-64` — session keys with `application: "clearnode"` receive root access, bypassing allowance checks.

The cerebro CLI example (`.reference/nitrolite/examples/cerebro/clearnet/auth.go:24-43`) uses the exact same pattern — a non-user operator authenticating with `application: "clearnode"` and empty allowances.

### Engine as App Session Participant

The engine is participant `[2]` with weight 100 and **zero allocation**. Zero-allocation participants require:

- **No custody balance** — zero amounts skip balance validation entirely
- **No session key registration with Yellow** — not checked for zero-alloc participants
- **No signature on App Session creation** — only non-zero allocation participants must sign

Source: `.reference/nitrolite/clearnode/app_session_service.go:412` — `if alloc.Amount.IsZero() { continue }` skips all validation for zero-allocation participants.

The engine only needs to be listed in the `participants` array with a valid address and weight. When closing, its signature (weight 100) meets quorum (100) alone.

---

## Asset Identifiers

App Session allocations use **lowercase string symbols** (`"usdc"`, `"weth"`), NOT token addresses.

```typescript
// Correct:
{ participant: "0xAlice", asset: "usdc", amount: "1000000000" }

// Wrong:
{ participant: "0xAlice", asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", amount: "1000000000" }
```

Source references:
- SDK type: `.reference/nitrolite/sdk/src/rpc/types/common.ts` — `RPCAppSessionAllocation.asset` is `string` (symbol)
- Clearnode: `.reference/nitrolite/clearnode/rpc_router_private.go` — `AppAllocation.AssetSymbol string`
- Asset config: `.reference/nitrolite/clearnode/config/compose/example/assets.yaml` — maps symbols to per-chain addresses

### How to Get the Mapping

At engine boot, query available assets via the `get_assets` RPC method:

```typescript
import { createGetAssetsMessage, parseGetAssetsResponse } from '@erc7824/nitrolite';

const msg = await createGetAssetsMessage(engineSigner);
engineWs.send(msg);

// Response includes: { token: Address, chainId: number, symbol: string, decimals: number }
// Build map: tokenAddress → { symbol, decimals }
```

Source: `.reference/nitrolite/sdk/src/rpc/types/common.ts` — `RPCAsset` type includes `token`, `chainId`, `symbol`, `decimals`.

The on-chain Custody contract uses token addresses. The off-chain App Sessions use symbols. The asset map bridges the two:
- `depositAndCommit` → on-chain → uses token address
- `createAppSessionMessage` → off-chain → uses symbol from asset map
- `custody.withdrawal()` → on-chain → uses token address

---

## Balance Querying (On-Chain, No Auth Needed)

User balances are readable directly from the Custody contract — public view function, no JWT, no WS, no auth:

```solidity
// .reference/nitrolite/contract/src/Custody.sol:95-108
function getAccountsBalances(
    address[] calldata accounts,
    address[] calldata tokens
) external view returns (uint256[][] memory)
```

### Frontend Usage

```typescript
// SDK wrapper: .reference/nitrolite/sdk/src/client/services/NitroliteService.ts:720-761
const balance = await nitroliteClient.getAccountBalance(userAddress, tokenAddress);
// Returns bigint — on-chain custody balance

// Or directly via viem:
const balances = await publicClient.readContract({
  address: CUSTODY_ADDRESS,
  abi: CUSTODY_ABI,
  functionName: 'getAccountsBalances',
  args: [[userAddress], [USDC_ADDRESS, WETH_ADDRESS]],
});
// Returns: [[usdcBalance, wethBalance]]
```

No JWT refresh, no WS connection, no authentication. Just an `eth_call`.

---

## Complete Flow: Every Step

### Phase 0: Engine Boot

See [Engine Boot Sequence](#engine-boot-sequence) above.

### Phase 1: User Connects Wallet + Session Key Auth

```
User opens app, connects MetaMask
  │
  ├── FRONTEND ──────────────────────────────────────────────────────
  │   RainbowKit wallet connect succeeds → address = 0xAlice
  │
  │   POST /api/session-key/generate { userAddress: "0xAlice" }
  │
  ├── BACKEND ───────────────────────────────────────────────────────
  │   1. Check DB: does Alice have an ACTIVE, non-expired session key?
  │      YES → return existing sessionKeyAddress, frontend skips auth
  │      NO  → continue
  │
  │   2. const { privateKey, address } = generatePrivateKey()
  │      // viem's generatePrivateKey() or crypto.randomBytes(32)
  │
  │   3. Encrypt private key:
  │      AES-256-GCM with SESSION_KEY_ENCRYPTION_SECRET
  │      Store: iv (12 bytes) + authTag (16 bytes) + ciphertext
  │
  │   4. INSERT INTO session_keys:
  │      user_address:          "0xAlice"
  │      session_key_address:   "0xSK1"
  │      encrypted_private_key: "<base64>"
  │      status:                "PENDING"    ← not yet confirmed with Yellow
  │      application:           "dark-pool"
  │      allowances:            [{"asset": "usdc", "amount": "10000"}]
  │      expires_at:            NOW() + 30 days
  │
  │   Return { sessionKeyAddress: "0xSK1", allowances, expiresAt }
  │
  ├── FRONTEND ──────────────────────────────────────────────────────
  │   5. Open temporary WS to Yellow: wss://clearnet.yellow.com/ws
  │
  │   6. Send auth_request:
  │      const authParams = {
  │        session_key: "0xSK1",
  │        allowances: [{ asset: "usdc", amount: "10000" }],
  │        expires_at: BigInt(Math.floor(Date.now() / 1000) + 30 * 86400),
  │        scope: "app.create",
  │      };
  │      const msg = await createAuthRequestMessage({
  │        address: userAddress,
  │        application: "dark-pool",
  │        ...authParams,
  │      });
  │      ws.send(msg);
  │      // SDK ref: .reference/nitrolite/sdk/src/rpc/api.ts — createAuthRequestMessage
  │
  │   7. Receive challenge:
  │      const { challenge } = parseAuthChallengeResponse(response);
  │      // SDK ref: .reference/nitrolite/sdk/src/rpc/parse/auth.ts
  │
  │   8. Create EIP-712 signer:
  │      const signer = createEIP712AuthMessageSigner(
  │        walletClient,    // ← MetaMask
  │        authParams,
  │        { name: "dark-pool" }
  │      );
  │      // SDK ref: .reference/nitrolite/sdk/src/rpc/api.ts — createEIP712AuthMessageSigner
  │
  │   9. *** WALLET POPUP *** — user sees structured EIP-712 data:
  │      "Authorize session key 0xSK1 to spend up to 10000 usdc
  │       for dark-pool, until [date 30 days from now]"
  │      User clicks SIGN.
  │
  │   10. Send signed verify message:
  │       const verifyMsg = await createAuthVerifyMessageFromChallenge(signer, challenge);
  │       ws.send(verifyMsg);
  │       // SDK ref: .reference/nitrolite/sdk/src/rpc/api.ts — createAuthVerifyMessageFromChallenge
  │
  │   11. Yellow validates:
  │       - EIP-712 sig is from 0xAlice ✓
  │       - Challenge is valid + fresh (5-min TTL) ✓
  │       - Params match challenge ✓
  │       Yellow REGISTERS session key in its DB:
  │         0xSK1 → authorized for 0xAlice, app: "dark-pool",
  │         allowances: [{usdc: 10000}], expires: now + 30 days
  │       // Clearnode ref: .reference/nitrolite/clearnode/session_key.go:67-127 — AddSessionKey
  │
  │   12. Receive response:
  │       const { jwtToken } = parseAuthVerifyResponse(response);
  │       // SDK ref: .reference/nitrolite/sdk/src/rpc/parse/auth.ts — parseAuthVerifyResponse
  │
  │   13. Close WS to Yellow (auth complete, frontend doesn't need it anymore)
  │
  │   14. POST /api/session-key/confirm { userAddress: "0xAlice", jwt: "eyJ..." }
  │
  ├── BACKEND ───────────────────────────────────────────────────────
  │   15. UPDATE session_keys SET status = 'ACTIVE', jwt_token = 'eyJ...'
  │       WHERE user_address = '0xAlice' AND session_key_address = '0xSK1'
  │       // JWT stored as backup reference, not needed for settlement
  │
  └── DONE ──────────────────────────────────────────────────────────
      State in Yellow: 0xSK1 authorized for 0xAlice, 30 days, 10k USDC
      State in our DB: encrypted private key of 0xSK1, status ACTIVE
      User experienced: 1 wallet popup (the EIP-712 sign)
```

### Phase 2: User Places an Order

```
User fills order form: SELL 1000 USDC for ≥ 0.5 WETH, expires in 24h
  │
  ├── FRONTEND (useSubmitTrade hook) ────────────────────────────────
  │   1. Generate orderId — masked to 253 bits for BN128 field compatibility:
  │      const raw = keccak256(encodeAbiParameters([...], [address, timestamp, nonce]));
  │      const orderId = BigInt(raw) & ((1n << 253n) - 1n);  // always < SNARK_SCALAR_FIELD
  │      // 253-bit IDs give ~10^76 unique values — collision probability is effectively zero
  │
  │   2. Compute orderHash using Poseidon (ZK-friendly, enables private settlement):
  │      import { buildPoseidon } from 'circomlibjs';
  │      const poseidon = await buildPoseidon();
  │      const hash = poseidon([orderId, userAddress, USDC_ADDR, WETH_ADDR, 1000e6, 0.5e18, expiresAt]);
  │      const orderHash = '0x' + poseidon.F.toString(hash, 16).padStart(64, '0');
  │      // Poseidon output is a field element (~254 bits), always < SNARK_SCALAR_FIELD
  │
  │   3. Check USDC allowance for Router:
  │      IF insufficient → *** WALLET POPUP *** approve(ROUTER, MaxUint256)
  │      (one-time per token)
  │
  │   4. *** WALLET POPUP *** depositAndCommit:
  │      await walletClient.writeContract({
  │        address: ROUTER_ADDRESS, abi: ROUTER_ABI,
  │        functionName: 'depositAndCommit',
  │        args: [USDC_ADDR, 1000e6n, orderId, orderHash],
  │      });
  │
  ├── ON-CHAIN (DarkPoolRouter) ─────────────────────────────────────
  │   a. safeTransferFrom(Alice, Router, 1000 USDC)
  │   b. USDC.approve(custody, 1000 USDC)
  │   c. custody.deposit(msg.sender, USDC, 1000e6)
  │      → Alice's Yellow unified balance now has 1000 USDC
  │   d. commitments[orderId] = { user: Alice, orderHash, timestamp, Active }
  │   e. emit OrderCommitted(orderId, Alice, orderHash)
  │
  ├── FRONTEND (continued) ──────────────────────────────────────────
  │   5. Wait for tx confirmation
  │   6. POST /api/orders {
  │        orderId, userAddress: "0xAlice",
  │        sellToken: USDC_ADDR, buyToken: WETH_ADDR,
  │        sellAmount: "1000000000", minBuyAmount: "500000000000000000",
  │        expiresAt, commitmentTx: tx.hash
  │      }
  │
  ├── BACKEND ───────────────────────────────────────────────────────
  │   7. commitmentVerifier.verifyCommitment(orderId, orderDetails):
  │      - Read commitment from contract via RPC
  │      - Recompute Poseidon hash from submitted details
  │      - REJECT if mismatch (anti-poisoning)
  │      // See: app/server/src/services/commitmentVerifier.ts
  │
  │   8. gRPC → Warlock.SubmitOrder(orderDetails)
  │
  ├── WARLOCK ───────────────────────────────────────────────────────
  │   9. Insert order into DB
  │   10. Add to in-memory order book
  │   11. Run MatchOrder algorithm:
  │       - Find compatible counterparty (price overlap, token match, not expired)
  │       - If match → create match record (settlement_status: PENDING)
  │       - If no match → order waits in book
  │   12. Emit on MatchChan() → backend StreamMatches → frontend WS
  │
  └── DONE ──────────────────────────────────────────────────────────
      Session key NOT involved. User walks away.
```

### Phase 3: Settlement (User Offline)

```
Settlement worker finds PENDING match:
  Alice SELLS 1000 USDC for ≥ 0.5 WETH
  Bob SELLS 0.6 WETH for ≥ 900 USDC
  Execution: 1000 USDC ↔ 0.6 WETH
  │
  ├── STEP 0: LOAD MATCH AND SESSION KEYS ──────────────────────────
  │
  │   SELECT * FROM matches
  │   WHERE settlement_status = 'PENDING'
  │   ORDER BY created_at ASC LIMIT 1
  │
  │   UPDATE matches SET settlement_status = 'SETTLING' WHERE id = $1
  │
  │   Load session keys:
  │     SELECT encrypted_private_key FROM session_keys
  │     WHERE user_address = '0xAlice' AND status = 'ACTIVE' AND expires_at > NOW()
  │     → decrypt with AES-256-GCM using SESSION_KEY_ENCRYPTION_SECRET
  │     Same for Bob.
  │
  │   FAIL CHECK: if either key missing or expired:
  │     UPDATE matches SET settlement_status = 'FAILED',
  │       settlement_error = 'Session key expired for 0xAlice'
  │     Notify user via WebSocket to re-authorize.
  │     STOP.
  │
  ├── STEP 1: ON-CHAIN VERIFICATION ────────────────────────────────
  │
  │   PATH A — With ZK (production):
  │     Engine generates Groth16 proof locally (~200ms via snarkjs)
  │     Engine wallet sends tx:
  │     router.proveAndSettle(
  │       aliceOrderId, bobOrderId,
  │       1000e6,    // aliceFillAmount (full fill in this example)
  │       0.6e18,    // bobFillAmount
  │       proof      // ZK proof (bytes)
  │     )
  │     Contract: verifies proof against public inputs (commitment hashes,
  │       fill amounts, settled amounts, timestamp) via ZK verifier contract.
  │     Order details NEVER appear on-chain.
  │
  │   PATH B — Without ZK (fallback/testing):
  │     Engine wallet sends tx:
  │     router.revealAndSettle(
  │       aliceOrderId, bobOrderId,
  │       { orderId, user: Alice, sellToken: USDC, buyToken: WETH,
  │         sellAmount: 1000e6, minBuyAmount: 0.5e18, expiresAt },
  │       { orderId, user: Bob, sellToken: WETH, buyToken: USDC,
  │         sellAmount: 0.6e18, minBuyAmount: 900e6, expiresAt },
  │       1000e6, 0.6e18  // fill amounts
  │     )
  │     Contract: verifies hashes, slippage, expiry directly from calldata.
  │     Order details are public in calldata.
  │
  │   Both paths:
  │     ✓ settledAmount incremented for each order
  │     ✓ Orders stay Active (partial fills) or move to Settled (full fills)
  │     emit OrdersSettling(aliceOrderId, bobOrderId)
  │
  │   UPDATE matches SET reveal_tx_hash = tx.hash WHERE id = $1
  │
  ├── STEP 2: CREATE APP SESSION (Multi-Signature) ─────────────────
  │
  │   Look up asset symbols from engine's cached map:
  │     USDC address → "usdc"
  │     WETH address → "weth"
  │
  │   const sellerSigner = createECDSAMessageSigner(aliceDecryptedKey);
  │   const buyerSigner = createECDSAMessageSigner(bobDecryptedKey);
  │   // SDK ref: .reference/nitrolite/sdk/src/rpc/api.ts — createECDSAMessageSigner
  │
  │   // Sign with Alice's session key
  │   const createMsg = await createAppSessionMessage(sellerSigner, {
  │     definition: {
  │       protocol: "NitroRPC/0.4",
  │       participants: [aliceAddress, bobAddress, engineAddress],
  │       weights: [0, 0, 100],
  │       quorum: 100,
  │       challenge: 0,
  │       nonce: Date.now(),
  │       application: "dark-pool",
  │     },
  │     allocations: [
  │       { participant: aliceAddress,  asset: "usdc", amount: "1000000000" },
  │       { participant: bobAddress,    asset: "weth", amount: "600000000000000000" },
  │       { participant: engineAddress, asset: "usdc", amount: "0" },
  │       { participant: engineAddress, asset: "weth", amount: "0" },
  │     ],
  │   });
  │   // SDK ref: .reference/nitrolite/sdk/src/rpc/api.ts — createAppSessionMessage
  │
  │   // Add Bob's session key signature (non-zero allocation → must sign creation)
  │   const parsed = JSON.parse(createMsg);
  │   const bobSig = await buyerSigner(parsed.req);
  │   parsed.sig.push(bobSig);
  │
  │   // Send over ENGINE's authenticated WS connection
  │   engineWs.send(JSON.stringify(parsed));
  │
  │   Yellow validates (Clearnode app_session_service.go:373-466):
  │     ✓ Alice's session key: registered, not expired, within allowance, app matches
  │     ✓ Bob's session key: same checks
  │     ✓ Engine has zero allocation → skipped entirely (line 412)
  │     ✓ Definition valid (≥2 participants, weights ≥ 0, quorum reachable)
  │     → Locks 1000 USDC from Alice's custody balance
  │     → Locks 0.6 WETH from Bob's custody balance
  │     → Returns { appSessionId: "0xabc..." }
  │
  │   const { appSessionId } = parseCreateAppSessionResponse(response);
  │   // SDK ref: .reference/nitrolite/sdk/src/rpc/parse/app.ts
  │
  │   UPDATE matches SET app_session_id = appSessionId WHERE id = $1
  │
  ├── STEP 3: CLOSE APP SESSION (Engine Signs Alone) ───────────────
  │
  │   const engineSigner = createECDSAMessageSigner(ENGINE_SESSION_KEY);
  │
  │   const closeMsg = await createCloseAppSessionMessage(engineSigner, {
  │     app_session_id: appSessionId,
  │     allocations: [
  │       // SWAPPED: Alice gets Bob's tokens, Bob gets Alice's tokens
  │       { participant: aliceAddress,  asset: "weth", amount: "600000000000000000" },
  │       { participant: bobAddress,    asset: "usdc", amount: "1000000000" },
  │       { participant: engineAddress, asset: "usdc", amount: "0" },
  │       { participant: engineAddress, asset: "weth", amount: "0" },
  │     ],
  │   });
  │   // SDK ref: .reference/nitrolite/sdk/src/rpc/api.ts — createCloseAppSessionMessage
  │
  │   engineWs.send(closeMsg);
  │
  │   Yellow validates (Clearnode app_session_service.go:767-805 — verifyQuorum):
  │     ✓ Engine signed (weight 100)
  │     ✓ 100 ≥ quorum 100 → authorized
  │     ✓ challenge: 0 → instant, no dispute window
  │     → Swaps custody balances atomically:
  │       Alice: -1000 USDC, +0.6 WETH
  │       Bob:   -0.6 WETH,  +1000 USDC
  │     → Session closed
  │
  │   parseCloseAppSessionResponse(response);
  │   // SDK ref: .reference/nitrolite/sdk/src/rpc/parse/app.ts
  │
  ├── STEP 4: ON-CHAIN FINALIZATION ────────────────────────────────
  │
  │   Engine wallet sends tx:
  │   router.markFullySettled(aliceOrderId, bobOrderId)
  │
  │   Both orders → Status.Settled
  │   emit OrdersSettled(aliceOrderId, bobOrderId)
  │
  │   UPDATE matches SET
  │     settlement_status = 'SETTLED',
  │     settle_tx_hash = tx.hash,
  │     settled_at = NOW()
  │   WHERE id = $1
  │
  │   Notify users via WebSocket:
  │     wsServer.broadcast('matches:0xAlice', { type: 'settled', matchId })
  │     wsServer.broadcast('matches:0xBob', { type: 'settled', matchId })
  │
  └── DONE ──────────────────────────────────────────────────────────
      Alice's custody: 0 USDC, 0.6 WETH
      Bob's custody:   1000 USDC, 0 WETH
      Users can withdraw whenever.
```

### Phase 4: Withdrawal

```
User comes back, checks balance, withdraws
  │
  ├── BALANCE QUERY (no auth needed) ───────────────────────────────
  │   // On-chain read — public view function on Custody contract
  │   // Ref: .reference/nitrolite/contract/src/Custody.sol:95-108
  │   const balances = await publicClient.readContract({
  │     address: CUSTODY_ADDRESS,
  │     abi: CUSTODY_ABI,
  │     functionName: 'getAccountsBalances',
  │     args: [[userAddress], [USDC_ADDR, WETH_ADDR]],
  │   });
  │   // Returns: [[0n, 600000000000000000n]]  → 0 USDC, 0.6 WETH
  │
  ├── WITHDRAWAL ───────────────────────────────────────────────────
  │   *** WALLET POPUP ***
  │   await walletClient.writeContract({
  │     address: CUSTODY_ADDRESS,
  │     abi: CUSTODY_ABI,
  │     functionName: 'withdrawal',
  │     args: [WETH_ADDR, 600000000000000000n],
  │   });
  │   // 0.6 WETH → user's wallet
  │
  └── DONE
```

### Phase 5: Cancellation

```
User cancels an open order:
  │
  ├── ON-CHAIN ─────────────────────────────────────────────────────
  │   *** WALLET POPUP ***
  │   router.cancel(orderId)
  │   → Status.Active → Status.Cancelled
  │   → emit OrderCancelled(orderId)
  │
  ├── BACKEND ──────────────────────────────────────────────────────
  │   DELETE /api/orders/:id → Warlock removes from order book
  │
  ├── FUNDS ────────────────────────────────────────────────────────
  │   User's tokens are still in Yellow Custody (credited to their balance).
  │   They can withdraw whenever via custody.withdrawal().
  │
  ├── SESSION KEY ──────────────────────────────────────────────────
  │   NOT revoked — session key is per-session, covers other orders.
  │   Only revoked on explicit logout or when all orders are filled/cancelled.
  │
  └── DONE
```

---

## "Game with Judge" Governance Model

From Yellow Network documentation — this is our exact use case:

```
Participants: [Seller, Buyer, Engine]
Weights:      [0,      0,     100]
Quorum:       100
Challenge:    0        (no challenge period — instant settlement)

Result: Only engine can update/close state
```

**Why both users must sign creation (but not close):**
- Weights govern who can **update/close** a session (engine only, weight 100)
- Creation signatures are about **fund-owner consent** — if your funds are being locked (non-zero allocation), you must sign
- Without this rule, the engine could lock anyone's balance into arbitrary sessions
- Yellow enforces this at the protocol level: `.reference/nitrolite/clearnode/app_session_service.go:422` — `if alloc.Amount.IsPositive() && !sigCtx.HasSignature { return error }`
- Engine has zero allocation → no signature needed for creation → skipped entirely

**Why only the engine signs close:**
- Engine has weight 100, quorum is 100, so engine alone meets quorum
- Users have weight 0 — they literally cannot close or modify the session
- `challenge: 0` means no dispute window — close is instant

---

## Trust Model

The engine has operational authority but is constrained at every layer:

| Layer | Constraint | What It Prevents | Source |
|-------|-----------|------------------|--------|
| On-chain commitment | `depositAndCommit` records exact trade terms tied to `msg.sender` | Engine can't fabricate orders | `DarkPoolRouter.sol:75-90` |
| `proveAndSettle` (ZK) | Contract verifies ZK proof of hash integrity, expiry, token match, slippage — without seeing order details | Engine can't settle invalid/unfair trades; order details stay private | ZK verifier contract |
| `revealAndSettle` (fallback) | Contract verifies hashes, expiry, token match, slippage directly from calldata | Same guarantees, but order details are public | `DarkPoolRouter.sol:116-152` |
| Partial fill tracking | `settledAmount` prevents overfilling; proportional slippage check | Engine can't settle more than committed or at worse-than-committed rates | `DarkPoolRouter.sol` |
| Session key allowances | Spending caps per asset (e.g., 10k USDC) | Engine can't drain user's full balance | `.reference/nitrolite/clearnode/session_key.go:88-100` |
| Session key expiry | 30-day time-bounded authorization | Engine can't use stale keys | `.reference/nitrolite/clearnode/session_key.go:172` |
| Session key revocation | User can revoke via `revoke_session_key` anytime | User has a kill switch | `.reference/nitrolite/clearnode/docs/API.md` |
| On-chain audit trail | `OrdersSettling` / `OrdersSettled` events are public | Anyone can verify settlements occurred | `DarkPoolRouter.sol:60-63` |

`proveAndSettle` (with ZK) is the production authorization gate. The contract verifies a cryptographic proof that the trade is legitimate before any funds move — without revealing order details. `revealAndSettle` is retained as a fallback for testing and debugging.

---

## WebSocket Connection Architecture

**One persistent WS connection from engine to Yellow**, shared across all settlements.

```
Engine ──── persistent WS ────► Yellow Clearnode
               │
               ├─ authenticated as engine wallet
               ├─ sends create_app_session (signed by user session keys)
               ├─ sends close_app_session (signed by engine session key)
               ├─ sends get_assets queries
               └─ re-authenticates every ~23h
```

- The engine does NOT authenticate as users
- The engine does NOT need per-user WS connections
- Message signatures are validated by Yellow against registered session keys, NOT against the WS connection identity
- User JWTs stored in our DB are backup/reference only — not used for settlement

---

## Nitrolite SDK Reference

**Package:** `@erc7824/nitrolite` (v0.5.3)
**Install:** `npm install @erc7824/nitrolite`
**Dependencies:** `viem`, `abitype`, `zod`
**Reference source:** `.reference/nitrolite/` (cloned locally)

### Functions We Use

| Function | Where | Purpose | SDK Source |
|----------|-------|---------|------------|
| `createAuthRequestMessage(params)` | Frontend | Start session key registration | `sdk/src/rpc/api.ts` |
| `createEIP712AuthMessageSigner(walletClient, params, domain)` | Frontend | Create EIP-712 signer for auth | `sdk/src/rpc/api.ts` |
| `createAuthVerifyMessageFromChallenge(signer, challenge)` | Frontend | Complete auth with wallet signature | `sdk/src/rpc/api.ts` |
| `createECDSAMessageSigner(privateKey)` | Backend | Create signer from stored session key | `sdk/src/rpc/api.ts` |
| `createAppSessionMessage(signer, params)` | Backend | Create App Session for settlement | `sdk/src/rpc/api.ts` |
| `createCloseAppSessionMessage(signer, params)` | Backend | Close session with swapped allocations | `sdk/src/rpc/api.ts` |
| `createGetAssetsMessage(signer)` | Backend | Query available assets + symbol mapping | `sdk/src/rpc/api.ts` |
| `parseCreateAppSessionResponse(raw)` | Backend | Extract `appSessionId` | `sdk/src/rpc/parse/app.ts` |
| `parseCloseAppSessionResponse(raw)` | Backend | Confirm close succeeded | `sdk/src/rpc/parse/app.ts` |
| `parseAuthChallengeResponse(raw)` | Frontend | Extract challenge UUID | `sdk/src/rpc/parse/auth.ts` |
| `parseAuthVerifyResponse(raw)` | Frontend | Extract JWT + confirmation | `sdk/src/rpc/parse/auth.ts` |
| `parseGetAssetsResponse(raw)` | Backend | Extract asset list | `sdk/src/rpc/parse/asset.ts` |

### Types We Use

```typescript
import type {
  RPCAppDefinition,
  RPCAppSessionAllocation,
  RPCProtocolVersion,
  RPCData,
  MessageSigner,
  RPCAppStateIntent,
  RPCAsset,
} from '@erc7824/nitrolite';
// Type source: .reference/nitrolite/sdk/src/rpc/types/
```

### Communication

```typescript
// Production
const ws = new WebSocket('wss://clearnet.yellow.com/ws');
// Sandbox (testing)
const ws = new WebSocket('wss://clearnet-sandbox.yellow.com/ws');

// All SDK message functions return JSON-stringified, signed strings ready to send
ws.send(await createAppSessionMessage(signer, params));
```

---

## Database Changes

### New Table: `session_keys`

```sql
CREATE TABLE session_keys (
    id SERIAL PRIMARY KEY,
    user_address VARCHAR(42) NOT NULL,
    session_key_address VARCHAR(42) NOT NULL,
    encrypted_private_key TEXT NOT NULL,       -- AES-256-GCM encrypted
    jwt_token TEXT,                             -- backup, not needed for settlement
    application VARCHAR(100) DEFAULT 'dark-pool',
    allowances JSONB NOT NULL,                 -- [{ asset, amount }]
    expires_at TIMESTAMP NOT NULL,             -- 30 days from creation
    status VARCHAR(20) DEFAULT 'PENDING' CHECK (
        status IN ('PENDING', 'ACTIVE', 'EXPIRED', 'REVOKED')
    ),
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_address, session_key_address)
);

CREATE INDEX idx_session_keys_user ON session_keys (user_address, status);
```

### Enhanced `matches` Table

```sql
ALTER TABLE matches ADD COLUMN IF NOT EXISTS app_session_id VARCHAR(66);
ALTER TABLE matches ADD COLUMN IF NOT EXISTS reveal_tx_hash VARCHAR(66);
ALTER TABLE matches ADD COLUMN IF NOT EXISTS settle_tx_hash VARCHAR(66);
ALTER TABLE matches ADD COLUMN IF NOT EXISTS settlement_error TEXT;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS settled_at TIMESTAMP;
```

### Stale Columns to Remove

- `orders.order_signature` (EIP-712 remnant)
- `orders.order_data` (EIP-712 remnant)
- `orders.revealed` (status enum covers this)
- `orders.revealed_at` (status enum covers this)

---

## Environment Variables

```bash
# Engine identity
ENGINE_WALLET_KEY=0x...             # EOA private key, needs ETH for gas
ENGINE_SESSION_KEY=0x...            # ECDSA private key for Yellow protocol signing

# Security
SESSION_KEY_ENCRYPTION_SECRET=...   # 32-byte key for AES-256-GCM

# Yellow Network
YELLOW_WS_URL=wss://clearnet-sandbox.yellow.com/ws   # or clearnet.yellow.com for prod
YELLOW_CUSTODY_ADDRESS=0x...        # Custody contract on target chain
YELLOW_ADJUDICATOR_ADDRESS=0x...    # Adjudicator contract (if needed)

# Contract addresses
ROUTER_ADDRESS=0x...
```

---

## Error Handling

### Session Key Expired Before Match

```
Settlement worker loads match → checks session key → expired
  → UPDATE matches SET settlement_status = 'FAILED',
    settlement_error = 'Session key expired for 0xAlice'
  → Notify user via WebSocket: "Please reconnect wallet to re-authorize"
  → User reconnects → new session key → engine retries settlement
```

### proveAndSettle / revealAndSettle Reverts

```
Possible causes:
  - "Invalid proof" → ZK proof verification failed (engine bug, stale order data, or circuit mismatch)
  - "Seller/Buyer not active" → order cancelled or already fully settled
  - "Seller/Buyer overfill" → fill amount exceeds remaining (partial fill accounting error)
  - "Seller/Buyer hash mismatch" → (revealAndSettle only) submitted details don't match commitment
  - "Seller/Buyer expired" → order expired on-chain

  → Catch revert error, log details
  → UPDATE matches SET settlement_status = 'FAILED',
    settlement_error = revert reason
  → Do NOT retry (deterministic failure)
  → If "Invalid proof": check that engine's order data matches on-chain commitment
```

### Yellow WS Drops Mid-Settlement

```
After revealAndSettle but before App Session:
  → Orders stuck in Status.Settling on-chain
  → Engine reconnects, re-authenticates
  → Check if App Session was already created (query by nonce or match ID)
  → If not → retry from App Session creation
  → If yes → continue to close
```

### App Session Creation Fails

```
Possible causes: insufficient allowance, session key revoked, Yellow internal error
  → Log error, check specific error code
  → If allowance issue → mark FAILED, notify user to re-authorize with higher amount
  → If transient Yellow error → retry with exponential backoff (max 3 attempts)
```

### App Session Close Fails

```
App Session exists but close fails (rare — engine has full authority):
  → Retry with backoff
  → If persistent → alert, manual investigation needed
  → On-chain orders remain in Settling status (safe — no funds moved)
```

---

## Implementation Order

### Phase 1: Contract Update — DONE ✓
- ✅ Updated `IYellowCustody` interface with `account` parameter
- ✅ Updated `depositAndCommit` to call `custody.deposit(msg.sender, ...)`
- TODO: Update `MockYellowCustody.sol` to match 3-param signature
- TODO: Update and run Foundry tests

### Phase 1b: Partial Fill Support
1. Add `settledAmount` to Commitment struct, remove `Settling` status
2. Update `revealAndSettle` with fill amounts and proportional slippage
3. Simplify `markFullySettled` to per-order
4. Update `cancel` to allow partially filled orders
5. Foundry tests for partial fills

### Phase 1c: ZK Private Settlement
1. Install Circom toolchain + Powers of Tau
2. Write Circom circuit (Poseidon hash verification + all settlement constraints)
3. Generate Groth16 verifier contract via snarkjs
4. Add `proveAndSettle` function to DarkPoolRouter (calls ZK verifier)
5. Circuit unit tests

### Phase 1d: Poseidon Hash Integration
1. Install `poseidon-solidity` in contracts (`forge install poseidon-solidity/poseidon-solidity`)
2. Update `revealAndSettle` to use on-chain Poseidon (replaces `keccak256(abi.encode(...))`)
3. Add `SNARK_SCALAR_FIELD` constant and field bounds checks in `depositAndCommit`
4. Create Poseidon utility module (shared between frontend + backend, `circomlibjs`)
5. Add orderId 253-bit masking in frontend for BN128 field compatibility
6. Update frontend `useSubmitTrade` to use Poseidon hash
7. Update backend `commitmentVerifier.ts` to use Poseidon
8. Add proof generation service (`snarkjs` in Node.js)
9. Update Foundry tests for Poseidon hashes

### Phase 2: Database Migration
1. New migration `002_settlement_and_session_keys.up.sql`
2. Create `session_keys` table
3. Add settlement columns to `matches`
4. Drop stale columns from `orders`
5. Update Warlock Go DB queries if any reference dropped columns

### Phase 3: Session Key Infrastructure (Backend)
1. Session key generation endpoint (`POST /api/session-key/generate`)
2. AES-256-GCM encryption/decryption helpers
3. Session key confirmation endpoint (`POST /api/session-key/confirm`)
4. Session key cleanup (mark expired, handle revocation)

### Phase 4: Frontend Session Key Flow
1. Session key auth hook (integrates with wallet connect)
2. Yellow Network WS connection (temporary, for auth only)
3. EIP-712 signing flow using Nitrolite SDK
4. Withdrawal UI (on-chain custody balance query + withdrawal tx)

### Phase 5: Settlement Service (Backend)
1. Engine boot: Yellow WS connection + auth + asset map + re-auth every ~23h
2. Engine wallet management: load key, nonce tracking for sequential txs
3. Settlement worker: poll PENDING matches
4. Settlement pipeline: generate ZK proof → proveAndSettle → create App Session → close → markFullySettled
5. Fallback path: if proof generation fails → revealAndSettle with order details as calldata
6. Error handling, retries, status tracking (including partial fill state management)
7. WebSocket notifications to users

### Phase 6: Testing
1. Contract tests: update mock, test settlement flow, partial fills, ZK verification
2. Backend tests: session key endpoints, settlement pipeline with mocks, proof generation
3. E2E: deposit → commit → match → prove → settle → verify custody balances
4. Edge cases: expired keys, reverted txs, cancellation, partial fills, multi-trade reuse, invalid proofs

### Phase 7: Cross-Chain Deployment
1. Deploy DarkPoolRouter on additional chains (Base, Polygon, etc.)
2. Frontend chain selector for deposit/withdrawal
3. Backend: track deposit chain per user/order
4. Warlock: no changes needed (already chain-agnostic)
5. Test cross-chain settlement flow via Yellow unified balance

---

## Future Improvements

### ZK Private Settlement — PLANNED (Phase 1b)
Circom + Groth16 + Poseidon. Engine generates ZK proof per settlement, contract verifies without seeing order details. Eliminates privacy leak from partial fills. See [ZK Private Settlement](#zk-private-settlement-planned--circom--groth16--poseidon) section above.

### Cross-Chain Settlement — PLANNED (Phase 7)
Deploy Router on multiple chains, leverage Yellow's unified balance for cross-chain atomic settlement without bridges. See [Cross-Chain Support](#cross-chain-support-via-yellow-network) section above.

### Batch Auctions (Priority: High)
Replace Warlock's continuous matching with time-windowed batch auctions. Uniform clearing price, no ordering advantage, better price discovery. Most impactful improvement per unit of effort. Pairs especially well with ZK — prove the entire batch's matching was correct in a single proof.

### ZK Matching Fairness Proofs (Priority: Medium)
Extend the ZK system to also prove matching correctness — that the engine followed the stated algorithm (price-time priority, no censorship, best execution). Would use a separate or extended circuit. With batch auctions, one proof per batch verifies the entire batch was fair.

### TEE Matching (Priority: Medium)
Run Warlock in a Trusted Execution Environment (Intel TDX / AWS Nitro Enclave). Operator-blind matching — even the engine operator can't see order details. Remote attestation proves what code is running.

### Verifiable Private Batch Auction (Combined Vision)
All combined: TEE for privacy, batch auctions for fairness, ZK proofs for verifiability. A cryptographically verifiable dark pool where every step is provable. Nothing like this exists today.

---

## Resolved Questions

All questions from the original design are now resolved with code-level evidence from the Clearnode and SDK source.

### 1. Asset Identifiers — RESOLVED
App Session allocations use lowercase string symbols (`"usdc"`, `"weth"`), not token addresses. Symbols map to per-chain addresses via Clearnode's asset config. Engine queries available assets at boot via `get_assets` RPC and builds a token-address-to-symbol map. Source: `.reference/nitrolite/sdk/src/rpc/types/common.ts` — `RPCAppSessionAllocation.asset` is `string`.

### 2. Engine Authentication with Yellow Network — RESOLVED
Engine authenticates as itself using `application: "clearnode"` (root access) with empty allowances. Maintains one persistent WS connection. Re-authenticates every ~23h automatically. Yellow validates message signatures independently of WS sender identity — confirmed in Clearnode source: `.reference/nitrolite/clearnode/rpc_router_private.go:429`. The cerebro CLI uses the same pattern: `.reference/nitrolite/examples/cerebro/clearnet/auth.go:24-43`.

### 3. Cancellation Refund Path — RESOLVED
When a user cancels after `depositAndCommit`, their tokens remain in Yellow Custody (credited to their unified balance). They withdraw via `custody.withdrawal(token, amount)` — standard on-chain tx. Balance is queryable without auth via `Custody.getAccountsBalances()` view function: `.reference/nitrolite/contract/src/Custody.sol:95-108`.

### 4. Session Key Revocation on Cancel — RESOLVED
Do NOT revoke on single-order cancel (session key is per-session, covers other orders). Revoke only on explicit logout or when all user orders are filled/cancelled. Natural expiry at 30 days handles cleanup for abandoned sessions.

### 5. Session Key Expiry Mid-Settlement — RESOLVED
Set session key expiry to 30 days (no enforced maximum in Clearnode: `.reference/nitrolite/clearnode/session_key.go:68-72`). If somehow expired with an open order: settlement fails, engine marks match as FAILED, notifies user to re-authorize. With 30-day window this is an extreme edge case.

### 6. Custody Deposit Attribution — RESOLVED
`custody.deposit(address account, address token, uint256 amount)` credits the specified account's unified balance. Router calls `custody.deposit(msg.sender, ...)`. Confirmed from SDK ABI: `.reference/nitrolite/sdk/src/abis/generated.ts`.

### 7. App Session Governance — RESOLVED
"Game with Judge" model: `weights: [0, 0, 100]`, `quorum: 100`, `challenge: 0`. Engine is sole decision-maker for close. Users' session keys sign creation (non-zero allocation consent requirement). Engine has zero allocation → skipped entirely in creation validation. Source: `.reference/nitrolite/clearnode/app_session_service.go:412`.

### 8. Session Key Per Order vs Per Session — RESOLVED
Per user session. 30-day expiry, generous allowances. One active session key per user. Reduces wallet popups to 1 per trade for returning users.

### 9. Challenge Period — RESOLVED
`challenge: 0`. No dispute window. `revealAndSettle` is the authorization gate — on-chain verification before any funds move makes a challenge period redundant.

### 10. JWT vs Session Key Registration — RESOLVED
Two separate things with separate expiries. JWT (24h, for WS auth) is irrelevant for settlement. Session key registration (30 days, in Yellow's DB) is what matters. Engine authenticates its own WS connection with its own JWT. Source: `.reference/nitrolite/clearnode/auth.go:64` (JWT TTL), `.reference/nitrolite/clearnode/session_key.go:48-63` (registration persistence).

### 11. WS Connection Architecture — RESOLVED
One persistent WS connection from engine to Yellow, authenticated as the engine. Messages signed by user session keys are sent over this connection. Yellow validates signatures, not sender identity. Source: `.reference/nitrolite/clearnode/rpc_node.go:214` (connection identity not checked against message signers).

### 12. Engine as Participant — RESOLVED
Zero-allocation participants need nothing: no custody balance, no session key registration, no signature on creation. Just a valid address in the participants array. Source: `.reference/nitrolite/clearnode/app_session_service.go:412` — `if alloc.Amount.IsZero() { continue }`.

### 13. Balance Querying — RESOLVED
`Custody.getAccountsBalances(address[], address[])` is a public view function. Direct `eth_call`, no auth, no WS connection. SDK wrapper: `NitroliteService.getAccountBalance()`. Source: `.reference/nitrolite/contract/src/Custody.sol:95-108`.

### 14. BN128 Field Bounds for ZK Inputs — RESOLVED
Groth16 public inputs must be < SNARK_SCALAR_FIELD (~2^254). No limb splitting needed because: (a) Poseidon outputs are field elements by construction (always < field), (b) practical ERC-20 amounts are < 2^128, (c) addresses are 160 bits, (d) timestamps are ~32 bits. The one exception is `orderId` generated via `keccak256(...)` which is full 256-bit — solved by masking to 253 bits (`BigInt(raw) & ((1n << 253n) - 1n)`). Contract adds defensive `require(uint256(orderHash) < SNARK_SCALAR_FIELD)` in `depositAndCommit`.

### 15. On-Chain Poseidon for revealAndSettle Fallback — RESOLVED
Since commitments are now Poseidon hashes, the `revealAndSettle` fallback must recompute Poseidon on-chain (not keccak256). This requires the `poseidon-solidity` library (`forge install poseidon-solidity/poseidon-solidity`). `PoseidonT8.hash(...)` costs ~100k gas per call — acceptable for a fallback path. Library is battle-tested (Tornado Cash, Semaphore, WorldID). Both settlement paths now verify against the same Poseidon commitment hash.
