#!/bin/bash
set -e

# Quick Match Test - Verifies orders match correctly
BACKEND="http://localhost:3001"

echo "🧪 Quick Match Test"
echo "==================="

# Clean database before test (no need to restart warlock - just clear DB)
echo "0. Cleaning database..."
docker exec darkpool-postgres psql -U darkpool -d darkpool -c "TRUNCATE TABLE matches CASCADE; DELETE FROM orders;" > /dev/null 2>&1

# Submit BUY order
echo "1. Creating BUY order (100 @ 2000, ±2%)..."
BUY=$(curl -s -X POST "$BACKEND/api/orders" -H "Content-Type: application/json" -d '{"user_address":"0xBUYER","chain_id":1,"order_type":"BUY","base_token":"0xETH","quote_token":"0xUSDC","quantity":"100","price":"2000","variance_bps":200}')
BUY_ID=$(echo "$BUY" | jq -r '.order.id')
echo "   BUY ID: $BUY_ID"

# Submit SELL order
echo "2. Creating SELL order (100 @ 2010, ±2%)..."
SELL=$(curl -s -X POST "$BACKEND/api/orders" -H "Content-Type: application/json" -d '{"user_address":"0xSELLER","chain_id":1,"order_type":"SELL","base_token":"0xETH","quote_token":"0xUSDC","quantity":"100","price":"2010","variance_bps":200}')
SELL_ID=$(echo "$SELL" | jq -r '.order.id')
echo "   SELL ID: $SELL_ID"

# Wait for matching
echo "3. Waiting 2 seconds for matching..."
sleep 2

# Check statuses
echo "4. Checking order statuses..."
BUY_STATUS=$(curl -s "$BACKEND/api/orders/$BUY_ID" | jq -r '.status')
SELL_STATUS=$(curl -s "$BACKEND/api/orders/$SELL_ID" | jq -r '.status')

echo "   BUY Status: $BUY_STATUS"
echo "   SELL Status: $SELL_STATUS"

# Verify
if [ "$BUY_STATUS" = "FILLED" ] && [ "$SELL_STATUS" = "FILLED" ]; then
    echo ""
    echo "✅ SUCCESS: Orders matched and filled!"
    exit 0
else
    echo ""
    echo "❌ FAILED: Orders did not match"
    echo "   Expected: FILLED / FILLED"
    echo "   Got: $BUY_STATUS / $SELL_STATUS"
    exit 1
fi
