# Dark Pool E2E Tests

End-to-end tests for the Dark Pool matching engine that validate the complete flow from order submission to match execution.

## What Gets Tested

This E2E test validates the critical path:

1. **Database Layer**
   - Orders table writes and updates
   - Matches table writes
   - Order status transitions (REVEALED → FILLED)
   - Fill quantity tracking (filled_quantity, remaining_quantity)
   - Foreign key relationships

2. **Node.js Backend (REST API)**
   - POST /api/orders - Order submission
   - GET /api/orders/:id - Order retrieval
   - GET /api/matches/user/:address - Match retrieval
   - Health check endpoint

3. **Warlock Matching Engine (Go/gRPC)**
   - Order reception via gRPC
   - Matching algorithm (price-time priority)
   - Variance compatibility checking
   - Atomic match execution
   - Order status updates
   - Match notifications

## Test Scenario

The test submits two orders that should match:

- **BUY Order**: 100 units @ $2000, variance 2% (range: $1960 - $2040)
- **SELL Order**: 100 units @ $2010, variance 2% (range: $1970 - $2050)

**Match Criteria**: `buy.max_price ($2040) >= sell.min_price ($1970)` ✓

## Prerequisites

### 1. Install jq (JSON parser)

```bash
# macOS
brew install jq

# Ubuntu/Debian
sudo apt-get install jq

# Alpine Linux
apk add jq
```

### 2. Start Docker Services

```bash
docker-compose up -d postgres warlock backend
```

Or use the npm script:

```bash
npm run docker:up
```

### 3. Apply Database Migrations

```bash
docker exec -i darkpool-postgres psql -U darkpool -d darkpool < warlock/migrations/001_initial_schema.up.sql
```

Or use the npm script:

```bash
npm run migrate
```

## Running the Tests

### Option 1: Full Test Runner (Recommended)

The test runner checks prerequisites, starts services if needed, and runs the tests:

```bash
./test/run-e2e.sh
```

Or via npm:

```bash
npm run test:e2e
```

### Option 2: Simple Test Only

If services are already running and configured:

```bash
./test/e2e-simple.sh
```

Or via npm:

```bash
npm run test:e2e:simple
```

## Expected Output

### Successful Test Run

```
🧪 Dark Pool E2E Test
====================

1️⃣  Testing Backend Health...
✓ Backend is healthy

2️⃣  Submitting BUY order...
ℹ BUY: 100 units @ $2000, variance 2% (min: $1960, max: $2040)
✓ BUY order created: 550e8400-e29b-41d4-a716-446655440000

3️⃣  Submitting SELL order (should match)...
ℹ SELL: 100 units @ $2010, variance 2% (min: $1970, max: $2050)
✓ SELL order created: 6ba7b810-9dad-11d1-80b4-00c04fd430c8

⏳ Waiting 3 seconds for matching engine...

4️⃣  Verifying BUY order status...
✓ BUY order is FILLED (filled_quantity: 100)

5️⃣  Verifying SELL order status...
✓ SELL order is FILLED (filled_quantity: 100)

6️⃣  Verifying match exists for buyer...
✓ Found 1 match(es) for buyer

7️⃣  Verifying match exists for seller...
✓ Found 1 match(es) for seller

8️⃣  Verifying database state...
ℹ Checking orders table...
✓ Database: Both orders are FILLED
ℹ Checking matches table...
✓ Database: Found 1 match(es)

==========================================
🎉 All tests passed!

Summary:
  - BUY order ID: 550e8400-e29b-41d4-a716-446655440000
  - SELL order ID: 6ba7b810-9dad-11d1-80b4-00c04fd430c8
  - Buyer matches: 1
  - Seller matches: 1
  - Tests passed: 8
```

## Troubleshooting

### Services Not Running

```bash
# Check service status
docker-compose ps

# View logs
docker-compose logs backend
docker-compose logs warlock
docker-compose logs postgres

# Restart services
docker-compose restart
```

### Backend Not Responding

```bash
# Check backend logs
docker logs darkpool-backend

# Check if port 3001 is in use
lsof -i :3001

# Restart backend
docker-compose restart backend
```

### Database Issues

```bash
# Check database connection
docker exec darkpool-postgres psql -U darkpool -d darkpool -c "SELECT 1;"

# Check if tables exist
docker exec darkpool-postgres psql -U darkpool -d darkpool -c "\dt"

# Re-run migrations
npm run migrate
```

### Matching Not Happening

```bash
# Check warlock logs
docker logs darkpool-warlock

# Check if warlock is receiving orders
docker exec darkpool-postgres psql -U darkpool -d darkpool -c "SELECT * FROM orders ORDER BY created_at DESC LIMIT 5;"

# Check warlock gRPC connection
docker logs darkpool-backend | grep -i grpc
```

### Tests Failing

```bash
# Run with verbose output
bash -x ./test/e2e-simple.sh

# Check database state manually
docker exec -it darkpool-postgres psql -U darkpool -d darkpool

# Clean database and restart
docker-compose down -v
docker-compose up -d
npm run migrate
```

## Test Architecture

```
test/e2e-simple.sh (Main test script)
    ↓ HTTP
Node.js Backend (localhost:3001)
    ↓ gRPC
Warlock Matching Engine (localhost:50051)
    ↓ SQL
PostgreSQL (localhost:5432)
```

## Files

- `test/e2e-simple.sh` - Main E2E test script
- `test/run-e2e.sh` - Test runner with prerequisite checks
- `test/README.md` - This file

## Future Enhancements

- [ ] Add test for partial fills
- [ ] Add test for order cancellation
- [ ] Add test for price-time priority
- [ ] Add test for multiple matches
- [ ] Add test for non-matching orders
- [ ] Add test for variance boundary conditions
- [ ] Add performance tests (order throughput)
- [ ] Add WebSocket event testing
- [ ] Add CI/CD integration (GitHub Actions)
- [ ] Add test data cleanup between runs

## Contributing

When adding new tests:

1. Keep tests focused and independent
2. Use descriptive test names
3. Add clear success/failure messages
4. Clean up test data after execution
5. Document expected behavior
6. Update this README
