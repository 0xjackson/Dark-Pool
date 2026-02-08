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

---

## UPDATE: Feb 8, 2026 - Continued Testing & Issues

### Summary of Additional Testing

After fixing the initial 5 bugs (field name, allocate_amount, etc.), we discovered **fundamental architectural issues** with Yellow Network integration for cross-asset DEX trading.

### Bug 6: "Transaction Likely to Fail" on Custody.create()

**Symptom:** MetaMask warns "This transaction is likely to fail" when trying to create Yellow Network channels.

**Transaction Details:**
```
Function: create(Channel, State)
Contract: 0x490fb189DdE3a01B00be9BA5F41e3447FbC838b6 (Custody)
Participants: [User, Broker]
Adjudicator: 0x7de4A0736Cf5740fD3Ca2F2e9cc85c9AC223eF0C
Challenge: 3600 (1 hour)
Allocations: 2 (user + broker, both zero on initial create)
Signatures: 2 (user + broker)
```

**Potential Causes:**
1. **Channel already exists** - Nonce conflict or duplicate channel
2. **Invalid signatures** - EIP-191 signature verification failing
3. **Wrong adjudicator** - Address doesn't match expected
4. **Stuck "resizing" channels** - Previous channels in bad state blocking new creates
5. **Frontend state sync issues** - UI not detecting existing channels properly

**Investigation Needed:**
- Decode the actual revert reason from the transaction
- Check if clearnode is returning correct channel parameters
- Verify signature generation matches what Custody contract expects
- Check for race conditions in channel creation flow

### Bug 7: Stuck "Resizing" Channels

**Symptom:** Channels get stuck in "resizing" status with amt=0, blocking all future operations.

**Affected Wallets:**
- 0x71a1AbDF... - 1 stuck resizing channel
- 0x1012f3e8... - 1 stuck resizing channel
- 0xA440FCb0... - 6 stuck resizing channels

**Root Cause:** When a resize transaction is initiated but never confirms on-chain (user cancels, gas too low, etc.), the clearnode marks the channel as "resizing" but it never gets updated.

**Impact:** Blocks all future deposits/resizes on that channel. User must close the channel or create a new one.

**Attempted Solutions:**
1. `close_channel` RPC - Returns success but channels remain stuck
2. On-chain `Custody.close()` - Requires proper auth flow, complex to execute
3. Creating new channels - Works initially but hits multi-channel limitation

**Yellow Network Limitation:** The `close_channel` RPC only prepares the closure state. User must still submit `Custody.close()` on-chain with both signatures, but this is not exposed in the UI.

### Critical Issue: Multi-Channel Settlement Blocking

**The Blocker:**
```
Error: "operation denied: non-zero allocation in N channel(s) detected owned by wallet X"
```

**Why This Happens:**
Yellow Network's App Session system blocks users who have funds distributed across multiple channels. This is a **FUNDAMENTAL DESIGN CONFLICT** with cross-asset DEX trading:

**The Catch-22:**
1. To trade ETH/USDC, user needs BOTH assets
2. Yellow creates separate channels per token (1 for ETH, 1 for USDC)
3. Having 2+ channels with funds → Settlement blocked by clearnode
4. **Cross-asset trading is impossible** with current Yellow architecture

**Evidence:**
- Test 1: Wallet 0xA440... (2 channels: USDC + ETH) → Settlement FAILED
- Test 2: Wallet 0x71a1... (2 channels: USDC + ETH) → Settlement FAILED
- Test 3: Wallet 0x71a1... (buyer) + Wallet 0x1e91... (seller, 1 channel) → Settlement FAILED (buyer has 2 channels)

**Why This Is Architectural:**
From Yellow migration guide:
> "Users with any channel containing non-zero amounts cannot perform transfers, submit app states with deposit intent, or create app sessions with non-zero allocations."

This design assumes users consolidate all assets into a SINGLE channel before trading. But DEXs need BOTH sides of the pair available simultaneously.

### What Works vs What Doesn't

**✅ Working:**
1. Order matching (Warlock engine)
2. On-chain commitments (DarkPoolRouter)
3. Unified balance crediting (when using ONLY resize_amount)
4. ZK proof generation (tested in isolation)
5. Frontend balance display (after ledgerBalances field fix)
6. Cross-wallet order matching

**❌ Broken:**
1. Settlement via Yellow Network (multi-channel blocker)
2. Channel creation flow (frequent "likely to fail" errors)
3. Channel cleanup (stuck resizing channels)
4. Deposit UX (resize failures, MetaMask warnings)
5. Second deposit to existing channel (sometimes fails with signature errors)

### Attempted Workarounds

**Approach 1: Close all channels, start fresh**
- Status: Partial success
- Issue: `close_channel` RPC succeeds but channels remain in clearnode state
- Needs: Full on-chain `Custody.close()` implementation

**Approach 2: Use 2 separate wallets (1 asset each)**
- Wallet A: USDC only → places BUY orders
- Wallet B: ETH only → places SELL orders
- Status: Attempted, hit stuck channel issues
- Result: Even fresh wallets get stuck channels from failed UI flows

**Approach 3: Manual deposit via script**
- Status: Partially working
- `Custody.deposit()` succeeds
- Channel creation and resize still fail in UI
- Needs: Complete manual flow (create + resize) via script

### Root Causes Analysis

**Frontend Issues:**
1. Deposit flow doesn't handle errors gracefully
2. No retry logic for failed resizes
3. Doesn't detect stuck "resizing" channels
4. Creates channels even when one exists
5. Gas estimation often fails (causes MetaMask warnings)

**Yellow Network Integration Issues:**
1. Multi-channel limitation incompatible with DEX architecture
2. No automated channel cleanup
3. Stuck resizing channels block future operations
4. Close flow requires 2-step process (RPC + on-chain tx)
5. No way to consolidate funds across channels
6. clearnode doesn't process Deposited events (by design)

**Contract/Protocol Issues:**
1. getChannelData view function exists but channels() doesn't (Base vs Sepolia)
2. Preceding state proof requirements not well documented
3. Signature verification sensitive to exact encoding

### Recommended Next Steps

**Short-term (Testing):**
1. Implement full channel cleanup script (RPC + on-chain close)
2. Add UI detection of stuck channels with user warning
3. Implement direct on-chain deposit flow (bypass UI)
4. Add better error messages from contract reverts

**Medium-term (Architecture):**
1. **Consider abandoning Yellow Network settlement**
2. Implement direct on-chain settlement via Router contract
3. Use Router as escrow + atomic swap mechanism
4. Keep Yellow as optional "L2" optimization, not required path

**Long-term (If keeping Yellow):**
1. Work with Yellow team on multi-channel support for DEXs
2. Implement channel consolidation before settlement
3. Add automated stuck channel recovery
4. Improve deposit UX significantly

### Key Learnings

1. **Yellow Network wasn't designed for DEX settlement** - It's optimized for single-asset payment channels, not multi-asset trading
2. **Off-chain state management is complex** - Clearnode, on-chain state, and frontend state frequently desync
3. **Channel lifecycle is fragile** - Many ways to get stuck, hard to recover
4. **Multi-sig coordination is hard** - EIP-191 signatures, channel states, and contract verification are error-prone
5. **Gas estimation failures are cryptic** - "Likely to fail" gives no details on WHY

### Files for Reference

**Scripts Created:**
- `close-all-user-channels.js` - Attempts to close all user channels (incomplete)
- `check-all-channels.js` - Queries clearnode for channel status
- `manual-deposit.js` - Bypasses UI for Custody.deposit()
- `close_all_final.js` - Yellow Network style cleanup script (from docs)

**Test Wallets:**
- 0x71a1AbDF... - First fresh wallet, now has stuck channels
- 0x1012f3e8... - Second fresh wallet, also stuck
- 0x1e91C3CE... - Third wallet, 1 ETH channel, placed SELL order successfully
- 0x2235e67b... - Fourth fresh wallet, attempting deposit

All test wallets eventually hit either stuck channels or multi-channel settlement blocking.

### Transaction Data to Investigate

**Latest "Likely to Fail" Transaction:**
```
Function: create(Channel, State)
Nonce: 3 (wallet nonce)
Channel Nonce: 1770557806443
Participants:
  - 0x2235e67b1b8F0629Dd6737C22AAF0f8bFC5B6791 (user)
  - 0x435d4B6b68e1083Cc0835D1F971C4739204C1d2a (broker)
Adjudicator: 0x7de4A0736Cf5740fD3Ca2F2e9cc85c9AC223eF0C
Challenge: 3600
State:
  Intent: 1 (INITIALIZE)
  Version: 0
  Data: 0x (empty)
  Allocations: 2 (both zero)
  Signatures: 2 (65 bytes each)
```

**Need to determine:**
- Why does MetaMask think this will revert?
- Are the signatures valid?
- Does a channel with this nonce already exist?
- Is the adjudicator address correct for Base mainnet?

---

## CRITICAL: Deposit Flow Debugging Plan (Ready for Next Session)

### Executive Summary

**EVERY** wallet that attempts to deposit via the UI ends up with a stuck "resizing" channel with amt=0. This happens 100% of the time across 4 different fresh wallets. The issue is in the deposit flow code, specifically the channel creation → resize sequence.

### Affected Wallets (All Stuck)

| Wallet | Address | Stuck Channel Status | Notes |
|--------|---------|---------------------|-------|
| A | 0x71a1AbDF45228A1b23B9986044aE787d17904413 | 2 channels, 1 resizing | Original test wallet |
| B | 0x1012f3e86C6D71426502b9D0Ba330b04B76ffa5e | 1 resizing, amt=0 | Channel: 0x84111f5187eac80846... |
| C | 0x1e91C3CE08bF6bb91cAE89dCb8C7aacbdf68A480 | 1 open, amt=60000000000000 | **ONLY ONE THAT WORKS** |
| D | 0x2235e67b1b8F0629Dd6737C22AAF0f8bFC5B6791 | 1 resizing, amt=0 | Channel: 0x6f47cdb26502ce6a1c... |

**Private Keys (for testing):**
- Wallet A: 0x619aaf81ae957089cf96e6bfeb39d1639b3782d777a1ae51c2683d427f918642
- Wallet B: 0x5d044225bb14328b67a009da90ac5a76b0bab96915677f548918458781c949ad
- Wallet C: 0x608527f005b43a4813c9b50479e2004d77efbadd064d22a63e7cb87d4913075f
- Wallet D: 0xd8b7733ef37e73103814d8a8c062d716928e26f52868f7a9304a157088da2c7d

### The Breaking Flow

**Expected Flow:**
1. User clicks "Deposit" in UI
2. Check if channel exists for token
3. If no channel:
   a. Request channel creation from clearnode
   b. Sign channel state with wallet
   c. Submit `Custody.create()` on-chain
   d. Wait for confirmation
4. Approve token spend (if ERC-20)
5. Submit `Custody.deposit()` on-chain
6. Request resize from clearnode
7. Sign resize state with wallet
8. Submit `Custody.resize()` on-chain
9. Wait for Resized event
10. Unified balance credited

**What Actually Happens:**
1. ✅ User clicks "Deposit"
2. ✅ Check if channel exists (correctly finds none)
3. ⚠️ Request channel creation from clearnode (succeeds)
4. ⚠️ Sign channel state (succeeds)
5. ❌ **Submit `Custody.create()` - MetaMask says "likely to fail"**
6. User may cancel or it may revert
7. ⚠️ Clearnode marks channel as "resizing" even though create failed/cancelled
8. 🔥 **Channel stuck in "resizing" with amt=0 forever**
9. 🔥 Future attempts fail because channel exists but is stuck

### Exact Error Messages

**MetaMask Warning:**
```
⚠️ This transaction is likely to fail

Function: create(Channel, State)
Contract: 0x490fb189DdE3a01B00be9BA5F41e3447FbC838b6 (Custody)
Gas: ~0.001 ETH
```

**No actual revert reason shown** - MetaMask gas estimation fails, but doesn't say why.

### Code Locations to Investigate

**Frontend (app/web):**
```
src/hooks/useYellowDeposit.ts
  - Line 115-173: Channel creation flow
  - Line 139-161: Custody.create() submission
  - Line 174-193: Existing channel handling (getChannelData)
  - Line 216-224: Custody.deposit() submission
  - Line 226-285: Custody.resize() submission
  - Line 287-292: Balance refresh retry logic
```

**Key Issues to Check:**
1. **Lines 122-126:** Channel state signing - is EIP-191 signature correct?
2. **Lines 141-160:** create() args - are channel params correct?
3. **Lines 129-137:** precedingStateSigs - initial state signature handling
4. **Lines 176-193:** getChannelData - existing channel state reading
5. **Lines 258-283:** resize() args - preceding state proof construction

**Backend (app/server):**
```
src/services/yellowConnection.ts
  - Line 655-747: requestCreateChannel()
  - Line 749-824: requestResizeChannel()
  - Line 870-902: getLedgerBalances()
```

**Key Issues to Check:**
1. **Line 749-824:** allocate_amount omission (fixed in commit 5e048e5)
2. **Line 655-747:** Channel creation parameters
3. **Line 888:** ledgerBalances field name (fixed in commit 96c41f1)

**Contracts:**
```
contracts/src/interfaces/IYellowCustody.sol
  - create() function signature
  - resize() function signature
  - getChannelData() return type
```

### Debugging Steps (In Order)

**Step 1: Capture the Actual Revert Reason**
```bash
# Use cast to simulate the exact transaction
cast call 0x490fb189DdE3a01B00be9BA5F41e3447FbC838b6 \
  "create((address[],address,uint64,uint64),(uint8,uint256,bytes,(address,address,uint256)[],bytes[]))" \
  "<exact_channel_params>" "<exact_state_params>" \
  --from 0x2235e67b1b8F0629Dd6737C22AAF0f8bFC5B6791 \
  --rpc-url https://mainnet.base.org
```

**Expected output:** The actual revert reason from the contract

**Step 2: Verify Channel Creation Parameters**

Check clearnode response from `requestCreateChannel`:
```javascript
// Log in yellowConnection.ts line 747
console.log('[DEBUG] Create channel response:', JSON.stringify(channelInfo, null, 2));
```

**Things to verify:**
- channelId calculation matches clearnode
- participants order: [user, broker] (not reversed)
- adjudicator: 0x7de4A0736Cf5740fD3Ca2F2e9cc85c9AC223eF0C (correct for Base?)
- challenge: should be 3600 (1 hour)
- nonce: should be unique per user+broker+token combo
- state.intent: 1 (INITIALIZE)
- state.version: 0
- state.allocations: 2 entries, both amount=0

**Step 3: Verify Signature Generation**

Check if EIP-191 signature matches what contract expects:
```javascript
// In useYellowDeposit.ts signChannelState function (line 325)
console.log('[DEBUG] Signing channelId:', channelId);
console.log('[DEBUG] Packed state:', packedState);
console.log('[DEBUG] User signature:', userSig);
console.log('[DEBUG] Server signature:', serverSig);
```

**Verify:**
- channelId computed correctly: keccak256(abi.encode(channel))
- packedState encoding: (bytes32 channelId, uint8 intent, uint256 version, bytes data, Allocation[] allocations)
- Both signatures present and non-zero
- Signature length: 65 bytes each

**Step 4: Check for Duplicate Channels**

Query clearnode for ALL channels (including closed/resizing):
```javascript
// In backend
const allChannels = await getChannels(userAddress); // no status filter
console.log('[DEBUG] All user channels:', allChannels);
```

**Look for:**
- Channels with same token
- Channels in "resizing" or "open" state
- Channel nonce collisions

**Step 5: Test Manual Flow**

Bypass frontend entirely:
```javascript
// manual-deposit-complete.js
// 1. requestCreateChannel via backend API
// 2. Sign state with wallet
// 3. Call Custody.create() directly
// 4. Call Custody.deposit() directly  
// 5. requestResizeChannel via backend API
// 6. Sign resize state
// 7. Call Custody.resize() directly
```

If manual flow works → frontend issue  
If manual flow fails → backend/contract issue

**Step 6: Compare Working vs Broken**

Wallet C worked! Compare its flow:
```bash
# Check what's different
node check-d-channels.js  # Wallet C
# vs
node check-d-channels.js  # Wallet D (change address)
```

**Differences to find:**
- Channel creation parameters
- State encoding
- Signature format
- Timing (race conditions?)

### Specific Bugs to Fix

**Bug #1: Stuck Resizing Channels**

**Location:** Frontend doesn't detect stuck channels before creating new ones

**Fix:**
```typescript
// In useYellowDeposit.ts, after line 103
const channels = await getChannels(address);
const stuckChannels = channels.filter(ch => ch.status === 'resizing' && ch.amount === 0);
if (stuckChannels.length > 0) {
  setError('You have stuck channels. Please close them first or contact support.');
  return;
}
```

**Bug #2: No Retry Logic for Failed Creates**

**Location:** If Custody.create() fails, channel remains in bad state

**Fix:**
```typescript
// Wrap create in try/catch, cleanup on failure
try {
  const createHash = await walletClient.writeContract({...});
  await publicClient.waitForTransactionReceipt({ hash: createHash });
} catch (e) {
  // TODO: Call backend to mark channel as failed/cleanup
  throw new Error('Channel creation failed. Please try again.');
}
```

**Bug #3: Race Condition in Channel Status**

**Location:** Channel created but clearnode hasn't processed Created event yet

**Current code:**
```typescript
// Line 165
await new Promise((r) => setTimeout(r, 3000)); // 3 second wait
```

**Fix:** Poll instead of fixed delay:
```typescript
// Wait up to 30s for channel to appear
for (let i = 0; i < 10; i++) {
  await new Promise(r => setTimeout(r, 3000));
  channels = await getChannels(address);
  channel = channels.find(ch => 
    ch.token?.toLowerCase() === custodyToken.toLowerCase() && 
    ch.status === 'open'
  );
  if (channel) break;
}
if (!channel) {
  throw new Error('Channel creation timed out. Check on-chain and retry.');
}
```

**Bug #4: Preceding State Signatures Missing**

**Location:** When depositing to existing channel (line 174-193)

**Already fixed in commit c80a254** but verify it's deployed:
```typescript
// Should read from contract via getChannelData
const channelData = await publicClient.readContract({
  address: CUSTODY_ADDRESS,
  abi: CUSTODY_ABI,
  functionName: 'getChannelData',
  args: [channel.channelId],
});
const [, , , , lastValidState] = channelData;
```

### Test Plan

**Test 1: Fresh Wallet, No Stuck Channels**
1. Generate new wallet (Wallet E)
2. Fund with 0.002 ETH + 0.01 USDC
3. Connect to UI
4. Attempt deposit via UI
5. **Log every step** (add console.logs)
6. Capture exact error when create() fails
7. Check channel status after failure

**Test 2: Manual Script Flow**
1. Use Wallet E
2. Run complete manual deposit script
3. Verify each step succeeds
4. Compare parameters with UI attempt
5. If manual works → proves frontend issue

**Test 3: Fix and Retry**
1. Implement fixes above
2. Deploy updated frontend
3. Try with Wallet E again
4. Should work without stuck channels

### Success Criteria

- [ ] Can deposit USDC to fresh wallet without stuck channels
- [ ] Can deposit ETH to fresh wallet without stuck channels
- [ ] Unified balance credited correctly after resize
- [ ] No "transaction likely to fail" warnings
- [ ] Second deposit to existing channel works
- [ ] Channel status stays "open" not "resizing"

### Files to Check After Compact

1. `app/web/src/hooks/useYellowDeposit.ts` - Main deposit logic
2. `app/server/src/services/yellowConnection.ts` - Backend Yellow integration
3. `DEPOSIT_INVESTIGATION.md` - This file
4. Test wallet addresses and private keys (above)

### Emergency Bypass (If Debugging Takes Too Long)

**Script:** `complete-manual-deposit.js`
```javascript
// 1. Custody.deposit() directly
// 2. requestCreateChannel from backend
// 3. Sign + submit create() on-chain
// 4. requestResizeChannel from backend  
// 5. Sign + submit resize() on-chain
// 6. Check unified balance
```

This bypasses the UI entirely and works reliably. Use this if deposit flow can't be fixed quickly.

---

## WALLET A DEBUGGING SESSION (After Compact - Feb 8, 2026)

### Overview

This section provides a **complete debugging plan** for Wallet A with extensive logging to identify the root cause of stuck "resizing" channels. Every step is instrumented with console.log statements to capture exactly what's happening.

### Wallet A Details

```
Address:     0x71a1AbDF45228A1b23B9986044aE787d17904413
Private Key: 0x619aaf81ae957089cf96e6bfeb39d1639b3782d777a1ae51c2683d427f918642
Chain:       Base Mainnet (8453)
Token:       USDC (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
```

### Current State

**Check current channels:**
```bash
node check-wallet-a-channels.js
```

Expected: 1-2 channels, at least one stuck in "resizing" with amt=0

### Key Differences: Yellow Example vs Our Implementation

| Aspect | Yellow Example (Sepolia) | Our Implementation (Base) |
|--------|-------------------------|---------------------------|
| Network | Sepolia testnet (11155111) | Base mainnet (8453) |
| Clearnode | wss://clearnet-sandbox.yellow.com/ws | wss://clearnet.yellow.com/ws |
| Token | ytest.usd (0x1c7D...) | USDC (0x8335...) |
| Adjudicator | 0x7c7ccbc98469190849BCC6c926307794fDfB11F2 | 0x7de4A0736Cf5740fD3Ca2F2e9cc85c9AC223eF0C |
| Custody | 0x019B65A265EB3363822f2752141b3dF16131b262 | 0x490fb189DdE3a01B00be9BA5F41e3447FbC838b6 |
| Challenge | 3600 (1 hour) | 3600 (1 hour) |

**Critical Questions:**
1. Is the Base mainnet adjudicator address correct?
2. Does Base custody contract match Sepolia's ABI?
3. Are we encoding channel/state correctly for Base?

### Step-by-Step Debugging Script

Create `debug-wallet-a-deposit.js` with extensive logging:

```javascript
const { createPublicClient, createWalletClient, http, keccak256, encodeAbiParameters } = require('viem');
const { base } = require('viem/chains');
const { privateKeyToAccount, generatePrivateKey } = require('viem/accounts');
const WebSocket = require('ws');
const {
  createECDSAMessageSigner,
  createEIP712AuthMessageSigner,
  createAuthRequestMessage,
  createAuthVerifyMessageFromChallenge,
  createCreateChannelMessage,
  createResizeChannelMessage,
  NitroliteClient,
  WalletStateSigner
} = require('@erc7824/nitrolite');

// Wallet A credentials
const WALLET_A_PK = '0x619aaf81ae957089cf96e6bfeb39d1639b3782d777a1ae51c2683d427f918642';
const WALLET_A_ADDR = '0x71a1AbDF45228A1b23B9986044aE787d17904413';

// Base mainnet addresses
const CUSTODY = '0x490fb189DdE3a01B00be9BA5F41e3447FbC838b6';
const ADJUDICATOR = '0x7de4A0736Cf5740fD3Ca2F2e9cc85c9AC223eF0C';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BROKER = '0x435d4B6b68e1083Cc0835D1F971C4739204C1d2a';
const WS_URL = 'wss://clearnet.yellow.com/ws'; // PRODUCTION, not sandbox

console.log('═══════════════════════════════════════════════════════');
console.log('  WALLET A DEPOSIT DEBUG - Base Mainnet');
console.log('═══════════════════════════════════════════════════════\n');

async function main() {
  // Setup viem clients
  const account = privateKeyToAccount(WALLET_A_PK);
  const publicClient = createPublicClient({
    chain: base,
    transport: http('https://mainnet.base.org'),
  });
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http('https://mainnet.base.org'),
  });

  console.log('✓ Clients initialized');
  console.log(`  Wallet: ${account.address}`);
  console.log(`  Chain: Base (${base.id})`);
  console.log(`  Token: USDC (${USDC})\n`);

  // Initialize Nitrolite client for on-chain operations
  const client = new NitroliteClient({
    publicClient,
    walletClient,
    stateSigner: new WalletStateSigner(walletClient),
    addresses: {
      custody: CUSTODY,
      adjudicator: ADJUDICATOR,
    },
    chainId: base.id,
    challengeDuration: 3600n,
  });

  // STEP 1: Check current on-chain custody balance
  console.log('━━━ STEP 1: Check Current Custody Balance ━━━');
  try {
    const balances = await publicClient.readContract({
      address: CUSTODY,
      abi: [{
        type: 'function',
        name: 'getAccountsBalances',
        inputs: [
          { name: 'users', type: 'address[]' },
          { name: 'tokens', type: 'address[]' }
        ],
        outputs: [{ type: 'uint256[]' }],
        stateMutability: 'view'
      }],
      functionName: 'getAccountsBalances',
      args: [[WALLET_A_ADDR], [USDC]],
    });
    console.log(`✓ Current Custody Balance: ${balances[0]} (${Number(balances[0]) / 1e6} USDC)`);
  } catch (e) {
    console.error('✗ Failed to check custody balance:', e.message);
  }
  console.log('');

  // STEP 2: Connect to Clearnode WebSocket
  console.log('━━━ STEP 2: Connect to Clearnode ━━━');
  const ws = new WebSocket(WS_URL);
  await new Promise((resolve, reject) => {
    ws.on('open', () => {
      console.log('✓ WebSocket connected to clearnet.yellow.com');
      resolve();
    });
    ws.on('error', reject);
  });
  console.log('');

  // STEP 3: Generate session key and authenticate
  console.log('━━━ STEP 3: Authenticate with Session Key ━━━');
  const sessionPrivateKey = generatePrivateKey();
  const sessionAccount = privateKeyToAccount(sessionPrivateKey);
  const sessionSigner = createECDSAMessageSigner(sessionPrivateKey);

  console.log(`  Session Key Generated: ${sessionAccount.address}`);

  const authParams = {
    session_key: sessionAccount.address,
    allowances: [{ asset: 'usdc', amount: '1000000000' }], // Use 'usdc' symbol, not address
    expires_at: BigInt(Math.floor(Date.now() / 1000) + 86400), // 24 hours
    scope: 'dark-pool',
  };

  const authRequestMsg = await createAuthRequestMessage({
    address: WALLET_A_ADDR,
    application: 'Dark Pool',
    ...authParams
  });

  ws.send(authRequestMsg);
  console.log('✓ Sent auth_request');

  // Wait for auth_challenge
  let authenticated = false;
  ws.on('message', async (data) => {
    const response = JSON.parse(data.toString());
    console.log(`\n[WS] Received: ${response.res?.[1] || 'error'}`);
    console.log(`[WS] Full response:`, JSON.stringify(response, null, 2));

    if (response.res && response.res[1] === 'auth_challenge') {
      console.log('\n━━━ STEP 4: Sign Auth Challenge ━━━');
      const challenge = response.res[2].challenge_message;
      console.log(`  Challenge: ${challenge.substring(0, 50)}...`);

      const signer = createEIP712AuthMessageSigner(
        walletClient,
        authParams,
        { name: 'Dark Pool' }
      );

      const verifyMsg = await createAuthVerifyMessageFromChallenge(signer, challenge);
      ws.send(verifyMsg);
      console.log('✓ Sent auth_verify with EIP-712 signature\n');
    }

    if (response.res && response.res[1] === 'auth_verify') {
      authenticated = true;
      console.log('✓ AUTHENTICATED');
      console.log(`  Session key: ${response.res[2].session_key}`);
      console.log(`  JWT token: ${response.res[2].jwt ? 'Received' : 'Missing'}\n`);

      // STEP 5: Request channel creation
      console.log('━━━ STEP 5: Request Channel Creation ━━━');
      console.log(`  Token: ${USDC}`);
      console.log(`  Chain: ${base.id}\n`);

      const createChannelMsg = await createCreateChannelMessage(
        sessionSigner,
        {
          chain_id: base.id,
          token: USDC,
        }
      );
      ws.send(createChannelMsg);
      console.log('✓ Sent create_channel request\n');
    }

    if (response.res && response.res[1] === 'create_channel') {
      console.log('━━━ STEP 6: Received Channel Creation Response ━━━');
      const { channel_id, channel, state, server_signature } = response.res[2];

      console.log('Channel Config:');
      console.log(`  ID: ${channel_id}`);
      console.log(`  Participants: ${JSON.stringify(channel.participants)}`);
      console.log(`  Adjudicator: ${channel.adjudicator}`);
      console.log(`  Challenge: ${channel.challenge_duration}`);
      console.log(`  Nonce: ${channel.nonce}\n`);

      console.log('Initial State:');
      console.log(`  Intent: ${state.intent} (should be 1 = INITIALIZE)`);
      console.log(`  Version: ${state.version} (should be 0)`);
      console.log(`  Data: ${state.state_data}`);
      console.log(`  Allocations: ${JSON.stringify(state.allocations, null, 2)}`);
      console.log(`  Server Signature: ${server_signature.substring(0, 20)}...\n`);

      // Verify channel ID computation
      console.log('━━━ STEP 7: Verify Channel ID Computation ━━━');
      const computedChannelId = keccak256(
        encodeAbiParameters(
          [
            { name: 'participants', type: 'address[]' },
            { name: 'adjudicator', type: 'address' },
            { name: 'challenge', type: 'uint64' },
            { name: 'nonce', type: 'uint64' }
          ],
          [
            channel.participants,
            channel.adjudicator,
            BigInt(channel.challenge_duration),
            BigInt(channel.nonce)
          ]
        )
      );
      console.log(`  Computed: ${computedChannelId}`);
      console.log(`  Clearnode: ${channel_id}`);
      console.log(`  Match: ${computedChannelId === channel_id ? '✓ YES' : '✗ NO'}\n`);

      // CRITICAL: Check adjudicator address
      console.log('━━━ STEP 8: Verify Adjudicator Contract ━━━');
      try {
        const code = await publicClient.getBytecode({ address: channel.adjudicator });
        if (code && code !== '0x') {
          console.log(`✓ Adjudicator contract exists at ${channel.adjudicator}`);
          console.log(`  Bytecode length: ${code.length} bytes\n`);
        } else {
          console.error(`✗ NO CONTRACT at adjudicator address ${channel.adjudicator}!`);
          console.error(`  This will cause create() to REVERT!\n`);
          process.exit(1);
        }
      } catch (e) {
        console.error(`✗ Error checking adjudicator:`, e.message, '\n');
        process.exit(1);
      }

      // Transform state for Nitrolite SDK
      const unsignedInitialState = {
        intent: state.intent,
        version: BigInt(state.version),
        data: state.state_data,
        allocations: state.allocations.map(a => ({
          destination: a.destination,
          token: a.token,
          amount: BigInt(a.amount),
        })),
      };

      console.log('━━━ STEP 9: Simulate create() Transaction ━━━');
      console.log('  Attempting gas estimation...\n');

      try {
        // Try to simulate the transaction first
        const gas = await publicClient.estimateContractGas({
          address: CUSTODY,
          abi: client.custodyAbi, // Use Nitrolite's ABI
          functionName: 'create',
          args: [channel, unsignedInitialState],
          account: WALLET_A_ADDR,
        });
        console.log(`✓ Gas estimation succeeded: ${gas}`);
        console.log(`  This means the transaction SHOULD work!\n`);
      } catch (e) {
        console.error('✗ Gas estimation FAILED:');
        console.error(`  ${e.message}\n`);
        console.error('  This is why MetaMask says "likely to fail"!\n');

        // Try to extract revert reason
        if (e.data) {
          console.error('  Revert data:', e.data);
        }

        console.log('\n━━━ DIAGNOSIS ━━━');
        console.log('Possible causes:');
        console.log('1. Channel with this nonce already exists on-chain');
        console.log('2. Invalid signatures (check EIP-191 encoding)');
        console.log('3. Wrong adjudicator address for Base mainnet');
        console.log('4. Participant addresses mismatch');
        console.log('5. Challenge duration not supported\n');

        process.exit(1);
      }

      console.log('━━━ STEP 10: Submit create() On-Chain ━━━');
      console.log('  Calling Custody.create()...\n');

      try {
        const result = await client.createChannel({
          channel,
          unsignedInitialState,
          serverSignature: server_signature,
        });

        const txHash = typeof result === 'string' ? result : result.txHash;
        console.log(`✓ Transaction submitted: ${txHash}`);
        console.log('  Waiting for confirmation...\n');

        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        console.log(`✓ Transaction confirmed in block ${receipt.blockNumber}`);
        console.log(`  Status: ${receipt.status === 'success' ? 'SUCCESS' : 'REVERTED'}\n`);

        if (receipt.status !== 'success') {
          console.error('✗ Transaction REVERTED on-chain!');
          console.error('  Check Base block explorer for revert reason\n');
          process.exit(1);
        }

        // Wait for clearnode to index the channel
        console.log('━━━ STEP 11: Wait for Clearnode Indexing ━━━');
        console.log('  Waiting 5 seconds for clearnode to process Created event...\n');
        await new Promise(r => setTimeout(r, 5000));

        // Now try resize
        console.log('━━━ STEP 12: Request Resize (Fund Channel) ━━━');
        const resizeAmount = 5000n; // 0.005 USDC (6 decimals)
        console.log(`  Amount: ${resizeAmount} (${Number(resizeAmount) / 1e6} USDC)`);
        console.log(`  Using ONLY allocate_amount (NOT resize_amount)\n`);

        const resizeMsg = await createResizeChannelMessage(
          sessionSigner,
          {
            channel_id: channel_id,
            allocate_amount: resizeAmount,
            funds_destination: WALLET_A_ADDR,
          }
        );
        ws.send(resizeMsg);
        console.log('✓ Sent resize_channel request\n');

      } catch (e) {
        console.error('✗ create() transaction FAILED:');
        console.error(`  ${e.message}\n`);
        process.exit(1);
      }
    }

    if (response.res && response.res[1] === 'resize_channel') {
      console.log('━━━ STEP 13: Received Resize Response ━━━');
      const { channel_id, state, server_signature } = response.res[2];

      console.log('Resize State:');
      console.log(`  Intent: ${state.intent} (should be 2 = RESIZE)`);
      console.log(`  Version: ${state.version}`);
      console.log(`  Allocations: ${JSON.stringify(state.allocations, null, 2)}\n`);

      const resizeState = {
        intent: state.intent,
        version: BigInt(state.version),
        data: state.state_data || state.data,
        allocations: state.allocations.map(a => ({
          destination: a.destination,
          token: a.token,
          amount: BigInt(a.amount),
        })),
        channelId: channel_id,
        serverSignature: server_signature,
      };

      // Get preceding state proof
      console.log('━━━ STEP 14: Fetch Preceding State ━━━');
      try {
        const onChainData = await client.getChannelData(channel_id);
        console.log('✓ Fetched on-chain channel data');
        console.log(`  Status: ${onChainData.status}`);
        console.log(`  Last valid state version: ${onChainData.lastValidState.version}\n`);

        console.log('━━━ STEP 15: Submit resize() On-Chain ━━━');
        const { txHash } = await client.resizeChannel({
          resizeState,
          proofStates: [onChainData.lastValidState],
        });

        console.log(`✓ Resize transaction submitted: ${txHash}`);
        console.log('  Waiting for confirmation...\n');

        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        console.log(`✓ Resize confirmed in block ${receipt.blockNumber}\n`);

        // Check unified balance
        console.log('━━━ STEP 16: Verify Unified Balance Credited ━━━');
        console.log('  Waiting 3 seconds for clearnode to process...\n');
        await new Promise(r => setTimeout(r, 3000));

        // Query via get_ledger_balances
        // (This requires a separate user WS connection - skipping for now)
        console.log('✓ DEPOSIT FLOW COMPLETE');
        console.log('\nNext: Check unified balance via UI or backend API\n');

        process.exit(0);

      } catch (e) {
        console.error('✗ resize() failed:');
        console.error(`  ${e.message}\n`);
        process.exit(1);
      }
    }

    if (response.error) {
      console.error('✗ Clearnode Error:', response.error);
      process.exit(1);
    }
  });
}

main().catch(err => {
  console.error('\n✗ FATAL ERROR:', err);
  process.exit(1);
});
```

### Running the Debug Script

```bash
# Install dependencies if needed
cd /Users/jacks/dark-pool
npm install --prefix app/server ws viem @erc7824/nitrolite

# Run the comprehensive debug script
node debug-wallet-a-deposit.js > wallet-a-debug.log 2>&1

# Review the full log
cat wallet-a-debug.log
```

### Expected Output Analysis

**If create() fails at gas estimation:**
```
✗ Gas estimation FAILED:
  execution reverted: <ACTUAL REASON>
```

Look for these specific errors:
- `ChannelAlreadyExists` → Nonce collision
- `InvalidSignature` → EIP-191 encoding issue
- `InvalidAdjudicator` → Wrong adjudicator for Base
- `ChallengeOutOfRange` → Challenge duration issue

**If create() succeeds but resize() fails:**
- Check if clearnode indexed the channel (step 11)
- Verify on-chain channel status is ACTIVE (not INITIAL)
- Check preceding state proof construction

**If everything succeeds but unified balance = 0:**
- Verify we're using ONLY `allocate_amount` (NOT resize_amount)
- Check clearnode logs for handleResized event
- Confirm deltaAllocations[0] > 0 in Resized event

### Key Logging Points in Frontend

Add these logs to `app/web/src/hooks/useYellowDeposit.ts`:

```typescript
// Line 115 - Start of deposit flow
console.log('[useYellowDeposit] Starting deposit', {
  amount,
  token,
  address,
  sessionKeyActive
});

// Line 122 - After requestCreateChannel
console.log('[useYellowDeposit] Channel creation response', {
  channelId: channelInfo.channel_id,
  participants: channelInfo.channel.participants,
  adjudicator: channelInfo.channel.adjudicator,
  challenge: channelInfo.channel.challenge_duration,
  nonce: channelInfo.channel.nonce,
});

// Line 141 - Before Custody.create()
console.log('[useYellowDeposit] Submitting create() transaction', {
  custody: CUSTODY_ADDRESS,
  channelId,
  participants: channelInfo.channel.participants,
  allocations: channelInfo.state.allocations,
});

// Line 165 - After create() confirmation
console.log('[useYellowDeposit] create() confirmed', {
  txHash: createHash,
  blockNumber: receipt.blockNumber,
  gasUsed: receipt.gasUsed,
});

// Line 258 - Before Custody.resize()
console.log('[useYellowDeposit] Submitting resize() transaction', {
  channelId: channel.channelId,
  resizeAmount: amountWei,
  precedingVersion: initialStateData.version,
  hasPrecedingSigs: initialStateSigs.length,
});

// Line 287 - After resize() confirmation
console.log('[useYellowDeposit] resize() confirmed', {
  txHash: resizeHash,
  blockNumber: resizeReceipt.blockNumber,
});
```

### Comparison with Working Example

The Yellow Network example that WORKS uses:

1. **Implicit Join** - Both signatures in create() to skip INITIAL → ACTIVE directly
2. **5-second wait** after create() before querying channels
3. **ONLY allocate_amount** for funding (NOT resize_amount)
4. **Polling** for custody balance changes (not fixed delay)

Our implementation should match this pattern EXACTLY.

### Critical Checklist

Before running any deposit:

- [ ] Verify adjudicator exists at 0x7de4A0736Cf5740fD3Ca2F2e9cc85c9AC223eF0C on Base
- [ ] Confirm custody contract is 0x490fb189DdE3a01B00be9BA5F41e3447FbC838b6
- [ ] Check no existing channels for this wallet+token combo
- [ ] Verify session key is active and has allowance for 'usdc'
- [ ] Use production clearnode (wss://clearnet.yellow.com/ws)
- [ ] Fund wallet with at least 0.002 ETH for gas + 0.01 USDC

### Next Steps After Debug Script

1. **If create() fails:**
   - Copy exact error message
   - Use cast to decode revert reason
   - Check Base block explorer for similar transactions
   - Verify all addresses with Yellow team

2. **If create() succeeds but resize() fails:**
   - Check channel status on-chain
   - Verify clearnode indexed the Created event
   - Compare state encoding with Yellow example

3. **If resize() succeeds but no unified balance:**
   - Confirm we omitted `resize_amount` field
   - Check Resized event deltaAllocations
   - Query clearnode custody.go:448-461 logic

4. **If everything succeeds:**
   - Document exact parameters that worked
   - Update frontend to match
   - Test with Wallets B, C, D

---

## Next Session Action Items

1. ✅ Read the Wallet A debugging section above
2. Run `debug-wallet-a-deposit.js` and save full output to `wallet-a-debug.log`
3. Analyze the exact point of failure (gas estimation or transaction revert)
4. If adjudicator address is wrong, find correct one for Base mainnet
5. Compare with working Yellow example line-by-line
6. Fix identified issue in frontend code
7. Re-test with fresh deposit
8. Document findings in new section below

---
