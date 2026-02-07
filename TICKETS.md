# Dark Pool — Implementation Tickets

Every ticket needed to go from current state to production. Organized by phase, ordered by dependency. Based on `SETTLEMENT_IMPLEMENTATION.md` and `IMPLEMENTATION_PLAN.md`.

---

## Phase 1: Contract Foundation

Contract is partially updated (IYellowCustody interface + depositAndCommit in docs). These tickets finish the base contract work.

### C-001: Update IYellowCustody interface to 3-param deposit
- **File:** `contracts/src/interfaces/IYellowCustody.sol`
- **Change:** `deposit(address token, uint256 amount)` → `deposit(address account, address token, uint256 amount) external payable`
- **Status:** Designed, code change staged but not committed
- **Blocks:** C-002, C-003

### C-002: Update depositAndCommit to credit user's balance
- **File:** `contracts/src/DarkPoolRouter.sol`
- **Change:** `custody.deposit(token, depositAmount)` → `custody.deposit(msg.sender, token, depositAmount)`
- **Status:** Designed, code change staged but not committed
- **Blocked by:** C-001

### C-003: Update MockYellowCustody for 3-param deposit
- **File:** `contracts/test/mocks/MockYellowCustody.sol`
- **Change:** Update `deposit` function signature to `deposit(address account, address token, uint256 amount) external payable`, track deposits by `account` instead of `msg.sender`
- **Status:** Designed, code change staged but not committed
- **Blocked by:** C-001

### C-004: Update existing Foundry tests for new deposit signature
- **File:** `contracts/test/DarkPoolRouter.t.sol`
- **Change:** Update `test_FullLifecycle` assertion from `custody.deposits(address(router), ...)` to `custody.deposits(alice, ...)`. Verify all 9 existing tests pass.
- **Blocked by:** C-003

---

## Phase 1b: Partial Fill Support

Add support for orders matching partially against multiple counterparties.

### PF-001: Add settledAmount to Commitment struct
- **File:** `contracts/src/DarkPoolRouter.sol`
- **Change:** Add `uint256 settledAmount` field to `Commitment` struct (default 0). Update `depositAndCommit` and `commitOnly` to include `settledAmount: 0` in commitment creation.
- **Blocks:** PF-002, PF-003, PF-004

### PF-002: Remove Settling status from enum
- **File:** `contracts/src/DarkPoolRouter.sol`
- **Change:** Remove `Settling` from `Status` enum → `{ None, Active, Settled, Cancelled }`. Remove `OrdersSettling` event or repurpose it as a per-match event.
- **Blocked by:** PF-001
- **Blocks:** PF-003

### PF-003: Update revealAndSettle for partial fills
- **File:** `contracts/src/DarkPoolRouter.sol`
- **Change:** Add `uint256 sellerFillAmount, uint256 buyerFillAmount` parameters. Replace total-amount slippage check with proportional: `buyerFillAmount * seller.sellAmount >= sellerFillAmount * seller.minBuyAmount`. Add overfill check: `sellerFillAmount <= seller.sellAmount - sellerC.settledAmount`. Increment `settledAmount` for both sides. Keep order `Active` (don't set to Settling).
- **Blocked by:** PF-001, PF-002

### PF-004: Simplify markFullySettled to per-order
- **File:** `contracts/src/DarkPoolRouter.sol`
- **Change:** Change signature from `markFullySettled(bytes32 sellerOrderId, bytes32 buyerOrderId)` to `markFullySettled(bytes32 orderId)`. Verify order is `Active` and engine is caller. Set to `Settled`. Update `OrdersSettled` event accordingly.
- **Blocked by:** PF-001

### PF-005: Update cancel to allow partially filled orders
- **File:** `contracts/src/DarkPoolRouter.sol`
- **Change:** Remove or adjust the restriction that prevents cancelling partially filled orders. Allow cancel on any `Active` order regardless of `settledAmount`. Cancels the unfilled remainder.
- **Blocked by:** PF-001

### PF-006: Foundry tests — partial fill happy path
- **File:** `contracts/test/DarkPoolRouter.t.sol`
- **Change:** New test: commit 100 ETH sell order + 60 ETH buy order. Call `revealAndSettle` with fill amounts (60, 60). Verify `settledAmount` = 60 for seller, seller still `Active`, buyer `Active` or `Settled`. Then settle remaining 40 with second buyer.
- **Blocked by:** PF-003

### PF-007: Foundry tests — proportional slippage
- **File:** `contracts/test/DarkPoolRouter.t.sol`
- **Change:** Test that proportional slippage check works: fill amount that satisfies rate but not total amount. Test that bad rate is rejected. Test edge cases: very small fills, zero fills (should revert).
- **Blocked by:** PF-003

### PF-008: Foundry tests — overfill prevention
- **File:** `contracts/test/DarkPoolRouter.t.sol`
- **Change:** Test that filling more than `sellAmount - settledAmount` reverts. Test cumulative fills across multiple settlements.
- **Blocked by:** PF-003

### PF-009: Foundry tests — cancel partially filled order
- **File:** `contracts/test/DarkPoolRouter.t.sol`
- **Change:** Test that a partially filled order can be cancelled. Verify status changes to `Cancelled`, no further settlements allowed.
- **Blocked by:** PF-005

### PF-010: Foundry tests — markFullySettled per-order
- **File:** `contracts/test/DarkPoolRouter.t.sol`
- **Change:** Test per-order `markFullySettled`. Verify seller can be marked settled independently from buyer. Verify only engine can call. Verify only `Active` orders can be marked.
- **Blocked by:** PF-004

---

## Phase 1c: ZK Private Settlement

Circom + Groth16 + Poseidon stack. Enables settlement without revealing order details on-chain.

### ZK-001: Install Circom toolchain ✅
- **Task:** Install `circom` compiler, `snarkjs`, download Powers of Tau ceremony file (e.g., `powersOfTau28_hez_final_15.ptau` for circuits up to 2^15 constraints).
- **Deliverable:** Build script or Makefile that compiles circuits and generates verifier
- **Blocks:** ZK-002, ZK-003
- **Done:** circom 2.2.2, snarkjs 0.7.6, pot15.ptau downloaded, `circuits/build.sh` created

### ZK-002: Write Circom settlement circuit ✅
- **File:** `circuits/settlementMatch.circom` (new)
- **Change:** Create circuit with 10 constraints: 2x Poseidon hash verification, 2x token match, 2x expiry check, 2x overfill check, 2x proportional slippage. Use `circomlib` Poseidon template. Define public/private inputs per spec in SETTLEMENT_IMPLEMENTATION.md.
- **Blocked by:** ZK-001
- **Blocks:** ZK-003, ZK-004
- **Done:** 4,576 constraints, 7 public + 14 private inputs, nested Poseidon hash verified

### ZK-003: Generate Groth16 trusted setup + Solidity verifier ✅
- **Task:** Run circuit-specific setup: `snarkjs groth16 setup`, `snarkjs zkey contribute`, `snarkjs zkey export verificationkey`, `snarkjs zkey export solidityverifier`. Output: `Groth16Verifier.sol`.
- **Files:** `circuits/build/` (artifacts), `contracts/src/Groth16Verifier.sol` (generated)
- **Blocked by:** ZK-002
- **Blocks:** ZK-005
- **Done:** Groth16Verifier.sol generated, WASM + zkey copied to `app/server/circuits/`

### ZK-004: Circuit unit tests ✅
- **File:** `circuits/test/settlementMatch.test.js` (new)
- **Change:** Test with valid inputs (proof generates and verifies). Test with invalid inputs (hash mismatch, expired, overfill, bad slippage — all should fail). Use `snarkjs` JS API to generate and verify proofs in tests.
- **Blocked by:** ZK-002
- **Done:** 16 tests covering full fills, partial fills, hash verification, token matching, expiry, overfill prevention, slippage, and Poseidon consistency. All pass.

### ZK-005: Add proveAndSettle to DarkPoolRouter ✅
- **File:** `contracts/src/DarkPoolRouter.sol`
- **Change:** Add `IZKVerifier` interface, `zkVerifier` immutable state variable (set in constructor). Add `proveAndSettle(bytes32 sellerOrderId, bytes32 buyerOrderId, uint256 sellerFillAmount, uint256 buyerFillAmount, uint256[2] a, uint256[2][2] b, uint256[2] c)` function. Verify proof via `zkVerifier.verifyProof()`, update `settledAmount`, emit event.
- **Blocked by:** ZK-003, PF-001
- **Blocks:** ZK-006
- **Done:** Reads commitment hashes + settledAmounts from storage as public inputs, prevents replay

### ZK-006: Foundry tests — proveAndSettle ✅
- **File:** `contracts/test/DarkPoolRouter.t.sol`
- **Change:** Tests using MockZKVerifier (always true) and RejectingZKVerifier (always false). Test valid proof settles correctly. Test invalid proof reverts. Test partial fills via ZK. Test access control. Test zero fill revert. Test cancelled order revert.
- **Blocked by:** ZK-005
- **Done:** 6 new tests, all 26 tests pass (20 original + 6 new)

### ZK-007: Update DarkPoolRouter constructor for ZK verifier ✅
- **File:** `contracts/src/DarkPoolRouter.sol`
- **Change:** Add `address _zkVerifier` parameter to constructor. Store as `IZKVerifier public immutable zkVerifier`. Update deployment script.
- **Blocked by:** ZK-005
- **Done:** Constructor now takes 3 params (custody, engine, zkVerifier)

### ZK-008: Update deployment script for ZK verifier ✅
- **File:** `contracts/script/DeployDarkPoolRouter.s.sol`
- **Change:** Deploy `ZKVerifier` first, then pass its address to `DarkPoolRouter` constructor. Uses `ZK_VERIFIER_ADDRESS` env var.
- **Blocked by:** ZK-007
- **Done:** Script updated to read ZK_VERIFIER_ADDRESS from env

---

## Phase 1d: Poseidon Hash Integration

Switch commitment hash from keccak256 to Poseidon across all layers.

### PH-001: Add Poseidon hash to frontend
- **File:** `app/web/src/hooks/useSubmitTrade.ts`
- **Change:** Replace `keccak256(encodeAbiParameters(...))` with Poseidon hash using shared utility from PH-004. Mask orderId to 253 bits for BN128 field compatibility (`BigInt(raw) & ((1n << 253n) - 1n)`). Ensure output is formatted as `bytes32` for contract.
- **Blocked by:** PH-004, INF-005
- **Blocks:** PH-003

### PH-002: Add Poseidon hash to backend commitment verifier
- **File:** `app/server/src/services/commitmentVerifier.ts`
- **Change:** Replace keccak256 hash computation with Poseidon using shared utility from PH-004. The anti-poisoning check now computes `poseidon(orderDetails)` and compares against on-chain `commitment.orderHash`.
- **Blocked by:** PH-004, INF-004
- **Blocks:** PH-003

### PH-003: Backend proof generation service ✅
- **File:** `app/server/src/services/proofGenerator.ts` (new)
- **Change:** Create service that takes two OrderDetails + fill amounts + settled amounts, constructs circuit inputs, calls `snarkjs.groth16.fullProve()`, returns serialized proof. Loads circuit WASM + zkey at startup. Exports `generateSettlementProof(sellerDetails, buyerDetails, fillAmounts, settledAmounts)`.
- **Blocked by:** ZK-002, ZK-003, PH-002
- **Blocks:** S-003
- **Done:** proofGenerator.ts created with Solidity-compatible proof output (reversed B coords)

### PH-004: Poseidon hash utility module
- **File:** `app/server/src/utils/poseidon.ts` (new), `app/web/src/utils/poseidon.ts` (new)
- **Change:** Shared utility that initializes Poseidon hasher from `circomlibjs`, exposes `computeOrderHash(orderId, user, sellToken, buyToken, sellAmount, minBuyAmount, expiresAt) → bytes32`. Uses nested two-step hash: `h1 = poseidon([orderId, user, sellToken, buyToken, sellAmount])` then `hash = poseidon([h1, minBuyAmount, expiresAt])`. Handles field element → bytes32 conversion (`poseidon.F.toString(hash, 16).padStart(64, '0')`). This nesting matches the on-chain PoseidonT6 + PoseidonT4 contracts exactly (poseidon-solidity ships T2-T6 only, not T8 for 7 inputs).
- **Blocked by:** INF-004, INF-005
- **Blocks:** PH-001, PH-002

### PH-005: Install poseidon-solidity in contracts
- **File:** `contracts/foundry.toml`, `contracts/src/DarkPoolRouter.sol`
- **Change:** `forge install poseidon-solidity/poseidon-solidity`. Add remapping to `foundry.toml`. Import `PoseidonT8` in DarkPoolRouter. This is needed for on-chain Poseidon hash verification in `revealAndSettle` fallback path. Battle-tested library (Tornado Cash, Semaphore, WorldID). ~100k gas per hash.
- **Blocks:** PH-006

### PH-006: Update revealAndSettle to use on-chain Poseidon
- **File:** `contracts/src/DarkPoolRouter.sol`
- **Change:** Replace `keccak256(abi.encode(seller))` with nested Poseidon: `h1 = PoseidonT6.hash([orderId, user, sellToken, buyToken, sellAmount])`, `hash = PoseidonT4.hash([h1, minBuyAmount, expiresAt])`. Import PoseidonT6 and PoseidonT4 from poseidon-solidity. Both settlement paths now verify against the same Poseidon commitment hash. Add `SNARK_SCALAR_FIELD` constant and field bounds checks in `depositAndCommit`.
- **Blocked by:** PH-005, PF-003
- **Blocks:** T-001

### PH-007: orderId field bounds — 253-bit masking
- **File:** `app/web/src/hooks/useSubmitTrade.ts`, `app/web/src/utils/poseidon.ts`
- **Change:** Mask orderId to 253 bits after keccak256 generation: `BigInt(raw) & ((1n << 253n) - 1n)`. This ensures orderId < SNARK_SCALAR_FIELD (~2^254), which is required by the snarkjs Groth16 verifier. 253-bit IDs still give ~10^76 unique values.
- **Blocked by:** PH-004
- **Blocks:** PH-001

---

## Phase 2: Database Migration

New tables and columns for session keys and settlement tracking.

### DB-001: Create session_keys table
- **File:** `warlock/migrations/002_settlement_and_session_keys.up.sql` (new)
- **Change:** Create `session_keys` table with columns: `id`, `user_address`, `session_key_address`, `encrypted_private_key`, `jwt_token`, `application`, `allowances` (JSONB), `expires_at`, `status` (PENDING/ACTIVE/EXPIRED/REVOKED), `created_at`. Add unique constraint on `(user_address, session_key_address)`. Add index on `(user_address, status)`.
- **Blocks:** SK-001

### DB-002: Add settlement columns to matches table (partially done)
- **File:** `warlock/migrations/002_settlement_and_session_keys.up.sql`
- **Change:** `ALTER TABLE matches ADD COLUMN` for: `app_session_id VARCHAR(66)`, `reveal_tx_hash VARCHAR(66)`, `settle_tx_hash VARCHAR(66)`, `settlement_error TEXT`, `settled_at TIMESTAMP`.
- **Blocks:** S-003
- **Note:** `settle_tx_hash` and `settled_at` added in migration 003 (ZK order fields). Remaining: `app_session_id`, `reveal_tx_hash`, `settlement_error`.

### DB-003: Drop stale EIP-712 columns from orders table
- **File:** `warlock/migrations/002_settlement_and_session_keys.up.sql`
- **Change:** `ALTER TABLE orders DROP COLUMN` for: `order_signature`, `order_data`, `revealed`, `revealed_at`. These are EIP-712 remnants no longer used.
- **Blocks:** DB-004

### DB-004: Update Warlock Go queries for dropped columns
- **Files:** `warlock/internal/db/postgres.go`, `warlock/internal/matcher/algorithm.go`
- **Change:** Search all Go code for references to `order_signature`, `order_data`, `revealed`, `revealed_at`. Remove from SELECT statements, INSERT statements, scan destinations. Verify Warlock builds and tests pass.
- **Blocked by:** DB-003

### DB-005: Create down migration
- **File:** `warlock/migrations/002_settlement_and_session_keys.down.sql` (new)
- **Change:** Reverse of up migration: drop `session_keys` table, drop added columns from `matches`, re-add dropped columns to `orders`.

---

## Phase 3: Session Key Infrastructure (Backend)

Backend endpoints and services for session key management.

### SK-001: Session key generation endpoint
- **File:** `app/server/src/routes/sessionKeys.ts` (new)
- **Change:** `POST /api/session-key/generate` — accepts `{ userAddress }`. Checks DB for existing ACTIVE non-expired key (return it if found). Otherwise: generate ECDSA keypair (`viem` `generatePrivateKey`), encrypt private key with AES-256-GCM using `SESSION_KEY_ENCRYPTION_SECRET`, store in `session_keys` table with status PENDING. Return `{ sessionKeyAddress, allowances, expiresAt }`.
- **Blocked by:** DB-001, SK-002
- **Blocks:** SK-003

### SK-002: AES-256-GCM encryption/decryption helpers
- **File:** `app/server/src/utils/encryption.ts` (new)
- **Change:** `encryptSessionKey(privateKey: string, secret: string) → string` (base64 of iv + authTag + ciphertext). `decryptSessionKey(encrypted: string, secret: string) → string`. Use Node.js `crypto` module. 12-byte IV, 16-byte auth tag.
- **Blocks:** SK-001, SK-004

### SK-003: Session key confirmation endpoint
- **File:** `app/server/src/routes/sessionKeys.ts`
- **Change:** `POST /api/session-key/confirm` — accepts `{ userAddress, jwt }`. Updates session key status from PENDING to ACTIVE. Stores JWT token as backup reference.
- **Blocked by:** SK-001

### SK-004: Session key retrieval for settlement
- **File:** `app/server/src/services/sessionKeyService.ts` (new)
- **Change:** `getActiveSessionKey(userAddress: string) → { address, decryptedPrivateKey }`. Queries DB for ACTIVE non-expired key, decrypts, returns. Used by settlement service. Returns null if no valid key found.
- **Blocked by:** SK-002, DB-001
- **Blocks:** S-003

### SK-005: Session key cleanup service
- **File:** `app/server/src/services/sessionKeyService.ts`
- **Change:** `markExpiredKeys()` — periodic job that marks EXPIRED any ACTIVE keys past `expires_at`. `revokeSessionKey(userAddress: string)` — marks key as REVOKED in DB and sends `revoke_session_key` message to Yellow via engine WS.
- **Blocked by:** SK-004

### SK-006: Register session key routes in Express
- **File:** `app/server/src/server.ts`
- **Change:** Import session key routes, mount at `/api/session-key`. Add `SESSION_KEY_ENCRYPTION_SECRET` to env config validation.
- **Blocked by:** SK-001, SK-003

---

## Phase 4: Frontend Session Key Flow

Frontend hooks and components for session key authorization at wallet connect.

### FE-001: Session key auth hook
- **File:** `app/web/src/hooks/useSessionKeyAuth.ts` (new)
- **Change:** Hook that: (1) calls `/api/session-key/generate` on wallet connect, (2) if key is PENDING: opens WS to Yellow, sends `createAuthRequestMessage`, receives challenge, creates EIP-712 signer via `createEIP712AuthMessageSigner`, prompts user to sign, sends `createAuthVerifyMessageFromChallenge`, receives JWT, calls `/api/session-key/confirm`, closes WS. (3) if key is ACTIVE: skip auth. Exports `{ isSessionKeyActive, isAuthenticating, error }`.
- **Blocked by:** SK-001, SK-003
- **Blocks:** FE-002

### FE-002: Integrate session key auth with wallet connect flow
- **File:** `app/web/src/hooks/useWalletConnection.ts` or `app/web/src/providers/WagmiProvider.tsx`
- **Change:** After successful wallet connect, trigger `useSessionKeyAuth`. Show loading state while auth is in progress. Handle errors (user rejects signature, Yellow WS fails). Store auth state in context.
- **Blocked by:** FE-001

### FE-003: Update useSubmitTrade for Poseidon hash
- **File:** `app/web/src/hooks/useSubmitTrade.ts`
- **Change:** Replace `keccak256(encodeAbiParameters(...))` with Poseidon hash computation using shared utility from PH-004. Ensure hash matches what backend expects and what circuit will verify.
- **Blocked by:** PH-004

### FE-004: Balance display component ✅
- **File:** `app/web/src/components/wallet/CustodyBalance.tsx` (new)
- **Change:** Component that queries `Custody.getAccountsBalances()` on-chain for the connected user. Displays balances for supported tokens. Auto-refreshes on new blocks or after settlements. No auth needed (public view function).
- **Blocks:** FE-005
- **Done:** Queries Yellow Custody getAccountsBalances() for connected wallet, shows all chain tokens, refreshes every 15s

### FE-005: Withdrawal UI ✅
- **File:** `app/web/src/components/wallet/WithdrawButton.tsx` (new)
- **Change:** Button/modal that lets user withdraw from Yellow Custody. Calls `custody.withdraw(token, amount)` on-chain. Shows balance, lets user input amount, confirms via wallet signature.
- **Blocked by:** FE-004
- **Done:** Inline withdraw input with MAX button, calls custody.withdraw(token, amount), shows pending/confirmed/success states

### FE-006: Install Nitrolite SDK
- **File:** `app/web/package.json`
- **Change:** `npm install @erc7824/nitrolite`. Verify types are available. Add to tsconfig paths if needed.
- **Blocks:** FE-001

---

## Phase 5: Settlement Service (Backend)

The core settlement pipeline — picks up matches, settles via ZK + Yellow.

### S-001: Yellow Network WebSocket client
- **File:** `app/server/src/services/yellowClient.ts` (new)
- **Change:** Persistent WS connection to Yellow. Auto-reconnect on disconnect. Message send/receive with request-response matching. Methods: `send(message) → response`, `onMessage(handler)`. Configurable URL via `YELLOW_WS_URL` env var.
- **Blocks:** S-002

### S-002: Engine boot and authentication
- **File:** `app/server/src/services/engineAuth.ts` (new)
- **Change:** On server start: load `ENGINE_WALLET_KEY` and `ENGINE_SESSION_KEY` from env. Connect to Yellow WS. Execute auth flow: `createAuthRequestMessage` → receive challenge → sign EIP-712 with engine wallet → `createAuthVerifyMessageFromChallenge` → receive JWT. Query `get_assets` and build token-address-to-symbol map. Schedule re-auth every ~23h.
- **Blocked by:** S-001
- **Blocks:** S-003

### S-003: Settlement worker — match consumer
- **File:** `app/server/src/services/settlementWorker.ts` (new)
- **Change:** Polls DB for `settlement_status = 'PENDING'` matches. For each: load both users' session keys (SK-004), generate ZK proof (PH-003), call `proveAndSettle` on-chain (engine wallet signs tx), update match status to SETTLING. Falls back to `revealAndSettle` if proof generation fails (see S-003b).
- **Blocked by:** S-002, SK-004, PH-003, ZK-005, DB-002, S-009
- **Blocks:** S-004

### S-003b: Settlement worker — revealAndSettle fallback path
- **File:** `app/server/src/services/settlementWorker.ts`
- **Change:** If `proveAndSettle` fails due to proof generation error, fall back to `revealAndSettle` with full order details as calldata. Load OrderDetails from DB, construct calldata, submit via engine wallet. Log that fallback was used. This allows settlement testing before ZK circuits are ready, and provides a production fallback if proof generation fails.
- **Blocked by:** S-003, PF-003
- **Blocks:** S-007

### S-004: Settlement pipeline — App Session create
- **File:** `app/server/src/services/settlementWorker.ts`
- **Change:** After `proveAndSettle` succeeds: look up asset symbols from cached map. Create App Session message signed with seller's session key (`createECDSAMessageSigner` + `createAppSessionMessage`). Add buyer's session key signature. Send multi-signed message over engine WS. Parse response for `appSessionId`. Update match record.
- **Blocked by:** S-003
- **Blocks:** S-005

### S-005: Settlement pipeline — App Session close
- **File:** `app/server/src/services/settlementWorker.ts`
- **Change:** Create close message with swapped allocations signed by engine session key (`createCloseAppSessionMessage`). Send over engine WS. Parse response. App Session is now closed — funds are atomically swapped in Yellow custody.
- **Blocked by:** S-004
- **Blocks:** S-006

### S-006: Settlement pipeline — on-chain finalization
- **File:** `app/server/src/services/settlementWorker.ts`
- **Change:** Call `router.markFullySettled(orderId)` for each order that is fully filled (check `settledAmount == sellAmount` or all matches settled). Update match record: `settlement_status = 'SETTLED'`, `settle_tx_hash`, `settled_at`. Notify users via WebSocket.
- **Blocked by:** S-005

### S-007: Settlement error handling and retries
- **File:** `app/server/src/services/settlementWorker.ts`
- **Change:** Handle failure at each step: session key missing/expired → FAILED + notify user. `proveAndSettle` reverts → FAILED + log reason (don't retry deterministic failures). Yellow WS drops → reconnect + retry from last successful step. App Session creation fails → retry with backoff (max 3). Close fails → retry with backoff. All errors logged and stored in `settlement_error` column.
- **Blocked by:** S-003, S-004, S-005, S-006

### S-008: WebSocket notifications to users
- **File:** `app/server/src/websocket/server.ts`
- **Change:** Add settlement event broadcasting. When match settles: `wsServer.broadcast('matches:{userAddress}', { type: 'settled', matchId })`. When settlement fails: `wsServer.broadcast('matches:{userAddress}', { type: 'settlement_failed', matchId, error })`.
- **Blocked by:** S-006

### S-009: Engine wallet management
- **File:** `app/server/src/services/engineWallet.ts` (new)
- **Change:** Load `ENGINE_WALLET_KEY` from env. Create viem wallet client for on-chain transactions (`proveAndSettle`, `revealAndSettle`, `markFullySettled`). Handle nonce management for sequential transactions. Monitor ETH balance for gas.
- **Blocks:** S-003

### S-010: Install Nitrolite SDK in backend
- **File:** `app/server/package.json`
- **Change:** `npm install @erc7824/nitrolite viem`. Verify SDK functions are importable and types work.
- **Blocks:** S-001, S-002

---

## Phase 6: Testing

Comprehensive tests across all layers.

### T-001: Contract tests — full lifecycle with partial fills
- **File:** `contracts/test/DarkPoolRouter.t.sol`
- **Change:** E2E test: commit order A (100 ETH) + order B (60 ETH). revealAndSettle for 60. Verify settledAmount. Commit order C (40 ETH). revealAndSettle for 40. markFullySettled for A. Verify all states.
- **Blocked by:** PF-003, PF-004

### T-002: Contract tests — proveAndSettle with real ZK proofs
- **File:** `contracts/test/DarkPoolRouter.t.sol`
- **Change:** Generate real Groth16 proofs in test setup. Submit via `proveAndSettle`. Verify correct settlement. Test invalid proofs are rejected.
- **Blocked by:** ZK-005, ZK-006

### T-003: Backend tests — session key endpoints
- **File:** `app/server/test/sessionKeys.test.ts` (new)
- **Change:** Test `/api/session-key/generate` — new user gets new key, existing active key is returned. Test `/api/session-key/confirm` — status changes to ACTIVE. Test encryption round-trip. Test expired key cleanup.
- **Blocked by:** SK-001, SK-003

### T-004: Backend tests — proof generation
- **File:** `app/server/test/proofGenerator.test.ts` (new)
- **Change:** Test that `generateSettlementProof` produces valid proofs for valid inputs. Test that proofs verify correctly via snarkjs. Test various order configurations (different amounts, tokens, expiry).
- **Blocked by:** PH-003

### T-005: Backend tests — settlement pipeline with mocks
- **File:** `app/server/test/settlementWorker.test.ts` (new)
- **Change:** Mock Yellow WS, mock on-chain calls, mock DB. Test full pipeline: load match → generate proof → proveAndSettle → create App Session → close → markFullySettled. Test failure at each step. Test retry logic.
- **Blocked by:** S-003, S-004, S-005, S-006, S-007

### T-006: E2E test — deposit → commit → match → prove → settle
- **File:** `test/e2e-settlement.sh` or `test/e2e-settlement.ts` (new)
- **Change:** Full flow against local testnet + local Warlock + local backend: deploy contracts, deposit tokens, commit orders, trigger match, wait for settlement, verify custody balances changed, verify on-chain status.
- **Blocked by:** All Phase 1-5 tickets

### T-007: E2E test — partial fill across multiple counterparties
- **File:** `test/e2e-partial-fills.ts` (new)
- **Change:** User A sells 100 ETH. User B buys 40. User C buys 60. Verify two separate settlements occur. Verify A's final settled amount = 100. Verify B and C each received correct amounts.
- **Blocked by:** T-006

### T-008: E2E test — cancellation flows
- **File:** `test/e2e-cancel.ts` (new)
- **Change:** Cancel before match. Cancel after partial fill. Verify cancelled orders can't be settled further. Verify funds remain in custody and are withdrawable.
- **Blocked by:** T-006

### T-009: E2E test — expired session key handling
- **File:** `test/e2e-expired-key.ts` (new)
- **Change:** Create match, expire session key, attempt settlement. Verify FAILED status and error message. Re-authorize session key, verify settlement succeeds on retry.
- **Blocked by:** T-006

### T-010: Frontend tests — session key auth flow
- **File:** `app/web/test/useSessionKeyAuth.test.ts` (new)
- **Change:** Test hook with mocked WS and wallet client. Verify auth flow executes correctly. Verify skip when active key exists. Verify error handling on signature rejection.
- **Blocked by:** FE-001

---

## Phase 7: Cross-Chain Deployment

Deploy to multiple chains and enable cross-chain settlement via Yellow unified balance.

### CC-001: Deploy DarkPoolRouter to Base Sepolia (testnet)
- **Task:** Run Foundry deployment script targeting Base Sepolia. Verify contract works on a second chain. Record deployment address.
- **Blocked by:** All Phase 1 contract tickets
- **Blocks:** CC-003

### CC-002: Deploy DarkPoolRouter to Polygon Amoy (testnet)
- **Task:** Run Foundry deployment script targeting Polygon Amoy. Record deployment address.
- **Blocked by:** All Phase 1 contract tickets
- **Blocks:** CC-003

### CC-003: Backend — multi-chain contract address config
- **File:** `app/server/src/config/contracts.ts` (new or updated)
- **Change:** Map of chain ID → Router address + Custody address. Engine reads contracts for all configured chains. Settlement service routes on-chain calls to correct chain based on order's deposit chain.
- **Blocked by:** CC-001, CC-002

### CC-004: Backend — track deposit chain per order
- **File:** `warlock/migrations/003_cross_chain.up.sql` (new)
- **Change:** `ALTER TABLE orders ADD COLUMN deposit_chain_id INTEGER`. Warlock stores which chain the user deposited on. Matching remains chain-agnostic (matches across chains).
- **Blocks:** CC-005

### CC-005: Backend — cross-chain settlement routing
- **File:** `app/server/src/services/settlementWorker.ts`
- **Change:** When settling a cross-chain match, the settlement service uses Yellow's unified balance (chain-agnostic). The `proveAndSettle` call goes to the chain where the Router holds the commitment. The App Session operates off-chain via unified balance. `markFullySettled` goes to the appropriate chain per order.
- **Blocked by:** CC-003, CC-004

### CC-006: Frontend — chain selector for deposit
- **File:** `app/web/src/components/trading/ChainSelector.tsx` (new)
- **Change:** Dropdown to select which chain to deposit on. Switches wagmi chain. Shows Router address for selected chain. Persists selection.
- **Blocks:** CC-007

### CC-007: Frontend — multi-chain balance display
- **File:** `app/web/src/components/wallet/CustodyBalance.tsx`
- **Change:** Query `getAccountsBalances` on each supported chain's Custody contract. Aggregate balances across chains. Show per-chain breakdown.
- **Blocked by:** CC-006, FE-004

### CC-008: Frontend — multi-chain withdrawal
- **File:** `app/web/src/components/wallet/WithdrawButton.tsx`
- **Change:** Let user select which chain to withdraw on. Switch chain if needed. Call custody withdrawal on selected chain.
- **Blocked by:** CC-007, FE-005

### CC-009: E2E test — cross-chain settlement
- **Task:** User A deposits on chain 1, User B deposits on chain 2. Match in Warlock. Settle via Yellow unified balance. Verify both users' balances updated correctly on their respective chains.
- **Blocked by:** CC-005, T-006

---

## Infrastructure & Config

### INF-001: Add environment variables
- **File:** `.env.example`
- **Change:** Add: `ENGINE_WALLET_KEY`, `ENGINE_SESSION_KEY`, `SESSION_KEY_ENCRYPTION_SECRET`, `YELLOW_WS_URL`, `YELLOW_CUSTODY_ADDRESS`, `YELLOW_ADJUDICATOR_ADDRESS`, `ROUTER_ADDRESS`.
- **Blocks:** S-002, SK-002

### INF-002: Docker Compose — add settlement service config
- **File:** `docker-compose.yml`
- **Change:** Add environment variables to backend service. Ensure backend can reach Yellow WS URL. Add health check for Yellow WS connection.
- **Blocked by:** INF-001

### INF-003: Circuit build pipeline
- **File:** `circuits/Makefile` or `circuits/build.sh` (new)
- **Change:** Script that: compiles Circom circuit, runs Groth16 trusted setup, generates Solidity verifier, copies verifier to `contracts/src/`, copies WASM + zkey to `app/server/circuits/` for proof generation. Run as part of contract build.
- **Blocked by:** ZK-001, ZK-002

### INF-004: Add snarkjs and circomlibjs to backend dependencies
- **File:** `app/server/package.json`
- **Change:** `npm install snarkjs circomlibjs`. Add circuit artifacts (WASM + zkey) to backend assets or configure path via env var.
- **Blocked by:** ZK-003

### INF-005: Add circomlibjs to frontend dependencies
- **File:** `app/web/package.json`
- **Change:** `npm install circomlibjs`. Used for Poseidon hash computation in `useSubmitTrade`.
- **Blocks:** PH-001

---

## Cleanup

### CL-001: Remove stale order_signature references from backend
- **Files:** `app/server/src/routes/orders.ts`, `app/server/src/services/`
- **Change:** Search for any references to `order_signature`, `order_data`, `revealed`, `revealed_at`. Remove from API request/response types, validation, DB queries.
- **Blocked by:** DB-003

### CL-002: Remove 50ms sleep hack in gRPC server
- **File:** `warlock/internal/grpc/server.go`
- **Change:** Investigate and fix the root cause of cross-connection visibility issue. Remove the `time.Sleep(50 * time.Millisecond)` hack.

**Note:** OrdersDrawer portal code (`typeof window === 'undefined'` guard before `createPortal`) is correct — it's a standard Next.js SSR pattern, NOT a bug.

---

## Ticket Summary

| Phase | Tickets | Description |
|-------|---------|-------------|
| 1: Contract Foundation | C-001 → C-004 | IYellowCustody 3-param deposit, mock, tests |
| 1b: Partial Fills | PF-001 → PF-010 | settledAmount, proportional slippage, per-order settle |
| 1c: ZK Settlement | ZK-001 → ZK-008 | Circom circuit, Groth16 verifier, proveAndSettle |
| 1d: Poseidon Hash | PH-001 → PH-007 | Frontend + backend Poseidon, on-chain Poseidon, orderId bounds, proof gen |
| 2: Database | DB-001 → DB-005 | session_keys table, settlement columns, cleanup |
| 3: Session Keys | SK-001 → SK-006 | Generation, encryption, confirmation, retrieval |
| 4: Frontend | FE-001 → FE-006 | Session key auth, Poseidon, balance, withdrawal |
| 5: Settlement | S-001 → S-010, S-003b | Yellow WS, engine auth, settlement pipeline, revealAndSettle fallback |
| 6: Testing | T-001 → T-010 | Contract, backend, E2E, edge cases |
| 7: Cross-Chain | CC-001 → CC-009 | Multi-chain deploy, routing, frontend |
| Infra | INF-001 → INF-005 | Env vars, Docker, circuit build |
| Cleanup | CL-001 → CL-002 | Dead code, stale columns, hacks |

**Total: 74 tickets across 12 sections.**
