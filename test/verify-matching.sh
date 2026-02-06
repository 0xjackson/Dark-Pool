#!/bin/bash
set -e

echo "Testing order matching with race condition fix..."

# Clean database before test (no need to restart warlock - just clear DB)
echo "Cleaning test data..."
docker exec darkpool-postgres psql -U darkpool -d darkpool -c "TRUNCATE TABLE matches CASCADE; DELETE FROM orders;" > /dev/null 2>&1
echo "Database cleaned."

# Submit BUY order
BUY_RESPONSE=$(curl -s -X POST http://localhost:3001/api/orders \
  -H "Content-Type: application/json" \
  -d '{"user_address":"0x1111111111111111111111111111111111111111","chain_id":1,"order_type":"BUY","base_token":"0xETH","quote_token":"0xUSDC","quantity":"100","price":"2000","variance_bps":200}')

BUY_ID=$(echo "$BUY_RESPONSE" | jq -r '.order.id')
echo "BUY order: $BUY_ID"

# Submit SELL order
SELL_RESPONSE=$(curl -s -X POST http://localhost:3001/api/orders \
  -H "Content-Type: application/json" \
  -d '{"user_address":"0x2222222222222222222222222222222222222222","chain_id":1,"order_type":"SELL","base_token":"0xETH","quote_token":"0xUSDC","quantity":"100","price":"2010","variance_bps":200}')

SELL_ID=$(echo "$SELL_RESPONSE" | jq -r '.order.id')
echo "SELL order: $SELL_ID"

# Wait for matching
sleep 2

# Check order statuses
BUY_STATUS=$(curl -s http://localhost:3001/api/orders/$BUY_ID | jq -r '.status')
SELL_STATUS=$(curl -s http://localhost:3001/api/orders/$SELL_ID | jq -r '.status')

echo "BUY status: $BUY_STATUS"
echo "SELL status: $SELL_STATUS"

if [ "$BUY_STATUS" = "FILLED" ] && [ "$SELL_STATUS" = "FILLED" ]; then
    echo "✅ SUCCESS: Orders matched!"
    exit 0
else
    echo "❌ FAILED: Orders did not match"
    exit 1
fi
