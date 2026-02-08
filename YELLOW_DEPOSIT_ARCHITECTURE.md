# Yellow Network Deposit Architecture

Full analysis of Yellow Network's deposit/channel/unified balance architecture and how it impacts our dark pool UX.

## The Three Balances

```
┌──────────────┐     Custody.deposit()     ┌──────────────────┐
│ User Wallet  │ ────────────────────────── │ Custody Ledger   │  (on-chain)
│ (MetaMask)   │     ERC-20 transfer        │ per-address      │
└──────────────┘                            └────────┬─────────┘
                                                     │
                                           Custody.create() + resize()
                                                     │
                                                     ▼
                                            ┌──────────────────┐
                                            │ Channel Balance  │  (on-chain)
                                            │ per-channel      │
                                            └────────┬─────────┘
                                                     │
                                           Clearnode processes Resized event
                                                     │
                                                     ▼
                                            ┌──────────────────┐
                                            │ Unified Balance  │  (off-chain, cross-chain)
                                            │ per-wallet       │  ← THIS is what enables trading
                                            └──────────────────┘
```

## Why Resize is Mandatory (v0.5.0+)

1. **Clearnode ignores `Deposited` events** — `clearnode/custody.go:151-191` only handles Created, Joined, Challenged, Resized, Closed. Deposited falls to `default: "unknown event"`.

2. **v0.5.0 forces zero initial allocation** — "Clearnode no longer supports creating channels with an initial deposit. All channels must be created with zero balance and funded separately through a resize operation."

3. **Non-zero channels block trading** — "Users with any channel containing non-zero amounts cannot perform transfers, submit app states with deposit intent, or create app sessions with non-zero allocations."

4. **Resize is a pass-through pipe** — `resize_amount: +X` (custody → channel) and `allocate_amount: -X` (channel → unified). Net channel balance stays at zero.

## Signature Requirements (v0.5.0+)

### On-chain (Custody contract)
- **State signatures must match `ch.participants[i]`** — verified via ecrecover (EOA) or EIP-1271 (smart wallets)
- **v0.5.0: participant = wallet address** — "Channels created after v0.5.0: participant = wallet, states signed by wallet"
- **No `msg.sender` checks** on create/resize — anyone can submit the tx
- **Contract explicitly supports session key as participant** — comment in Custody.sol:273: "it is allowed for depositor to be different from participant. This enables logic of session keys"
- **SDK has `SessionKeyStateSigner`** and backward_compatibility tests proving session key participant works

### Off-chain (Clearnode RPC)
- **Session key signs RPC messages** — clearnode maps session key → wallet via `GetWalletBySessionKey()`
- **`application: "clearnode"` = root access** — bypasses spending allowance + application validation
- **Channel ops need user-authenticated WS** — clearnode checks `c.UserID` matches signer's mapped wallet

### The Gap
The clearnode creates channels with `participants: [wallet, broker]` and ignores the `SessionKey` param in create_channel requests. So even though the contract and SDK support session key as participant, the clearnode doesn't. This forces wallet signatures for all channel states.

## Current Popup Count

### First-time user (ERC-20, 0 unified balance)
```
1. 🔑 Connect wallet                          (RainbowKit)
2. ✍️  Sign session key EIP-712                (once per 30 days)
3. ✍️  Sign channel create state               (wallet, for Custody.create)
4. 📝 Tx: Custody.create()                    (on-chain)
5. 📝 Tx: ERC20.approve(maxUint256)            (once per token)
6. 📝 Tx: Custody.deposit()                    (on-chain)
7. ✍️  Sign resize state                       (wallet, for Custody.resize)
8. 📝 Tx: Custody.resize()                    (on-chain)
9. 📝 Tx: Router.commitOnly()                 (the actual trade)
```
**9 popups** (8 for native ETH — no approve)

### Returning user (has channel + approval)
```
1. 🔑 Connect wallet
2. 📝 Tx: Custody.deposit()
3. ✍️  Sign resize state
4. 📝 Tx: Custody.resize()
5. 📝 Tx: Router.commitOnly()
```
**5 popups**

### Optimized (engine submits resize tx)
```
1. 🔑 Connect wallet
2. 📝 Tx: Custody.deposit()
3. ✍️  Sign resize state                       (still needed — wallet is participant)
4. 📝 Tx: Router.commitOnly()
```
**4 popups** (engine submits resize tx on user's behalf)

## Consolidation Options

| Optimization | Popups Saved | Effort | Status |
|---|---|---|---|
| Engine submits resize tx | 1 | Low | Planned |
| SDK `depositAndCreateChannel` | 1-2 | Medium | Available in SDK |
| `maxUint256` approve (once per token) | 1 per subsequent | Done | ✅ Already implemented |
| Store JWT for WS reconnection | 0 (fixes failures) | Low | Planned |
| Switch to `application: "clearnode"` | 0 (removes caps) | Low | Planned |
| Ask Yellow: session key as participant | 2 | Depends on Yellow | Contract + SDK ready |
| EIP-1271 smart wallet delegation | 2 | High | Requires per-user contract |
| Permit2 / ERC-2612 | 1 | Medium | Token-dependent |

## Key References

### Local repos (~/erc7824/)
- `nitrolite/sdk/src/client/signer.ts` — `SessionKeyStateSigner`, `WalletStateSigner`
- `nitrolite/sdk/src/client/state.ts` — `_checkParticipantAndGetSigner` auto-detection
- `nitrolite/sdk/src/rpc/api.ts` — `createAuthVerifyMessageWithJWT`, `createResizeChannelMessage`
- `nitrolite/integration/tests/backward_compatibility/onchain_ops_with_sk.test.ts` — session key as participant proof
- `nitrolite/integration/tests/create_channel.test.ts` — zero allocation enforced
- `nitrolite/integration/tests/resize_channel.test.ts` — resize semantics
- `nitrolite/contract/src/Custody.sol:273` — "depositor different from participant" comment
- `nitrolite/clearnode/channel_service.go:50` — participant always = wallet
- `nitrolite/clearnode/session_key.go:273` — clearnode root access bypass
- `nitrolite/clearnode/rpc_router_private.go:890` — session key → wallet mapping
- `nitrolite/examples/cerebro/` — Yellow's own CLI pattern

### Our codebase
- `app/server/src/services/yellowConnection.ts` — WS management, channel ops
- `app/server/src/routes/sessionKeys.ts` — session key lifecycle
- `app/server/src/routes/channels.ts` — channel route handlers
- `app/web/src/hooks/useYellowDeposit.ts` — frontend deposit flow
- `app/web/src/hooks/useSessionKey.ts` — frontend session key flow
- `app/web/src/hooks/useSubmitTrade.ts` — frontend trade submission

### Migration guide
- v0.5.x: Zero allocation, wallet signs states, non-zero blocks trading
- v0.3.x: `create_channel` method added, structured RPC params
- `createAuthVerifyMessageWithJWT` available since v0.5.x
