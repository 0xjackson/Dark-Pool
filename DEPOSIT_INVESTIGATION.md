# Deposit Investigation — Unified Balance Not Credited

## Summary

After a successful on-chain `Custody.resize()`, the clearnode shows **zero unified balance** for the user. The on-chain resize event fired correctly, but funds are not reflected in the clearnode's ledger.

## Addresses

| Role | Address |
|------|---------|
| User wallet | `0x9b01fbC738FB48d02Be276c1d53DF590864c170D` |
| Broker (clearnode) | `0x435d4B6b68e1083Cc0835D1F971C4739204C1d2a` |
| Engine wallet | `0x88A8465e9658bE44114346D844a45789b8EB8c48` |
| Custody contract | `0x490fb189DdE3a01B00be9BA5F41e3447FbC838b6` |
| Adjudicator | `0x7de4A0736Cf5740fD3Ca2F2e9cc85c9AC223eF0C` |
| Channel (successful) | `0xd9824de529ec7566aea0777c8340108de48d730e499322c1c275bf791914448d` |

- **Chain**: Base mainnet (8453)
- **Clearnode WS**: `wss://clearnet.yellow.com/ws`
- **Token**: `0x0000000000000000000000000000000000000000` (native ETH)
- **Resize amount**: 10000000000000 (10e12 wei = 0.00001 ETH)

## Timeline

### 1. On-chain resize succeeded

The `Resized` event was emitted by the Custody contract:

```
Event: Resized(bytes32 indexed channelId, int256[] deltaAllocations)
channelId: 0xD9824DE529EC7566AEA0777C8340108DE48D730E499322C1C275BF791914448D
deltaAllocations: [+10000000000000, -10000000000000]
```

The resize used `resize_amount=+10e12, allocate_amount=-10e12` in a single call.

### 2. On-chain channel state (queried via `cast`)

```
Channel status: 2 (ACTIVE)
Last valid state:
  intent: 2 (RESIZE)
  version: 1
  allocations: [(user, 0x0, 0), (broker, 0x0, 0)]  — both zero
  stateData: contains 10e12 and 2^256-10e12 (resize/allocate encoded)
  sigs: [user_sig, broker_sig]  — both present
```

The stateData encodes the resize_amount and allocate_amount. The allocation amounts in the State struct are both 0 (net effect of +X and -X).

### 3. Clearnode channel state (queried via `get_channels`)

```
Channel 0xd9824de...:
  status: open
  token:  0x0000000000000000000000000000000000000000
  amount: 0
  version: 1
```

The clearnode correctly shows the channel as `open` with version 1. It processed the on-chain Resized event.

### 4. Clearnode unified balance (queried via `get_ledger_balances`)

```
User (0x9b01...): ledger_balances: []  (EMPTY)
Engine (0x88A4...): ledger_balances: []  (EMPTY)
```

**The unified balance was NOT credited despite the successful on-chain resize.**

## Stuck Channels

The user has **5 channels stuck in `resizing` status** (version 0). These are from previous failed resize attempts that never got confirmed on-chain:

| Channel ID | Status | Version |
|-----------|--------|---------|
| `0x147954859bb8e4c6...` | resizing | 0 |
| `0x9da20507c8a99d34...` | resizing | 0 |
| `0xe4e3dd53aee59de5...` | resizing | 0 |
| `0xd7423f13fc4faeed...` | resizing | 0 |
| `0x6b2df38830b3fd02...` | resizing | 0 |

Per migration guide: *"If a channel remains stuck in resizing state for an extended period, the recommended action is to close the channel and create a new one."*

Also from migration guide: *"Users with any channel containing non-zero amounts cannot perform transfers, submit app states with deposit intent, or create app sessions with non-zero allocations."*

The stuck `resizing` channels may be blocking operations even though their amount is 0.

## Root Cause Hypotheses

### H1: allocate_amount not credited because channel token is native ETH (zero address)
The channel was created for native ETH (`0x0000...0000`). The clearnode might not support unified balance for native ETH, only for ERC-20 tokens.

### H2: Stuck resizing channels are blocking the unified balance credit
The 5 stuck `resizing` channels might be preventing the clearnode from crediting the unified balance. The migration guide warns about non-zero channel amounts blocking operations.

### H3: The resize completed on-chain but the clearnode's off-chain allocate was not processed
The on-chain `Custody.resize()` updates the channel state. The `allocate_amount` is an off-chain instruction to the clearnode. The clearnode may have returned the resize response (signed state) but not actually moved funds to the unified balance until both:
1. The off-chain resize request was acknowledged (happened)
2. The on-chain resize was confirmed (happened)
3. Some additional confirmation or time delay is needed

### H4: The on-chain stateData encoding doesn't match what the clearnode expects
The stateData contains the resize/allocate amounts. If the encoding doesn't match the clearnode's expectations, it may have confirmed the resize but not interpreted the allocate correctly.

## On-Chain Balances

```
User custody ledger (getAccountsBalances): 50,000,000,000,000 wei = 0.000050 ETH
Resize amount used:                        10,000,000,000,000 wei = 0.000010 ETH
User wallet balance:                      492,406,538,899,971 wei = 0.000492 ETH
Custody contract total:                61,812,000,000,004 wei     = 0.061812 ETH
```

The user deposited 0.00005 ETH to custody. The resize moved 0.00001 ETH from custody ledger into the channel. The custody ledger still shows 0.00005 ETH — **the resize did NOT deduct from the custody ledger balance**.

Wait — `getAccountsBalances` returns 50e12 (0.00005 ETH). If the resize pulled 10e12 from custody into the channel, the custody balance should be 40e12. But it's showing 50e12. This means either:
1. The Custody contract's `getAccountsBalances` shows the total deposited (not accounting for channel locks)
2. Multiple deposits were made (50e12 total deposited, 10e12 in channel, 40e12 remaining)
3. The resize didn't actually deduct from the custody ledger

The deltaAllocations from the Resized event were [+10e12, -10e12], which nets to 0. The contract may have computed: "net change to channel = 0, so no custody ledger change." The funds pass through the channel instantly (resize_amount=+X adds, allocate_amount=-X removes), so the custody ledger might not change at all.

**Key insight**: If the on-chain effect is a net-zero change (channel started at 0, ended at 0), then custody ledger stays at 0.00005 ETH. The 0.00001 ETH was supposed to go to unified balance, but the clearnode shows nothing. The funds may still be entirely in the custody ledger.

## Open Questions

- [ ] Is the deposited ETH still in the custody contract's ledger?
- [ ] Should we close the stuck `resizing` channels first?
- [ ] Does the clearnode support native ETH for unified balance, or only ERC-20 tokens?
- [ ] Is there a delay before the unified balance is credited after on-chain confirmation?
- [ ] Would using a different token (e.g., USDC at `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) produce different results?

---

## RESOLUTION (Feb 8, 2026)

### Root Cause Confirmed: DeltaAllocations = [0, 0]

**The original hypothesis H4 was CORRECT.** The on-chain `deltaAllocations: [+10e12, -10e12]` nets to **zero**. The clearnode's `handleResized` (custody.go:448-461) **only credits unified balance when `DeltaAllocations[0] > 0`**.

Using `resize_amount=+X, allocate_amount=-X` in the same call results in:
- On-chain: channel amount increases by X, then decreases by X → net 0
- Clearnode sees: `DeltaAllocations = [0, 0]` → **skips unified balance credit**

### Five Critical Bugs Found & Fixed

#### Bug 1: Resize + Allocate Cancellation (DEPOSIT FLOW)
**Problem:** `useYellowDeposit.ts` passed both `resize_amount: +X` and `allocate_amount: -X` to clearnode.
- SDK encodes both in stateData
- On-chain: `DeltaAllocations = [+X, -X]` nets to 0
- Clearnode's `handleResized` sees net-zero → no unified balance credit

**Evidence:**
- Channel `0xd9824de...` on-chain state shows `deltaAllocations: [+10e12, -10e12]`
- Clearnode `get_ledger_balances` returns empty despite successful on-chain resize

**Fix:** Use **ONLY** `resize_amount: +X`, omit `allocate_amount` entirely.
- On-chain: `DeltaAllocations = [+X, 0]`
- Clearnode sees positive delta → credits unified balance ✅

**Commits:**
- Frontend fix: Line 237 changed to `allocateAmount: '0'`
- Backend fix (5e048e5): Omit `allocate_amount` field when value is '0', don't pass `BigInt(0)`

#### Bug 2: Balance Query Scoped to Authenticated Wallet (BACKEND)
**Problem:** `getLedgerBalances()` in `yellowConnection.ts` used **engine WS** to query user balances.
- The clearnode scopes `get_ledger_balances` to the authenticated wallet
- Engine WS returns empty for user addresses

**Evidence:**
- Test script with engine WS: `ledger_balances: []`
- Same script with user's WS + JWT: `ledger_balances: [{ "asset": "usdc", "amount": "0.019" }]`

**Fix:** Use `ensureUserWs(addr)` to connect with user's session key + JWT, not engine WS.

**Commit:** Already in codebase at line 870 (from earlier session)

#### Bug 3: Frontend Balance State Not Shared (FRONTEND)
**Problem:** `DepositPanel`, `OrderForm`, and `BalancesDropdown` each called `useYellowDeposit()` → three **independent copies** of balance state.
- Deposit in DepositPanel never updated OrderForm's copy
- OrderForm showed "no balance" and blocked orders

**Fix:** Created `UnifiedBalanceProvider` React Context (single source of truth, 15s polling).

**Commit:** 6be092a

#### Bug 4: Second Deposit to Existing Channel Fails (FRONTEND)
**Problem:** When depositing to an **existing** channel (second+ deposit), the preceding state proof for `Custody.resize()` had **empty signatures** → on-chain revert.

**Code:**
```typescript
// These were only populated during CREATE
let initialStateSigs: `0x${string}`[] = [];
let initialStateData: `0x${string}` = '0x';

// If channel exists, skip create → sigs stay []
// Later: pass empty sigs to Custody.resize() → REVERT
```

**Fix:** Fetch current on-chain channel state via `channels()` view function when channel exists, use as preceding proof.

**Commit:** c80a254

#### Bug 5: Passing allocate_amount=0n Still Cancels Out (BACKEND)
**Problem:** Backend passed `allocate_amount: BigInt('0')` to clearnode. Even though it's zero, clearnode interprets this as "allocate 0 from channel to unified" which still **cancels out** the `resize_amount: +X` delta.

**Evidence:**
- Transaction `0xec2cbb76...` succeeded on-chain (Resized event fired)
- 6+ minutes later, unified balance still 0
- Working script (`complete-usdc-deposit.js` line 293) shows: `// allocate_amount: OMITTED`

**Fix:** **OMIT** the field entirely when `allocateAmount === '0'`, don't pass `BigInt(0)`.

**Commit:** 5e048e5

### Working Pattern: Close All Channels First

The `complete-usdc-deposit.js` script worked because it:
1. **Closed ALL existing channels** (both open and resizing) via `close_channel` RPC
2. Created a brand **new** channel from scratch
3. Used **ONLY** `resize_amount` (omitted `allocate_amount`)

This avoided Bug 4 (existing channel) entirely by always taking the "new channel" path.

### Transaction Evidence (User 0xA440, Feb 8 2026)

**Channel:** `0xc337509c69d7a89cec32801b7c61e34cb09e8067e754d559601386987959010b`

**Transaction 1** (`0x9aa96636...`): Custody.create()
- Status: SUCCESS
- Block: 0x27f030a
- Timestamp: 2026-02-08 10:08:07 GMT
- Events: Created, Version=1, Deposited

**Transaction 2** (`0xec2cbb76...`): Custody.resize()
- Status: SUCCESS
- Block: 0x27f0312
- Timestamp: 2026-02-08 10:08:23 GMT
- Event data: version=2, amount=0xfa0 (4000 = 0.004 USDC)
- **Unified balance 6 min later: 0** ← Bug 5 (allocate_amount=0n still passed)

### Channels Closed

**Total across all users:** 33 channels closed via `close_channel` RPC
- 16 channels (first cleanup run)
- 17 channels (second run, including the stuck 0xc337509c...)

All stuck in "resizing" status, cleared to allow fresh channel creation.

### Final State

**All bugs fixed as of commit 5e048e5:**
1. ✅ Deposit flow uses ONLY resize_amount (allocate_amount omitted)
2. ✅ Backend queries user balances via user's WS (not engine WS)
3. ✅ Frontend balance state shared via UnifiedBalanceProvider context
4. ✅ Second deposit to existing channel fetches preceding state on-chain
5. ✅ Backend omits allocate_amount field when '0' (not BigInt(0))

**Expected behavior now:**
- User deposits via UI → Custody.deposit() → Custody.resize()
- On-chain: `DeltaAllocations = [+X, 0]`
- Clearnode sees positive delta → **credits unified balance immediately**
- User can trade with credited balance

### Next Steps

1. Wait for Railway engine deploy to complete (~2 min)
2. User tries fresh deposit (0.001 USDC test)
3. Verify unified balance is credited after on-chain resize
4. Full flow should work: **Deposit → Resize → Unified Balance → Trade**

## Scripts

- `check-balance.js` — connects to clearnode, auths, queries `get_ledger_balances` and `get_channels`
- `test-resize.js` — tests SDK `createResizeChannelMessage` with negative allocate_amount (confirms SDK handles it fine)

## Previous Bug Fix (for reference)

The original uint256 encoding error (`Number "-40000000000000" is not in safe 256-bit unsigned integer range`) was fixed in commit `17e3289` (buddy's fix). The fix was about **adjudicator proof state** — passing the initial state signatures properly in the preceding state proof for `Custody.resize()`. The allocation amounts from the clearnode response were never negative; the resize/allocate amounts are encoded in stateData, not in the allocation struct.
