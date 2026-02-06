package matcher

import (
	"container/heap"
	"sync"
	"time"

	"github.com/shopspring/decimal"
)

// Order represents an order in the order book
type Order struct {
	ID               string
	UserAddress      string
	ChainID          int32
	OrderType        OrderType
	BaseToken        string
	QuoteToken       string
	Quantity         decimal.Decimal
	Price            decimal.Decimal
	VarianceBPS      int32
	MinPrice         decimal.Decimal
	MaxPrice         decimal.Decimal
	FilledQuantity   decimal.Decimal
	RemainingQuantity decimal.Decimal
	Status           OrderStatus
	CreatedAt        time.Time
	ExpiresAt        time.Time
}

// OrderType represents buy or sell
type OrderType string

const (
	OrderTypeBuy  OrderType = "BUY"
	OrderTypeSell OrderType = "SELL"
)

// OrderStatus represents the order lifecycle
type OrderStatus string

const (
	OrderStatusPending         OrderStatus = "PENDING"
	OrderStatusCommitted       OrderStatus = "COMMITTED"
	OrderStatusRevealed        OrderStatus = "REVEALED"
	OrderStatusPartiallyFilled OrderStatus = "PARTIALLY_FILLED"
	OrderStatusFilled          OrderStatus = "FILLED"
	OrderStatusCancelled       OrderStatus = "CANCELLED"
)

// IsActive returns true if the order can be matched
func (o *Order) IsActive() bool {
	return o.Status == OrderStatusRevealed || o.Status == OrderStatusPartiallyFilled
}

// OrderBook maintains buy and sell orders for a token pair
type OrderBook struct {
	baseToken  string
	quoteToken string
	bids       *PriorityQueue // BUY orders (highest price first)
	asks       *PriorityQueue // SELL orders (lowest price first)
	ordersByID map[string]*Order
	mu         sync.RWMutex
}

// NewOrderBook creates a new order book for a token pair
func NewOrderBook(baseToken, quoteToken string) *OrderBook {
	return &OrderBook{
		baseToken:  baseToken,
		quoteToken: quoteToken,
		bids:       NewPriorityQueue(true),  // true = descending (highest bid first)
		asks:       NewPriorityQueue(false), // false = ascending (lowest ask first)
		ordersByID: make(map[string]*Order),
	}
}

// AddOrder adds an order to the order book
func (ob *OrderBook) AddOrder(order *Order) {
	ob.mu.Lock()
	defer ob.mu.Unlock()

	if order.OrderType == OrderTypeBuy {
		heap.Push(ob.bids, order)
	} else {
		heap.Push(ob.asks, order)
	}

	ob.ordersByID[order.ID] = order
}

// RemoveOrder removes an order from the order book
func (ob *OrderBook) RemoveOrder(orderID string) *Order {
	ob.mu.Lock()
	defer ob.mu.Unlock()

	order, exists := ob.ordersByID[orderID]
	if !exists {
		return nil
	}

	delete(ob.ordersByID, orderID)

	// Remove from the appropriate queue
	if order.OrderType == OrderTypeBuy {
		ob.bids.Remove(order)
	} else {
		ob.asks.Remove(order)
	}

	return order
}

// GetOrder retrieves an order by ID
func (ob *OrderBook) GetOrder(orderID string) *Order {
	ob.mu.RLock()
	defer ob.mu.RUnlock()
	return ob.ordersByID[orderID]
}

// PeekBestBid returns the highest bid without removing it
func (ob *OrderBook) PeekBestBid() *Order {
	ob.mu.RLock()
	defer ob.mu.RUnlock()

	if ob.bids.Len() == 0 {
		return nil
	}
	return ob.bids.Peek()
}

// PeekBestAsk returns the lowest ask without removing it
func (ob *OrderBook) PeekBestAsk() *Order {
	ob.mu.RLock()
	defer ob.mu.RUnlock()

	if ob.asks.Len() == 0 {
		return nil
	}
	return ob.asks.Peek()
}

// GetBids returns all bid orders (buy orders)
func (ob *OrderBook) GetBids() []*Order {
	ob.mu.RLock()
	defer ob.mu.RUnlock()
	return ob.bids.GetAll()
}

// GetAsks returns all ask orders (sell orders)
func (ob *OrderBook) GetAsks() []*Order {
	ob.mu.RLock()
	defer ob.mu.RUnlock()
	return ob.asks.GetAll()
}

// Size returns the total number of orders in the book
func (ob *OrderBook) Size() int {
	ob.mu.RLock()
	defer ob.mu.RUnlock()
	return len(ob.ordersByID)
}

// PriorityQueue implements a heap-based priority queue for orders
type PriorityQueue struct {
	orders     []*Order
	descending bool // true for bids (highest first), false for asks (lowest first)
	mu         sync.RWMutex
}

// NewPriorityQueue creates a new priority queue
func NewPriorityQueue(descending bool) *PriorityQueue {
	pq := &PriorityQueue{
		orders:     make([]*Order, 0),
		descending: descending,
	}
	heap.Init(pq)
	return pq
}

// Len implements heap.Interface
func (pq *PriorityQueue) Len() int {
	return len(pq.orders)
}

// Less implements heap.Interface
// For bids: higher price comes first, then earlier time
// For asks: lower price comes first, then earlier time
func (pq *PriorityQueue) Less(i, j int) bool {
	orderI := pq.orders[i]
	orderJ := pq.orders[j]

	// Price comparison
	priceI := orderI.Price
	priceJ := orderJ.Price

	if !priceI.Equal(priceJ) {
		if pq.descending {
			return priceI.GreaterThan(priceJ) // Descending: higher price first
		}
		return priceI.LessThan(priceJ) // Ascending: lower price first
	}

	// Time priority: earlier orders come first
	return orderI.CreatedAt.Before(orderJ.CreatedAt)
}

// Swap implements heap.Interface
func (pq *PriorityQueue) Swap(i, j int) {
	pq.orders[i], pq.orders[j] = pq.orders[j], pq.orders[i]
}

// Push implements heap.Interface
func (pq *PriorityQueue) Push(x interface{}) {
	order := x.(*Order)
	pq.orders = append(pq.orders, order)
}

// Pop implements heap.Interface
func (pq *PriorityQueue) Pop() interface{} {
	old := pq.orders
	n := len(old)
	order := old[n-1]
	old[n-1] = nil // avoid memory leak
	pq.orders = old[0 : n-1]
	return order
}

// Peek returns the top order without removing it
func (pq *PriorityQueue) Peek() *Order {
	if len(pq.orders) == 0 {
		return nil
	}
	return pq.orders[0]
}

// Remove removes a specific order from the queue
func (pq *PriorityQueue) Remove(order *Order) {
	for i, o := range pq.orders {
		if o.ID == order.ID {
			heap.Remove(pq, i)
			return
		}
	}
}

// GetAll returns all orders in the queue (sorted)
func (pq *PriorityQueue) GetAll() []*Order {
	result := make([]*Order, len(pq.orders))
	copy(result, pq.orders)
	return result
}

// OrderBookManager manages multiple order books (one per token pair)
type OrderBookManager struct {
	books map[string]*OrderBook // key: "baseToken-quoteToken"
	mu    sync.RWMutex
}

// NewOrderBookManager creates a new order book manager
func NewOrderBookManager() *OrderBookManager {
	return &OrderBookManager{
		books: make(map[string]*OrderBook),
	}
}

// GetOrCreateBook gets or creates an order book for a token pair
func (obm *OrderBookManager) GetOrCreateBook(baseToken, quoteToken string) *OrderBook {
	key := makeBookKey(baseToken, quoteToken)

	obm.mu.RLock()
	book, exists := obm.books[key]
	obm.mu.RUnlock()

	if exists {
		return book
	}

	obm.mu.Lock()
	defer obm.mu.Unlock()

	// Double-check in case another goroutine created it
	book, exists = obm.books[key]
	if exists {
		return book
	}

	book = NewOrderBook(baseToken, quoteToken)
	obm.books[key] = book
	return book
}

// GetBook retrieves an order book for a token pair
func (obm *OrderBookManager) GetBook(baseToken, quoteToken string) *OrderBook {
	key := makeBookKey(baseToken, quoteToken)

	obm.mu.RLock()
	defer obm.mu.RUnlock()

	return obm.books[key]
}

// makeBookKey creates a unique key for a token pair
func makeBookKey(baseToken, quoteToken string) string {
	return baseToken + "-" + quoteToken
}
