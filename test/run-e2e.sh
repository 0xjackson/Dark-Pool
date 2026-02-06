#!/bin/bash

# E2E Test Runner
# Ensures all prerequisites are met before running tests

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_step() {
    echo -e "\n${BLUE}$1${NC}"
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_info() {
    echo -e "${YELLOW}ℹ $1${NC}"
}

echo -e "${BLUE}🚀 Dark Pool E2E Test Runner${NC}"
echo "=============================="

# Check if Docker is running
print_step "1️⃣  Checking Docker..."
if ! docker info > /dev/null 2>&1; then
    print_error "Docker is not running. Please start Docker and try again."
    exit 1
fi
print_success "Docker is running"

# Check if required services are running
print_step "2️⃣  Checking required services..."

check_service() {
    SERVICE_NAME=$1
    if docker ps --filter "name=$SERVICE_NAME" --filter "status=running" | grep -q "$SERVICE_NAME"; then
        print_success "$SERVICE_NAME is running"
        return 0
    else
        print_error "$SERVICE_NAME is not running"
        return 1
    fi
}

SERVICES_OK=true
check_service "darkpool-postgres" || SERVICES_OK=false
check_service "darkpool-warlock" || SERVICES_OK=false
check_service "darkpool-backend" || SERVICES_OK=false

if [ "$SERVICES_OK" = false ]; then
    print_info "Starting services..."
    docker-compose up -d postgres warlock backend
    print_info "Waiting 10 seconds for services to initialize..."
    sleep 10
fi

# Check if database is ready
print_step "3️⃣  Checking database..."
MAX_RETRIES=10
RETRY_COUNT=0

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    if docker exec darkpool-postgres psql -U darkpool -d darkpool -c "SELECT 1;" > /dev/null 2>&1; then
        print_success "Database is ready"
        break
    fi

    RETRY_COUNT=$((RETRY_COUNT + 1))
    if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
        print_error "Database is not responding after $MAX_RETRIES attempts"
        exit 1
    fi

    print_info "Waiting for database... (attempt $RETRY_COUNT/$MAX_RETRIES)"
    sleep 2
done

# Check if migrations are applied
print_step "4️⃣  Checking database schema..."
TABLES_EXIST=$(docker exec darkpool-postgres psql -U darkpool -d darkpool -t -c \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_name IN ('orders', 'matches');")

TABLE_COUNT=$(echo "$TABLES_EXIST" | tr -d ' ')
if [ "$TABLE_COUNT" != "2" ]; then
    print_info "Running database migrations..."
    docker exec -i darkpool-postgres psql -U darkpool -d darkpool < warlock/migrations/001_initial_schema.up.sql
    print_success "Migrations applied"
else
    print_success "Schema is up to date"
fi

# Check if backend is responding
print_step "5️⃣  Checking backend health..."
MAX_RETRIES=10
RETRY_COUNT=0

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    if curl -s http://localhost:3001/health > /dev/null 2>&1; then
        print_success "Backend is responding"
        break
    fi

    RETRY_COUNT=$((RETRY_COUNT + 1))
    if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
        print_error "Backend is not responding after $MAX_RETRIES attempts"
        print_info "Check backend logs with: docker logs darkpool-backend"
        exit 1
    fi

    print_info "Waiting for backend... (attempt $RETRY_COUNT/$MAX_RETRIES)"
    sleep 2
done

# Check if jq is installed
print_step "6️⃣  Checking dependencies..."
if ! command -v jq &> /dev/null; then
    print_error "jq is not installed"
    echo "  Mac: brew install jq"
    echo "  Ubuntu: apt-get install jq"
    exit 1
fi
print_success "All dependencies installed"

# Run the E2E test
print_step "7️⃣  Running E2E tests..."
echo ""

cd "$(dirname "$0")"
chmod +x e2e-simple.sh
./e2e-simple.sh

TEST_EXIT_CODE=$?

if [ $TEST_EXIT_CODE -eq 0 ]; then
    echo ""
    print_success "Test run completed successfully!"
else
    echo ""
    print_error "Test run failed with exit code $TEST_EXIT_CODE"
fi

exit $TEST_EXIT_CODE
