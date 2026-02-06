package matcher

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
	"github.com/shopspring/decimal"
)

// Match represents an executed trade
type Match struct {
	ID               string
	BuyOrderID       string
	SellOrderID      string
	BaseToken        string
	QuoteToken       string
	Quantity         decimal.Decimal
	Price            decimal.Decimal
	SettlementStatus string
	MatchedAt        time.Time
	BuyerAddress     string
	SellerAddress    string
}

// MatchResult contains the results of matching an order
type MatchResult struct {
	Matches      []*Match
	UpdatedOrder *Order
}

// MatchOrder attempts to match an incoming order against the order book
// Returns any matches and the updated order
func MatchOrder(ctx context.Context, db *pgxpool.Pool, orderBook *OrderBook, incomingOrder *Order) (*MatchResult, error) {
	result := &MatchResult{
		Matches:      make([]*Match, 0),
		UpdatedOrder: incomingOrder,
	}

	// Don't match if the order is not active
	if !incomingOrder.IsActive() {
		return result, nil
	}

	// Find matching candidates from the opposite side
	candidates, err := findMatchingCandidates(ctx, db, incomingOrder)
	if err != nil {
		return nil, fmt.Errorf("failed to find matching candidates: %w", err)
	}

	log.Info().
		Str("order_id", incomingOrder.ID).
		Str("order_type", string(incomingOrder.OrderType)).
		Str("base_token", incomingOrder.BaseToken).
		Str("quote_token", incomingOrder.QuoteToken).
		Int("candidates", len(candidates)).
		Msg("Found matching candidates")

	// Process each candidate
	for _, candidate := range candidates {
		// Check if incoming order is fully filled
		if incomingOrder.RemainingQuantity.IsZero() {
			break
		}

		// Check if prices are compatible with variance tolerance
		compatible := isPriceCompatible(incomingOrder, candidate)

		log.Info().
			Str("incoming_order_id", incomingOrder.ID).
			Str("candidate_order_id", candidate.ID).
			Str("incoming_type", string(incomingOrder.OrderType)).
			Str("candidate_type", string(candidate.OrderType)).
			Str("incoming_min_price", incomingOrder.MinPrice.String()).
			Str("incoming_max_price", incomingOrder.MaxPrice.String()).
			Str("candidate_min_price", candidate.MinPrice.String()).
			Str("candidate_max_price", candidate.MaxPrice.String()).
			Bool("price_compatible", compatible).
			Msg("Checking price compatibility")

		if !compatible {
			continue
		}

		// Calculate match quantity
		matchQty := decimal.Min(incomingOrder.RemainingQuantity, candidate.RemainingQuantity)

		// Calculate execution price (average of buy and sell prices)
		executionPrice := calculateExecutionPrice(incomingOrder, candidate)

		// Execute the match in a database transaction
		match, err := executeMatch(ctx, db, incomingOrder, candidate, matchQty, executionPrice)
		if err != nil {
			log.Error().Err(err).
				Str("incoming_order_id", incomingOrder.ID).
				Str("candidate_order_id", candidate.ID).
				Msg("Failed to execute match")
			continue
		}

		result.Matches = append(result.Matches, match)

		log.Info().
			Str("match_id", match.ID).
			Str("buy_order_id", match.BuyOrderID).
			Str("sell_order_id", match.SellOrderID).
			Str("quantity", matchQty.String()).
			Str("price", executionPrice.String()).
			Msg("Match executed")
	}

	return result, nil
}

// findMatchingCandidates queries the database for potential matching orders
func findMatchingCandidates(ctx context.Context, db *pgxpool.Pool, order *Order) ([]*Order, error) {
	var query string
	var args []interface{}

	if order.OrderType == OrderTypeBuy {
		// Find SELL orders where sell.min_price <= buy.max_price
		query = `
			SELECT id, user_address, chain_id, order_type, base_token, quote_token,
			       quantity, price, variance_bps, min_price, max_price,
			       filled_quantity, remaining_quantity, status, created_at, expires_at
			FROM orders
			WHERE base_token = $1
			  AND quote_token = $2
			  AND order_type = 'SELL'
			  AND status IN ('REVEALED', 'PARTIALLY_FILLED')
			  AND min_price <= $3
			  AND (expires_at IS NULL OR expires_at > NOW())
			ORDER BY min_price ASC, created_at ASC
			LIMIT 100
		`
		args = []interface{}{order.BaseToken, order.QuoteToken, order.MaxPrice.String()}
	} else {
		// Find BUY orders where buy.max_price >= sell.min_price
		query = `
			SELECT id, user_address, chain_id, order_type, base_token, quote_token,
			       quantity, price, variance_bps, min_price, max_price,
			       filled_quantity, remaining_quantity, status, created_at, expires_at
			FROM orders
			WHERE base_token = $1
			  AND quote_token = $2
			  AND order_type = 'BUY'
			  AND status IN ('REVEALED', 'PARTIALLY_FILLED')
			  AND max_price >= $3
			  AND (expires_at IS NULL OR expires_at > NOW())
			ORDER BY max_price DESC, created_at ASC
			LIMIT 100
		`
		args = []interface{}{order.BaseToken, order.QuoteToken, order.MinPrice.String()}
	}

	rows, err := db.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to query candidates: %w", err)
	}
	defer rows.Close()

	candidates := make([]*Order, 0)
	for rows.Next() {
		var o Order
		var quantityStr, priceStr, minPriceStr, maxPriceStr, filledStr, remainingStr string
		var expiresAt *time.Time

		err := rows.Scan(
			&o.ID, &o.UserAddress, &o.ChainID, &o.OrderType, &o.BaseToken, &o.QuoteToken,
			&quantityStr, &priceStr, &o.VarianceBPS, &minPriceStr, &maxPriceStr,
			&filledStr, &remainingStr, &o.Status, &o.CreatedAt, &expiresAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan candidate: %w", err)
		}

		// Handle nullable expires_at
		if expiresAt != nil {
			o.ExpiresAt = *expiresAt
		}

		// Parse decimal values
		o.Quantity, _ = decimal.NewFromString(quantityStr)
		o.Price, _ = decimal.NewFromString(priceStr)
		o.MinPrice, _ = decimal.NewFromString(minPriceStr)
		o.MaxPrice, _ = decimal.NewFromString(maxPriceStr)
		o.FilledQuantity, _ = decimal.NewFromString(filledStr)
		o.RemainingQuantity, _ = decimal.NewFromString(remainingStr)

		candidates = append(candidates, &o)
	}

	return candidates, nil
}

// isPriceCompatible checks if two orders can match based on variance tolerance
func isPriceCompatible(order1, order2 *Order) bool {
	var buyOrder, sellOrder *Order

	if order1.OrderType == OrderTypeBuy {
		buyOrder = order1
		sellOrder = order2
	} else {
		buyOrder = order2
		sellOrder = order1
	}

	// Check if buy.max_price >= sell.min_price
	return buyOrder.MaxPrice.GreaterThanOrEqual(sellOrder.MinPrice)
}

// calculateExecutionPrice determines the price at which the match executes
// Uses the average of buy and sell prices (can be customized)
func calculateExecutionPrice(order1, order2 *Order) decimal.Decimal {
	var buyOrder, sellOrder *Order

	if order1.OrderType == OrderTypeBuy {
		buyOrder = order1
		sellOrder = order2
	} else {
		buyOrder = order2
		sellOrder = order1
	}

	// Average of buy and sell prices
	avgPrice := buyOrder.Price.Add(sellOrder.Price).Div(decimal.NewFromInt(2))

	// Ensure execution price is within both orders' acceptable range
	executionPrice := avgPrice
	if executionPrice.LessThan(sellOrder.MinPrice) {
		executionPrice = sellOrder.MinPrice
	}
	if executionPrice.GreaterThan(buyOrder.MaxPrice) {
		executionPrice = buyOrder.MaxPrice
	}

	return executionPrice
}

// executeMatch creates a match and updates both orders in a database transaction
func executeMatch(ctx context.Context, db *pgxpool.Pool, order1, order2 *Order, quantity, price decimal.Decimal) (*Match, error) {
	var buyOrder, sellOrder *Order
	if order1.OrderType == OrderTypeBuy {
		buyOrder = order1
		sellOrder = order2
	} else {
		buyOrder = order2
		sellOrder = order1
	}

	// Start transaction
	tx, err := db.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	// Create match record
	var matchID string
	err = tx.QueryRow(ctx, `
		INSERT INTO matches (buy_order_id, sell_order_id, base_token, quote_token, quantity, price, settlement_status)
		VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')
		RETURNING id
	`, buyOrder.ID, sellOrder.ID, order1.BaseToken, order1.QuoteToken, quantity.String(), price.String()).Scan(&matchID)
	if err != nil {
		return nil, fmt.Errorf("failed to insert match: %w", err)
	}

	// Update buy order
	err = updateOrderFill(ctx, tx, buyOrder, quantity)
	if err != nil {
		return nil, fmt.Errorf("failed to update buy order: %w", err)
	}

	// Update sell order
	err = updateOrderFill(ctx, tx, sellOrder, quantity)
	if err != nil {
		return nil, fmt.Errorf("failed to update sell order: %w", err)
	}

	// Commit transaction
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("failed to commit transaction: %w", err)
	}

	// Update in-memory order quantities
	order1.FilledQuantity = order1.FilledQuantity.Add(quantity)
	order1.RemainingQuantity = order1.RemainingQuantity.Sub(quantity)
	if order1.RemainingQuantity.IsZero() {
		order1.Status = OrderStatusFilled
	} else {
		order1.Status = OrderStatusPartiallyFilled
	}

	order2.FilledQuantity = order2.FilledQuantity.Add(quantity)
	order2.RemainingQuantity = order2.RemainingQuantity.Sub(quantity)
	if order2.RemainingQuantity.IsZero() {
		order2.Status = OrderStatusFilled
	} else {
		order2.Status = OrderStatusPartiallyFilled
	}

	match := &Match{
		ID:               matchID,
		BuyOrderID:       buyOrder.ID,
		SellOrderID:      sellOrder.ID,
		BaseToken:        order1.BaseToken,
		QuoteToken:       order1.QuoteToken,
		Quantity:         quantity,
		Price:            price,
		SettlementStatus: "PENDING",
		MatchedAt:        time.Now(),
		BuyerAddress:     buyOrder.UserAddress,
		SellerAddress:    sellOrder.UserAddress,
	}

	return match, nil
}

// updateOrderFill updates an order's fill quantities and status
func updateOrderFill(ctx context.Context, tx pgx.Tx, order *Order, quantity decimal.Decimal) error {
	newFilled := order.FilledQuantity.Add(quantity)
	newRemaining := order.RemainingQuantity.Sub(quantity)

	var newStatus OrderStatus
	if newRemaining.IsZero() {
		newStatus = OrderStatusFilled
	} else {
		newStatus = OrderStatusPartiallyFilled
	}

	_, err := tx.Exec(ctx, `
		UPDATE orders
		SET filled_quantity = $1,
		    remaining_quantity = $2,
		    status = $3
		WHERE id = $4
	`, newFilled.String(), newRemaining.String(), newStatus, order.ID)

	return err
}
