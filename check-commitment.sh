#!/bin/bash
ROUTER="0x..." # Need the actual router address
ORDER_ID="0x05a8b9a87fe50d2418242df7c644e8d8c408ae9d4d70cffc21cd27e11aeb46db"

echo "Checking on-chain commitment for order $ORDER_ID..."
echo "Router address: $ROUTER"
echo ""
echo "Would call: cast call $ROUTER 'commitments(bytes32)' $ORDER_ID"
