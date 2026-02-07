# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Private P2P dark pool trading protocol. Users submit orders with commitment hashes, a Go matching engine pairs them off-chain using price-time priority, and settlement happens via Yellow Network App Sessions with ZK proof verification on-chain.

## Architecture (4 Components)

```
Frontend (Next.js 14)  →  Backend (Express/Node)  →  Warlock (Go/gRPC)  →  PostgreSQL
     :3000                    :3001                      :50051
                                                            ↓
                              DarkPoolRouter.sol  ←  Yellow Network Custody
```

- **`app/web/`** — Next.js 14 frontend with wagmi/viem/RainbowKit for wallet connection, Tailwind CSS
- **`app/server/`** — Express backend, gRPC client to Warlock, WebSocket server for real-time updates, `pg` for direct DB access
- **`warlock/`** — Go matching engine with price-time priority algorithm, gRPC server, pgx for PostgreSQL
- **`contracts/`** — Solidity (Foundry), DarkPoolRouter handles commit-reveal + ZK settlement, integrates with Yellow Network Custody

## Build & Run Commands

### Full Stack (Docker)
```bash
npm run docker:up          # Start postgres, warlock, backend, frontend
npm run docker:down        # Stop all
npm run docker:logs        # Tail all logs
npm run migrate            # Apply DB migrations to postgres container
```

### Contracts (Foundry) — run from `contracts/`
```bash
forge build                # Compile
forge test -vvv            # Run all tests
forge test --match-test testSubmitOrder -vvv   # Single test
forge fmt --check          # Format check (CI runs this)
forge fmt                  # Auto-format
```

### Frontend — run from `app/web/`
```bash
npm run dev                # Dev server on :3000
npm run build              # Production build
npm run lint               # ESLint
```

### Backend — run from `app/server/`
```bash
npm run dev                # ts-node-dev with hot reload on :3001
npm run build              # Compile TypeScript → dist/
```

### Warlock — run from `warlock/`
```bash
go run cmd/warlock/main.go                    # Requires DATABASE_URL env var
go test ./...                                  # Run Go tests
pkg/api/proto/generate.sh                      # Regenerate protobuf after .proto changes
```

### E2E Tests
```bash
npm run test:e2e           # Full E2E (checks prerequisites, starts services)
npm run test:e2e:simple    # Quick: submit BUY + SELL, verify match
```

## CI

Only contracts have CI (`contracts/.github/workflows/test.yml`): `forge fmt --check` → `forge build --sizes` → `forge test -vvv`

## Key Design Decisions

- **Poseidon hash** (not keccak256) for commitment hashes — ZK-friendly (~250 constraints vs 150k)
- **No EIP-712 for order auth** — `msg.sender` in `depositAndCommit` is sufficient
- **Session keys per user session** (30-day expiry), not per order
- **"Game with Judge" model** — engine weight 100, quorum 100, challenge 0; instant settlement
- **`proveAndSettle` (ZK/Groth16)** is production path; `revealAndSettle` kept as testing fallback
- **Asset identifiers are symbols** (`"usdc"`, `"weth"`), mapped to addresses via `get_assets` RPC
- **Yellow unified balance** enables cross-chain settlement without bridges

## Database Schema

Single migration at `warlock/migrations/001_initial_schema.up.sql`. Two tables:
- `orders` — user address, token pair, price, quantity, variance_bps, commitment hash, status lifecycle (PENDING → COMMITTED → REVEALED → PARTIALLY_FILLED → FILLED → CANCELLED)
- `matches` — links buy/sell order IDs, settlement status (PENDING → SETTLING → SETTLED → FAILED)

## Reference Materials

`.reference/` contains cloned external repos (not our code):
- `nitrolite/` — Yellow Network SDK (v0.5.3), clearnode Go source, contract ABIs
- `yellow-docs/` — Yellow Network documentation
- `examples/` — Integration examples

## Implementation Docs & Tickets

Before starting any implementation work, read these files:
- **`SETTLEMENT_IMPLEMENTATION.md`** — Authoritative design doc with all architectural questions resolved and code-level references. This is the source of truth for settlement flow, key management, ZK stack, and cross-chain design.
- **`IMPLEMENTATION_PLAN.md`** — Overall architecture and phased implementation roadmap.
- **`TICKETS.md`** — 70 implementation tickets across 12 phases. **When completing work that corresponds to a ticket, mark it as done in TICKETS.md.** Check this file before starting work to understand what's been completed and what's next.

## Working Rules

- **Always ask the user before making implementation decisions.** If requirements are ambiguous, a design choice could go multiple ways, or you're unsure about an approach — stop and ask. Do not guess or make assumptions about architecture, API design, data models, or integration details.
- **Consult the design docs first.** Many questions are already answered in `SETTLEMENT_IMPLEMENTATION.md`. Check there before asking the user.
- **Update TICKETS.md** when you complete work that maps to a ticket. Mark the checkbox and note what was done if relevant.

## Environment Variables

Copy `.env.example` to `.env` at root. Frontend also needs `app/web/.env.local`. Key vars:
- `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` — Required for wallet connection
- `DATABASE_URL` — PostgreSQL connection string (docker-compose sets this automatically)
- `WARLOCK_GRPC_URL` — Defaults to `localhost:50051` (or `warlock:50051` in Docker)
- `ROUTER_ADDRESS` — Deployed DarkPoolRouter contract address
- `RPC_URL` — Ethereum RPC endpoint

## Protobuf

gRPC service defined in `warlock/pkg/api/proto/warlock.proto`. Backend loads this dynamically via `@grpc/proto-loader`. After editing the `.proto` file, regenerate Go code with `warlock/pkg/api/proto/generate.sh` (requires `protoc` + Go gRPC plugins).
