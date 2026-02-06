# 🧙 Warlock - Dark Pool Matching Engine

High-performance order matching engine written in Go with variance/slippage tolerance support.

## Features

- **Price-Time Priority Matching** with variance tolerance
- **gRPC API** for low-latency communication
- **Worker Pool** for concurrent order processing
- **In-Memory Order Book** with database persistence
- **Partial Fill Support**
- **Real-time Match Streaming**

## Architecture

```
Node.js Backend
    ↓ gRPC (port 50051)
Warlock Matching Engine
    ↓ PostgreSQL
Database (orders, matches)
```

## Quick Start

### Prerequisites

- Go 1.22+
- PostgreSQL 16+
- protoc (Protocol Buffers compiler)

### Development

```bash
# Generate protobuf code
cd pkg/api/proto
./generate.sh

# Run migrations
psql $DATABASE_URL < migrations/001_initial_schema.up.sql

# Run
export DATABASE_URL="postgresql://darkpool:darkpool_dev_password@localhost:5432/darkpool"
export GRPC_PORT=50051
export WORKERS=4
go run cmd/warlock/main.go
```

### Docker

```bash
# Build
docker build -t warlock:latest .

# Run
docker run -p 50051:50051 \
  -e DATABASE_URL="postgresql://darkpool:darkpool_dev_password@postgres:5432/darkpool" \
  -e GRPC_PORT=50051 \
  -e WORKERS=4 \
  warlock:latest
```

## Configuration

Environment variables:

- `DATABASE_URL` (required) - PostgreSQL connection string
- `GRPC_PORT` (default: 50051) - gRPC server port
- `WORKERS` (default: 4) - Number of worker goroutines
- `LOG_LEVEL` (default: info) - Log level (debug, info, warn, error)
- `DB_MAX_CONNS` (default: 25) - Max database connections
- `DB_MIN_CONNS` (default: 5) - Min database connections

## gRPC API

### SubmitOrder
Submits a new order to the matching engine.

### CancelOrder
Cancels an existing order.

### GetOrderBook
Retrieves the current order book for a token pair.

### StreamMatches
Streams match events in real-time.

### HealthCheck
Returns service health and statistics.

## Matching Algorithm

**Price-Time Priority with Variance Tolerance:**

1. For each incoming order, query opposite side from database
2. Filter by variance range (buy.max_price >= sell.min_price)
3. Sort by best price, then earliest time
4. Execute matches atomically with database transactions
5. Update in-memory order book
6. Stream match notifications

**Example:**
```
Order A: BUY 1000 ETH @ $500, variance 1% (min: $495, max: $505)
Matches:
  ✓ Order B: SELL 600 ETH @ $498 (within range)
  ✓ Order C: SELL 400 ETH @ $502 (within range)
  ✗ Order D: SELL 500 ETH @ $510 (above max)
```

## Performance

- Target: 100-1000 orders/sec
- Matching latency: <1ms (in-memory)
- Database latency: <10ms (indexed queries)

## Testing

```bash
# Unit tests
go test ./...

# Load test (requires grpcurl)
grpcurl -plaintext -d '{
  "user_address": "0x1234...",
  "chain_id": 1,
  "order_type": 1,
  "base_token": "0xETH...",
  "quote_token": "0xUSDC...",
  "quantity": "100",
  "price": "2000",
  "variance_bps": 200
}' localhost:50051 warlock.v1.MatcherService/SubmitOrder
```

## License

MIT
