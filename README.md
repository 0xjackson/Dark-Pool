# Dark Pool

Private P2P trading protocol built on [Yellow Network](https://yellow.org). Orders are committed as Poseidon hashes, matched off-chain, and settled with Groth16 zero-knowledge proofs. The chain never sees trade details.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                                                                 │
│  ┌─────────────┐  POST /orders            ┌──────────────┐  SubmitOrder()      │
│  │   Portal    │  POST /session-key/*     │    Engine    │  StreamMatches()    │
│  │  (Next.js)  │────────────────────────►│  (Node.js)   │─────────────────┐   │
│  │             │◄────────────────────────│              │◄────────────────┐│   │
│  │  wagmi      │  WS: match, settlement   │  snarkjs     │  gRPC           ││   │
│  │  RainbowKit │  WS: order_update        │  ethers.js   │                 ▼│   │
│  └──────┬──────┘                          └──┬───┬───┬──┘          ┌──────────┐│
│         │                                    │   │   │             │  Warlock ││
│         │                                    │   │   │             │(Go/gRPC) ││
│         │                                    │   │   │             │          ││
│         │                                    │   │   │             │price-time││
│         │                                    │   │   │             │ priority ││
│         │                                    │   │   │             └────┬─────┘│
│         │                                    │   │   │                  │      │
│         │                                    │   │   │                  ▼      │
│         │                                    │   │   │           ┌──────────┐  │
│         │                                    │   │   │           │ Postgres │  │
│         │                                    │   │   │           │          │  │
│         │                                    │   │   │           │ orders   │  │
│         │                                    │   │   │           │ matches  │  │
│         │                                    │   │   │           │ sessions │  │
│         │                                    │   │   │           └──────────┘  │
│         │                                    │   │   │                         │
│         │              proveAndSettle()  ─────┘   │   └─────  auth_request()   │
│         │              markFullySettled() ────┐   │   ┌─────  auth_verify()    │
│         │              generateProof()        │   │   │       create_app_ses() │
│         │                                    │   │   │       close_app_ses()   │
│         │                                    │   │   │       get_assets()      │
│         │                                    ▼   │   ▼                         │
│         │  approve()                ┌───────────┐│┌───────────┐               │
│         │  depositAndCommit()       │  Router   │││  Yellow   │               │
│         └──────────────────────────►│ Contract  │││ Network   │               │
│                                     │           │││           │               │
│                                     │ Poseidon  │││ Custody   │               │
│                                     │ Groth16   │││ Clearnet  │               │
│                                     │ Verifier  │││ Sessions  │               │
│                                     └───────────┘│└───────────┘               │
│                                                  │                             │
│                                                  │                             │
│                          EVM Chain ──────────────┘                             │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**Portal** handles wallet connection and order submission via RainbowKit and wagmi. Users call `approve()` and `depositAndCommit()` directly on-chain, which deposits collateral into Yellow Network Custody and stores a Poseidon hash commitment. The frontend computes the nested Poseidon hash locally (`PoseidonT6` into `PoseidonT4`) and submits order details to the Engine over REST.

**Engine** orchestrates the full settlement pipeline. When Warlock streams a match, the Engine generates a Groth16 ZK proof via snarkjs, calls `proveAndSettle()` on the Router for on-chain verification, then opens a Yellow Network App Session signed by both parties' session keys and closes it with swapped allocations. Real-time updates (matches, settlements, order status) are pushed back to the Portal over WebSocket.

**Warlock** is the matching engine written in Go. It receives orders over gRPC, runs price-time priority matching with partial fill support, stores everything in Postgres, and streams match events back to the Engine.

**DarkPoolRouter** is the on-chain commitment registry and ZK verifier. It stores Poseidon hash commitments, verifies Groth16 proofs via a dedicated verifier contract, tracks partial fill amounts, and coordinates deposits with Yellow Network Custody.

## Settlement

Users call `depositAndCommit()` on the Router, which deposits collateral into Yellow Network Custody and stores a Poseidon hash commitment. Warlock matches orders off-chain. The Engine generates a Groth16 proof (~200ms, 4,576 constraints) and calls `proveAndSettle()` for on-chain verification. Once verified, the Engine opens a Yellow Network App Session with the matched users' session keys and closes it with swapped allocations. No bridges, no challenge period, no order details on-chain.

Yellow's unified balance layer makes this chain-agnostic. Deploy the Router on any EVM chain, matching works the same. Users withdraw on whichever chain they want.

## ZK Stack

Circom circuit with Groth16 proving system. Commitments use nested Poseidon hashing (`PoseidonT6` into `PoseidonT4`) because the library only ships T2 through T6 and we have 7 inputs. About 500 constraints for the hash versus 150k if we used keccak. On-chain verification costs around 200k gas. The `revealAndSettle()` fallback exists for debugging but production uses the ZK path exclusively.

## Yellow Network Integration

Settlement uses the "Game with Judge" governance model from Yellow's state channel framework. The Engine authenticates as a clearnode operator with full signing authority (weight 100, quorum 100, challenge 0), enabling instant settlement. Session keys are registered per user session with 30-day expiry, so users sign once at wallet connect and trades settle without further interaction. Asset mapping uses Yellow's `get_assets` RPC, and balances are queried directly from the Custody contract.

## Running It

```bash
git clone https://github.com/0xjackson/Dark-Pool.git && cd Dark-Pool
cp .env.example .env
npm run docker:up && npm run migrate
```

Or run services individually:

```bash
cd warlock && go run cmd/warlock/main.go
cd app/server && npm run dev
cd app/web && npm run dev
cd contracts && forge test -vvv
```

## Project Layout

```
contracts/       DarkPoolRouter, Groth16Verifier, Poseidon libraries (Foundry)
circuits/        Circom settlement circuit, trusted setup artifacts
warlock/         Go matching engine, gRPC server
app/server/      Express API, ZK proof generation, settlement worker
app/web/         Next.js frontend, WebSocket order updates
```

## License

MIT
