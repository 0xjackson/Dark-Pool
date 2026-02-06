package matcher

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/darkpool/warlock/internal/config"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
	"github.com/shopspring/decimal"
)

// Engine is the core matching engine
type Engine struct {
	db         *pgxpool.Pool
	cfg        *config.Config
	bookMgr    *OrderBookManager
	orderChan  chan *Order
	cancelChan chan *CancelRequest
	matchChan  chan *Match
	stopChan   chan struct{}
	wg         sync.WaitGroup
	started    bool
	mu         sync.Mutex

	// Statistics
	stats EngineStats
}

// EngineStats tracks engine statistics
type EngineStats struct {
	TotalOrders   int64
	TotalMatches  int64
	TotalCancels  int64
	StartTime     time.Time
	mu            sync.RWMutex
}

// CancelRequest represents a request to cancel an order
type CancelRequest struct {
	OrderID     string
	UserAddress string
}

// NewEngine creates a new matching engine
func NewEngine(db *pgxpool.Pool, cfg *config.Config) *Engine {
	return &Engine{
		db:         db,
		cfg:        cfg,
		bookMgr:    NewOrderBookManager(),
		orderChan:  make(chan *Order, cfg.OrderChannelSize),
		cancelChan: make(chan *CancelRequest, cfg.CancelChannelSize),
		matchChan:  make(chan *Match, cfg.MatchChannelSize),
		stopChan:   make(chan struct{}),
		stats: EngineStats{
			StartTime: time.Now(),
		},
	}
}

// Start starts the matching engine with worker pool
func (e *Engine) Start(ctx context.Context) error {
	e.mu.Lock()
	defer e.mu.Unlock()

	if e.started {
		return fmt.Errorf("engine already started")
	}

	log.Info().
		Int("workers", e.cfg.Workers).
		Msg("Starting matching engine")

	// Load existing orders from database into memory
	if err := e.loadExistingOrders(ctx); err != nil {
		return fmt.Errorf("failed to load existing orders: %w", err)
	}

	// Start worker pool
	for i := 0; i < e.cfg.Workers; i++ {
		e.wg.Add(1)
		go e.worker(ctx, i)
	}

	e.started = true
	log.Info().Msg("Matching engine started successfully")

	return nil
}

// Stop gracefully stops the matching engine
func (e *Engine) Stop() {
	e.mu.Lock()
	defer e.mu.Unlock()

	if !e.started {
		return
	}

	log.Info().Msg("Stopping matching engine")

	close(e.stopChan)
	e.wg.Wait()

	close(e.orderChan)
	close(e.cancelChan)
	close(e.matchChan)

	e.started = false
	log.Info().Msg("Matching engine stopped")
}

// SubmitOrder submits a new order to the matching engine
func (e *Engine) SubmitOrder(order *Order) error {
	select {
	case e.orderChan <- order:
		e.stats.mu.Lock()
		e.stats.TotalOrders++
		e.stats.mu.Unlock()
		return nil
	case <-e.stopChan:
		return fmt.Errorf("engine is stopped")
	default:
		return fmt.Errorf("order channel is full")
	}
}

// CancelOrder submits a cancel request
func (e *Engine) CancelOrder(orderID, userAddress string) error {
	select {
	case e.cancelChan <- &CancelRequest{OrderID: orderID, UserAddress: userAddress}:
		e.stats.mu.Lock()
		e.stats.TotalCancels++
		e.stats.mu.Unlock()
		return nil
	case <-e.stopChan:
		return fmt.Errorf("engine is stopped")
	default:
		return fmt.Errorf("cancel channel is full")
	}
}

// MatchChan returns the channel for match notifications
func (e *Engine) MatchChan() <-chan *Match {
	return e.matchChan
}

// GetStats returns engine statistics
func (e *Engine) GetStats() EngineStats {
	e.stats.mu.RLock()
	defer e.stats.mu.RUnlock()
	return e.stats
}

// worker processes orders and cancel requests
func (e *Engine) worker(ctx context.Context, workerID int) {
	defer e.wg.Done()

	log.Debug().Int("worker_id", workerID).Msg("Worker started")

	for {
		select {
		case <-e.stopChan:
			log.Debug().Int("worker_id", workerID).Msg("Worker stopped")
			return

		case order := <-e.orderChan:
			e.processOrder(ctx, order)

		case cancel := <-e.cancelChan:
			e.processCancelRequest(ctx, cancel)
		}
	}
}

// processOrder processes an incoming order
func (e *Engine) processOrder(ctx context.Context, order *Order) {
	log.Debug().
		Str("order_id", order.ID).
		Str("type", string(order.OrderType)).
		Str("base_token", order.BaseToken).
		Str("quote_token", order.QuoteToken).
		Str("quantity", order.Quantity.String()).
		Str("price", order.Price.String()).
		Int32("variance_bps", order.VarianceBPS).
		Msg("Processing order")

	// Get or create order book for this token pair
	orderBook := e.bookMgr.GetOrCreateBook(order.BaseToken, order.QuoteToken)

	// Add order to the order book
	orderBook.AddOrder(order)

	// Attempt to match the order
	result, err := MatchOrder(ctx, e.db, orderBook, order)
	if err != nil {
		log.Error().Err(err).
			Str("order_id", order.ID).
			Msg("Failed to match order")
		return
	}

	// Send match notifications
	for _, match := range result.Matches {
		select {
		case e.matchChan <- match:
			e.stats.mu.Lock()
			e.stats.TotalMatches++
			e.stats.mu.Unlock()

			log.Info().
				Str("match_id", match.ID).
				Str("buy_order", match.BuyOrderID).
				Str("sell_order", match.SellOrderID).
				Str("quantity", match.Quantity.String()).
				Str("price", match.Price.String()).
				Msg("Match notification sent")

		case <-e.stopChan:
			return
		}
	}

	// Remove filled orders from order book
	if order.Status == OrderStatusFilled {
		orderBook.RemoveOrder(order.ID)
		log.Debug().Str("order_id", order.ID).Msg("Order fully filled and removed from book")
	}
}

// processCancelRequest processes a cancel request
func (e *Engine) processCancelRequest(ctx context.Context, cancel *CancelRequest) {
	log.Debug().
		Str("order_id", cancel.OrderID).
		Str("user_address", cancel.UserAddress).
		Msg("Processing cancel request")

	// Update order status in database
	result, err := e.db.Exec(ctx, `
		UPDATE orders
		SET status = 'CANCELLED'
		WHERE id = $1
		  AND user_address = $2
		  AND status IN ('REVEALED', 'PARTIALLY_FILLED')
	`, cancel.OrderID, cancel.UserAddress)

	if err != nil {
		log.Error().Err(err).
			Str("order_id", cancel.OrderID).
			Msg("Failed to cancel order in database")
		return
	}

	rowsAffected := result.RowsAffected()
	if rowsAffected == 0 {
		log.Warn().
			Str("order_id", cancel.OrderID).
			Msg("Order not found or cannot be cancelled")
		return
	}

	// Remove from all order books
	// We need to check all books since we don't know which one it's in
	// This is not efficient but works for now - can optimize later
	e.bookMgr.mu.RLock()
	for _, book := range e.bookMgr.books {
		if order := book.GetOrder(cancel.OrderID); order != nil {
			book.RemoveOrder(cancel.OrderID)
			log.Info().
				Str("order_id", cancel.OrderID).
				Msg("Order cancelled and removed from book")
			break
		}
	}
	e.bookMgr.mu.RUnlock()
}

// loadExistingOrders loads existing active orders from database into memory
func (e *Engine) loadExistingOrders(ctx context.Context) error {
	log.Info().Msg("Loading existing orders from database")

	rows, err := e.db.Query(ctx, `
		SELECT id, user_address, chain_id, order_type, base_token, quote_token,
		       quantity, price, variance_bps, min_price, max_price,
		       filled_quantity, remaining_quantity, status, created_at, expires_at
		FROM orders
		WHERE status IN ('REVEALED', 'PARTIALLY_FILLED')
		  AND (expires_at IS NULL OR expires_at > NOW())
		ORDER BY created_at ASC
	`)
	if err != nil {
		return fmt.Errorf("failed to query existing orders: %w", err)
	}
	defer rows.Close()

	count := 0
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
			return fmt.Errorf("failed to scan order: %w", err)
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

		// Add to order book
		orderBook := e.bookMgr.GetOrCreateBook(o.BaseToken, o.QuoteToken)
		orderBook.AddOrder(&o)

		count++
	}

	log.Info().Int("count", count).Msg("Loaded existing orders into memory")
	return nil
}

// GetOrderBook retrieves the order book for a token pair
func (e *Engine) GetOrderBook(baseToken, quoteToken string) *OrderBook {
	return e.bookMgr.GetBook(baseToken, quoteToken)
}
