# Dark Pool

Private P2P trading protocol built on [Yellow Network](https://yellow.org). Orders are committed as Poseidon hashes, matched off-chain, and settled with Groth16 zero-knowledge proofs. The chain never sees trade details.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Frontend                                   │
│                     Next.js 14 / wagmi / RainbowKit                     │
│                         portal (:3000)                                  │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ REST + WebSocket
┌──────────────────────────────▼──────────────────────────────────────────┐
│                               Engine                                    │
│              Express / snarkjs / ethers.js / WebSocket                   │
│                         server (:3001)                                  │
│                                                                         │
│   ZK Proof Generation    Settlement Worker    Session Key Management    │
└─────────┬───────────────────────┬───────────────────────┬───────────────┘
          │ gRPC                  │ on-chain tx            │ WS
┌─────────▼─────────┐  ┌─────────▼─────────┐  ┌──────────▼──────────────┐
│      Warlock       │  │  DarkPoolRouter    │  │    Yellow Network       │
│   Go / pgx         │  │  Groth16Verifier   │  │    Custody / Clearnet   │
│   Matching Engine   │  │  PoseidonT4 / T6   │  │    App Sessions         │
│   (:50051)         │  │  (Solidity)        │  │    Unified Balance      │
└─────────┬─────────┘  └────────────────────┘  └─────────────────────────┘
          │
┌─────────▼─────────┐
│    PostgreSQL      │
│  Orders / Matches  │
│  Session Keys      │
└───────────────────┘
```

**Portal** handles wallet connection and order submission via RainbowKit and wagmi. **Engine** orchestrates everything: generates ZK proofs with snarkjs, submits settlement transactions, and manages Yellow Network App Sessions. **Warlock** is the matching engine, written in Go, running price-time priority with partial fill support. **DarkPoolRouter** stores Poseidon commitments and verifies Groth16 proofs on-chain.

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
