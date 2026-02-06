#!/bin/bash

# E2E Test for Dark Pool Matching Engine
# Tests the critical path: BUY order → SELL order → Match verification

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test configuration
BACKEND_URL="http://localhost:3001"
BUYER_ADDRESS="0x1111111111111111111111111111111111111111"
SELLER_ADDRESS="0x2222222222222222222222222222222222222222"
ETH_TOKEN="0xETH0000000000000000000000000000000000000"
USDC_TOKEN="0xUSDC000000000000000000000000000000000000"

# Test counters
TESTS_PASSED=0
TESTS_FAILED=0

# Helper functions
print_step() {
    echo -e "\n${BLUE}$1${NC}"
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
    ((TESTS_PASSED++))
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
    ((TESTS_FAILED++))
}

print_info() {
    echo -e "${YELLOW}ℹ $1${NC}"
}

# Check if jq is installed
if ! command -v jq &> /dev/null; then
    print_error "jq is not installed. Please install it first."
    echo "  Mac: brew install jq"
    echo "  Ubuntu: apt-get install jq"
    exit 1
fi

echo -e "${BLUE}🧪 Dark Pool E2E Test${NC}"
echo "===================="

# Step 1: Health Check
print_step "1️⃣  Testing Backend Health..."
HEALTH_RESPONSE=$(curl -s $BACKEND_URL/health)
if echo "$HEALTH_RESPONSE" | jq -e '.status == "ok"' > /dev/null 2>&1; then
    print_success "Backend is healthy"
else
    print_error "Backend health check failed"
    echo "Response: $HEALTH_RESPONSE"
    exit 1
fi

# Step 2: Submit BUY Order
print_step "2️⃣  Submitting BUY order..."
print_info "BUY: 100 units @ \$2000, variance 2% (min: \$1960, max: \$2040)"

BUY_RESPONSE=$(curl -s -X POST $BACKEND_URL/api/orders \
  -H "Content-Type: application/json" \
  -d "{
    \"user_address\": \"$BUYER_ADDRESS\",
    \"chain_id\": 1,
    \"order_type\": \"BUY\",
    \"base_token\": \"$ETH_TOKEN\",
    \"quote_token\": \"$USDC_TOKEN\",
    \"quantity\": \"100\",
    \"price\": \"2000\",
    \"variance_bps\": 200
  }")

BUY_ORDER_ID=$(echo "$BUY_RESPONSE" | jq -r '.order.id // .id // empty')
if [ -z "$BUY_ORDER_ID" ] || [ "$BUY_ORDER_ID" = "null" ]; then
    print_error "Failed to create BUY order"
    echo "Response: $BUY_RESPONSE"
    exit 1
fi

print_success "BUY order created: $BUY_ORDER_ID"

# Step 3: Submit SELL Order
print_step "3️⃣  Submitting SELL order (should match)..."
print_info "SELL: 100 units @ \$2010, variance 2% (min: \$1970, max: \$2050)"

SELL_RESPONSE=$(curl -s -X POST $BACKEND_URL/api/orders \
  -H "Content-Type: application/json" \
  -d "{
    \"user_address\": \"$SELLER_ADDRESS\",
    \"chain_id\": 1,
    \"order_type\": \"SELL\",
    \"base_token\": \"$ETH_TOKEN\",
    \"quote_token\": \"$USDC_TOKEN\",
    \"quantity\": \"100\",
    \"price\": \"2010\",
    \"variance_bps\": 200
  }")

SELL_ORDER_ID=$(echo "$SELL_RESPONSE" | jq -r '.order.id // .id // empty')
if [ -z "$SELL_ORDER_ID" ] || [ "$SELL_ORDER_ID" = "null" ]; then
    print_error "Failed to create SELL order"
    echo "Response: $SELL_RESPONSE"
    exit 1
fi

print_success "SELL order created: $SELL_ORDER_ID"

# Step 4: Wait for matching
print_step "⏳ Waiting 3 seconds for matching engine..."
sleep 3

# Step 5: Verify BUY order is FILLED
print_step "4️⃣  Verifying BUY order status..."
BUY_ORDER_STATUS=$(curl -s $BACKEND_URL/api/orders/$BUY_ORDER_ID)
BUY_STATUS=$(echo "$BUY_ORDER_STATUS" | jq -r '.status // .order.status // empty')
BUY_FILLED=$(echo "$BUY_ORDER_STATUS" | jq -r '.filled_quantity // .order.filled_quantity // "0"')

if [ "$BUY_STATUS" = "FILLED" ] && [ "$BUY_FILLED" = "100" ]; then
    print_success "BUY order is FILLED (filled_quantity: $BUY_FILLED)"
else
    print_error "BUY order status: $BUY_STATUS, filled_quantity: $BUY_FILLED (expected: FILLED, 100)"
    echo "Response: $BUY_ORDER_STATUS"
fi

# Step 6: Verify SELL order is FILLED
print_step "5️⃣  Verifying SELL order status..."
SELL_ORDER_STATUS=$(curl -s $BACKEND_URL/api/orders/$SELL_ORDER_ID)
SELL_STATUS=$(echo "$SELL_ORDER_STATUS" | jq -r '.status // .order.status // empty')
SELL_FILLED=$(echo "$SELL_ORDER_STATUS" | jq -r '.filled_quantity // .order.filled_quantity // "0"')

if [ "$SELL_STATUS" = "FILLED" ] && [ "$SELL_FILLED" = "100" ]; then
    print_success "SELL order is FILLED (filled_quantity: $SELL_FILLED)"
else
    print_error "SELL order status: $SELL_STATUS, filled_quantity: $SELL_FILLED (expected: FILLED, 100)"
    echo "Response: $SELL_ORDER_STATUS"
fi

# Step 7: Verify match exists for buyer
print_step "6️⃣  Verifying match exists for buyer..."
BUYER_MATCHES=$(curl -s $BACKEND_URL/api/matches/user/$BUYER_ADDRESS)
BUYER_MATCH_COUNT=$(echo "$BUYER_MATCHES" | jq 'length // 0')

if [ "$BUYER_MATCH_COUNT" -gt 0 ]; then
    print_success "Found $BUYER_MATCH_COUNT match(es) for buyer"
else
    print_error "No matches found for buyer"
    echo "Response: $BUYER_MATCHES"
fi

# Step 8: Verify match exists for seller
print_step "7️⃣  Verifying match exists for seller..."
SELLER_MATCHES=$(curl -s $BACKEND_URL/api/matches/user/$SELLER_ADDRESS)
SELLER_MATCH_COUNT=$(echo "$SELLER_MATCHES" | jq 'length // 0')

if [ "$SELLER_MATCH_COUNT" -gt 0 ]; then
    print_success "Found $SELLER_MATCH_COUNT match(es) for seller"
else
    print_error "No matches found for seller"
    echo "Response: $SELLER_MATCHES"
fi

# Step 9: Direct database verification
print_step "8️⃣  Verifying database state..."
print_info "Checking orders table..."

DB_ORDERS=$(docker exec darkpool-postgres psql -U darkpool -d darkpool -t -c \
  "SELECT COUNT(*) FROM orders WHERE id IN ('$BUY_ORDER_ID', '$SELL_ORDER_ID') AND status = 'FILLED' AND filled_quantity = quantity;")

DB_ORDER_COUNT=$(echo "$DB_ORDERS" | tr -d ' ')
if [ "$DB_ORDER_COUNT" = "2" ]; then
    print_success "Database: Both orders are FILLED"
else
    print_error "Database: Expected 2 filled orders, found $DB_ORDER_COUNT"
fi

print_info "Checking matches table..."
DB_MATCHES=$(docker exec darkpool-postgres psql -U darkpool -d darkpool -t -c \
  "SELECT COUNT(*) FROM matches WHERE buy_order_id = '$BUY_ORDER_ID' OR sell_order_id = '$SELL_ORDER_ID';")

DB_MATCH_COUNT=$(echo "$DB_MATCHES" | tr -d ' ')
if [ "$DB_MATCH_COUNT" -ge "1" ]; then
    print_success "Database: Found $DB_MATCH_COUNT match(es)"
else
    print_error "Database: Expected at least 1 match, found $DB_MATCH_COUNT"
fi

# Final summary
echo ""
echo "=========================================="
if [ $TESTS_FAILED -eq 0 ]; then
    echo -e "${GREEN}🎉 All tests passed!${NC}"
    echo ""
    echo "Summary:"
    echo "  - BUY order ID: $BUY_ORDER_ID"
    echo "  - SELL order ID: $SELL_ORDER_ID"
    echo "  - Buyer matches: $BUYER_MATCH_COUNT"
    echo "  - Seller matches: $SELLER_MATCH_COUNT"
    echo "  - Tests passed: $TESTS_PASSED"
    exit 0
else
    echo -e "${RED}❌ Some tests failed${NC}"
    echo ""
    echo "Summary:"
    echo "  - Tests passed: $TESTS_PASSED"
    echo "  - Tests failed: $TESTS_FAILED"
    exit 1
fi
