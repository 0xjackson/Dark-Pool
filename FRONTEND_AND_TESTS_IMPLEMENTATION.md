# Frontend Completion & Circuit Tests — Implementation Spec

This document covers the remaining frontend work and ZK circuit test infrastructure.

---

## What's Already Done (DO NOT REBUILD)

- `useSessionKey.ts` — Session key auth hook with create → sign → activate flow ✓
- `ConnectWallet.tsx` — Integrated with useSessionKey, shows auth status ✓
- `OrderForm.tsx` — Checks sessionKeyActive before enabling submit ✓
- `useSubmitTrade.ts` — Poseidon hash + orderId masking + depositAndCommit ✓
- `api.ts` — createSessionKey, activateSessionKey, submitOrder, fetch functions ✓
- `utils/poseidon.ts` — Nested Poseidon + maskOrderId + constants ✓
- `config/contracts.ts` — ROUTER_ABI with depositAndCommit, commitOnly, cancel, commitments ✓

---

## Part 1: Circuit Unit Tests

### Goal

Verify the Circom circuit (`circuits/settlementMatch.circom`) produces valid proofs for valid inputs and rejects invalid inputs. These tests use snarkjs in JavaScript (no Solidity needed).

### 1a. Install test dependencies

```bash
cd circuits
npm install --save-dev mocha chai snarkjs circomlibjs
```

Update `circuits/package.json` scripts:
```json
{
  "scripts": {
    "test": "mocha test/*.test.js --timeout 30000"
  }
}
```

### 1b. Create test helper

Create `circuits/test/helpers.js`:

```javascript
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
 * Returns { input, sellerDetails, buyerDetails }.
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
```

### 1c. Write the tests

Create `circuits/test/settlementMatch.test.js`:

```javascript
const { expect } = require('chai');
const { proveAndVerify, buildValidInput, computeOrderHash } = require('./helpers');

describe('SettlementMatch Circuit', function () {
  // Proof generation can take a few seconds
  this.timeout(30000);

  describe('Valid inputs', () => {
    it('should generate and verify a valid proof for a full fill', async () => {
      const { input } = await buildValidInput();
      const { valid } = await proveAndVerify(input);
      expect(valid).to.be.true;
    });

    it('should handle partial fills', async () => {
      const { input } = await buildValidInput({
        sellerFillAmount: '60',
        buyerFillAmount: '57', // 57/60 >= 90/100 (seller's min rate)
      });
      const { valid } = await proveAndVerify(input);
      expect(valid).to.be.true;
    });

    it('should handle second partial fill with settledSoFar > 0', async () => {
      const { input } = await buildValidInput({
        sellerFillAmount: '40',
        buyerFillAmount: '38',
        sellerSettledSoFar: '60',
        buyerSettledSoFar: '57',
      });
      const { valid } = await proveAndVerify(input);
      expect(valid).to.be.true;
    });

    it('should accept exact minimum slippage rate', async () => {
      // Seller: sell 100, min 90. Fill: 100 seller, 90 buyer.
      // Rate check: 90 * 100 >= 100 * 90 → 9000 >= 9000 ✓ (exactly equal)
      const { input } = await buildValidInput({
        sellerFillAmount: '100',
        buyerFillAmount: '90',
      });
      const { valid } = await proveAndVerify(input);
      expect(valid).to.be.true;
    });
  });

  describe('Hash verification', () => {
    it('should reject wrong seller commitment hash', async () => {
      const { input } = await buildValidInput();
      input.sellerCommitmentHash = '999999999'; // wrong hash
      try {
        await proveAndVerify(input);
        expect.fail('Should have thrown');
      } catch (err) {
        // Witness generation should fail (constraint not satisfied)
        expect(err.message).to.include('Assert Failed');
      }
    });

    it('should reject wrong buyer commitment hash', async () => {
      const { input } = await buildValidInput();
      input.buyerCommitmentHash = '999999999';
      try {
        await proveAndVerify(input);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Assert Failed');
      }
    });

    it('should reject tampered seller details (different sellAmount)', async () => {
      const { input } = await buildValidInput();
      input.sellerSellAmount = '200'; // tampered — hash won't match
      try {
        await proveAndVerify(input);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Assert Failed');
      }
    });
  });

  describe('Token matching', () => {
    it('should reject mismatched tokens (seller.sellToken != buyer.buyToken)', async () => {
      const { input } = await buildValidInput();
      input.sellerSellToken = '9999'; // not buyer.buyToken
      // Recompute seller hash with the wrong token
      input.sellerCommitmentHash = await computeOrderHash(
        input.sellerOrderId, input.sellerUser, '9999', input.sellerBuyToken,
        input.sellerSellAmount, input.sellerMinBuyAmount, input.sellerExpiresAt
      );
      try {
        await proveAndVerify(input);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Assert Failed');
      }
    });
  });

  describe('Expiry', () => {
    it('should reject expired seller order', async () => {
      const { input } = await buildValidInput({
        currentTimestamp: '9999999999', // same as expiresAt — NOT less than
      });
      // currentTimestamp must be STRICTLY less than expiresAt
      try {
        await proveAndVerify(input);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Assert Failed');
      }
    });

    it('should reject when timestamp equals expiry (must be strictly less)', async () => {
      // Rebuild with seller expiry = 5000, timestamp = 5000
      const { input } = await buildValidInput({
        currentTimestamp: '5000',
      });
      input.sellerExpiresAt = '5000';
      input.sellerCommitmentHash = await computeOrderHash(
        input.sellerOrderId, input.sellerUser, input.sellerSellToken, input.sellerBuyToken,
        input.sellerSellAmount, input.sellerMinBuyAmount, '5000'
      );
      try {
        await proveAndVerify(input);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Assert Failed');
      }
    });
  });

  describe('Overfill prevention', () => {
    it('should reject seller overfill', async () => {
      // sellAmount = 100, settledSoFar = 60, fillAmount = 50 → 60+50=110 > 100
      const { input } = await buildValidInput({
        sellerFillAmount: '50',
        sellerSettledSoFar: '60',
      });
      try {
        await proveAndVerify(input);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Assert Failed');
      }
    });

    it('should reject buyer overfill', async () => {
      // buyerSellAmount = 95, settledSoFar = 80, fillAmount = 20 → 80+20=100 > 95
      const { input } = await buildValidInput({
        buyerFillAmount: '20',
        buyerSettledSoFar: '80',
      });
      try {
        await proveAndVerify(input);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Assert Failed');
      }
    });

    it('should accept fill that exactly uses remaining capacity', async () => {
      // sellAmount = 100, settledSoFar = 60, fillAmount = 40 → 60+40=100 <= 100 ✓
      const { input } = await buildValidInput({
        sellerFillAmount: '40',
        buyerFillAmount: '38',
        sellerSettledSoFar: '60',
        buyerSettledSoFar: '57',
      });
      const { valid } = await proveAndVerify(input);
      expect(valid).to.be.true;
    });
  });

  describe('Slippage', () => {
    it('should reject bad seller rate', async () => {
      // Seller: sell 100, min 90 → min rate 0.9
      // Fill: 100 seller, 80 buyer → rate 0.8 < 0.9
      // Check: 80 * 100 >= 100 * 90 → 8000 >= 9000 → FALSE
      const { input } = await buildValidInput({
        sellerFillAmount: '100',
        buyerFillAmount: '80', // below seller's minimum
      });
      try {
        await proveAndVerify(input);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Assert Failed');
      }
    });

    it('should reject bad buyer rate', async () => {
      // Buyer: sell 95, min 90 → min rate 90/95 ≈ 0.947
      // Fill: 85 seller, 95 buyer → buyer gives 95, gets 85 → rate 85/95 ≈ 0.89 < 0.947
      // Check: 85 * 95 >= 95 * 90 → 8075 >= 8550 → FALSE
      const { input } = await buildValidInput({
        sellerFillAmount: '85',
        buyerFillAmount: '95',
      });
      try {
        await proveAndVerify(input);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Assert Failed');
      }
    });
  });

  describe('Poseidon hash consistency', () => {
    it('should match frontend/backend Poseidon implementation', async () => {
      // Use realistic hex values like real addresses
      const orderId = '0x1a2b3c4d5e6f';
      const user = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'; // vitalik.eth
      const sellToken = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'; // USDC
      const buyToken = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'; // WETH
      const sellAmount = '100000000'; // 100 USDC (6 decimals)
      const minBuyAmount = '50000000000000000'; // 0.05 WETH
      const expiresAt = '1707350400';

      const hash = await computeOrderHash(
        BigInt(orderId).toString(),
        BigInt(user).toString(),
        BigInt(sellToken).toString(),
        BigInt(buyToken).toString(),
        sellAmount, minBuyAmount, expiresAt
      );

      // The hash should be a valid field element (< SNARK_SCALAR_FIELD)
      const SNARK_SCALAR_FIELD = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');
      expect(BigInt(hash) < SNARK_SCALAR_FIELD).to.be.true;
      expect(BigInt(hash) > 0n).to.be.true;
    });
  });
});
```

### 1d. Run the tests

```bash
cd circuits && npm test
```

Expected: All valid-input tests generate proofs and verify. All invalid-input tests throw during witness generation (constraint violations).

---

## Part 2: Frontend ABI Updates

### 2a. Add proveAndSettle and markFullySettled to ROUTER_ABI

In `app/web/src/config/contracts.ts`, add these to the existing ROUTER_ABI array:

```typescript
// Add after the existing entries (cancel, commitments, etc.)
{
  name: 'proveAndSettle',
  type: 'function',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'sellerOrderId', type: 'bytes32' },
    { name: 'buyerOrderId', type: 'bytes32' },
    { name: 'sellerFillAmount', type: 'uint256' },
    { name: 'buyerFillAmount', type: 'uint256' },
    { name: 'a', type: 'uint256[2]' },
    { name: 'b', type: 'uint256[2][2]' },
    { name: 'c', type: 'uint256[2]' },
  ],
  outputs: [],
},
{
  name: 'markFullySettled',
  type: 'function',
  stateMutability: 'nonpayable',
  inputs: [{ name: 'orderId', type: 'bytes32' }],
  outputs: [],
},
{
  name: 'revealAndSettle',
  type: 'function',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'sellerOrderId', type: 'bytes32' },
    { name: 'buyerOrderId', type: 'bytes32' },
    {
      name: 'seller',
      type: 'tuple',
      components: [
        { name: 'orderId', type: 'bytes32' },
        { name: 'user', type: 'address' },
        { name: 'sellToken', type: 'address' },
        { name: 'buyToken', type: 'address' },
        { name: 'sellAmount', type: 'uint256' },
        { name: 'minBuyAmount', type: 'uint256' },
        { name: 'expiresAt', type: 'uint256' },
      ],
    },
    {
      name: 'buyer',
      type: 'tuple',
      components: [
        { name: 'orderId', type: 'bytes32' },
        { name: 'user', type: 'address' },
        { name: 'sellToken', type: 'address' },
        { name: 'buyToken', type: 'address' },
        { name: 'sellAmount', type: 'uint256' },
        { name: 'minBuyAmount', type: 'uint256' },
        { name: 'expiresAt', type: 'uint256' },
      ],
    },
    { name: 'sellerFillAmount', type: 'uint256' },
    { name: 'buyerFillAmount', type: 'uint256' },
  ],
  outputs: [],
},
```

**Note**: The frontend doesn't call these functions directly (only the engine does), but having them in the ABI enables:
- Reading settlement events from the contract
- Future tooling/debugging from the frontend
- Type generation for TypeScript if using wagmi codegen

---

## Part 3: WebSocket Settlement Notifications

### Goal

The backend already broadcasts settlement events via WebSocket (`settlementWorker.ts` lines 137-145). The frontend needs to listen for these to update the UI in real-time.

### 3a. Check existing WebSocket infrastructure

The backend WebSocket server is at `app/server/src/websocket/server.ts`. It broadcasts to channels like `matches:{userAddress}`.

### 3b. Create useSettlementUpdates hook

Create `app/web/src/hooks/useSettlementUpdates.ts`:

```typescript
import { useEffect, useCallback, useRef } from 'react';
import { useAccount } from 'wagmi';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:3001/ws';

interface SettlementEvent {
  type: 'settlement';
  data: {
    matchId: string;
    status: 'SETTLED' | 'FAILED';
    error?: string;
  };
  timestamp: string;
}

/**
 * Hook that listens for real-time settlement updates via WebSocket.
 * Calls onSettlement callback when a match settles or fails.
 */
export function useSettlementUpdates(onSettlement?: (event: SettlementEvent) => void) {
  const { address } = useAccount();
  const wsRef = useRef<WebSocket | null>(null);

  const connect = useCallback(() => {
    if (!address) return;

    const ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      // Subscribe to this user's settlement events
      ws.send(JSON.stringify({
        type: 'subscribe',
        channel: `matches:${address}`,
      }));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as SettlementEvent;
        if (data.type === 'settlement' && onSettlement) {
          onSettlement(data);
        }
      } catch {
        // ignore non-JSON messages
      }
    };

    ws.onclose = () => {
      // Reconnect after 5 seconds
      setTimeout(connect, 5000);
    };

    wsRef.current = ws;
  }, [address, onSettlement]);

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
    };
  }, [connect]);
}
```

**IMPORTANT**: Check the actual WebSocket server implementation in `app/server/src/websocket/server.ts` before implementing this hook. The subscription protocol (channel names, message format) must match exactly. Read the server file and adapt the hook accordingly. If the server uses a different message format, adjust the hook.

### 3c. Integrate with order/match views

In `useUserMatches.ts` or wherever matches are displayed:

```typescript
import { useSettlementUpdates } from './useSettlementUpdates';

// Inside the hook:
useSettlementUpdates((event) => {
  // Refetch matches when a settlement happens
  refetch();
  // Optionally show a toast notification
});
```

---

## Part 4: Balance Display & Withdrawal

### 4a. CustodyBalance component

Create `app/web/src/components/wallet/CustodyBalance.tsx`:

This component queries the Yellow Custody contract's `getAccountsBalances()` view function for the connected user. It displays token balances.

**Key details:**
- `getAccountsBalances()` is a public view function — no auth needed
- The Custody contract address comes from `NEXT_PUBLIC_CUSTODY_ADDRESS` env var
- Query on each new block or on a timer (every 15s)
- Show balances for configured tokens (USDC, WETH, etc.)

**IMPORTANT**: Before implementing, read the actual Custody contract interface in `.reference/nitrolite/contract/` to find the exact function signature for balance queries. The function name may be `getAccountsBalances`, `balanceOf`, or similar. Check the ABI.

### 4b. WithdrawButton component

Create `app/web/src/components/wallet/WithdrawButton.tsx`:

- Shows user's custody balance for a specific token
- Input field for withdrawal amount
- Calls `custody.withdrawal(token, amount)` on-chain via wallet signature
- Shows pending/confirmed states

**IMPORTANT**: Same as above — check the actual Custody contract for the withdrawal function signature.

---

## Part 5: Update TICKETS.md

After implementation, mark these tickets as done:

- ZK-004 (Circuit unit tests) — if circuit tests are written
- FE-004 (Balance display) — if CustodyBalance is built
- FE-005 (Withdrawal UI) — if WithdrawButton is built
- Any other completed items

---

## Ordering & Dependencies

```
1. Circuit unit tests ← standalone, no dependencies
2. Frontend ABI update ← standalone, just adding entries
3. WebSocket settlement hook ← depends on reading the WS server implementation
4. CustodyBalance component ← depends on finding Custody ABI
5. WithdrawButton component ← depends on CustodyBalance
```

Items 1 and 2 can be done in parallel. Item 3 needs the WS server code read first. Items 4-5 need the Custody contract interface.

---

## File Inventory

New files:
- `circuits/test/helpers.js` — Test helpers (proof generation, hash computation)
- `circuits/test/settlementMatch.test.js` — Circuit unit tests (~15 test cases)
- `app/web/src/hooks/useSettlementUpdates.ts` — WebSocket settlement listener
- `app/web/src/components/wallet/CustodyBalance.tsx` — Balance display
- `app/web/src/components/wallet/WithdrawButton.tsx` — Withdrawal UI

Modified files:
- `circuits/package.json` — Add mocha, chai, snarkjs, circomlibjs as devDependencies + test script
- `app/web/src/config/contracts.ts` — Add proveAndSettle, markFullySettled, revealAndSettle to ROUTER_ABI
- `app/web/src/hooks/useUserMatches.ts` — Integrate useSettlementUpdates for real-time refresh

---

## Verification Checklist

- [ ] `cd circuits && npm test` — all circuit tests pass (valid inputs verify, invalid inputs throw)
- [ ] Proof generation time < 5 seconds per test
- [ ] Poseidon hash in test matches frontend `computeOrderHash` output for identical inputs
- [ ] Frontend ABI includes proveAndSettle, markFullySettled, revealAndSettle
- [ ] `cd app/web && npm run build` — no TypeScript errors
- [ ] WebSocket hook connects and receives test messages (manual test)
- [ ] CustodyBalance shows balances for connected wallet (manual test against testnet)
- [ ] WithdrawButton successfully submits withdrawal tx (manual test against testnet)
