package grpc

import (
	"context"
	"fmt"
	"net"
	"time"

	"github.com/darkpool/warlock/internal/config"
	"github.com/darkpool/warlock/internal/matcher"
	pb "github.com/darkpool/warlock/pkg/api/proto"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
	"github.com/shopspring/decimal"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// Server implements the gRPC MatcherService
type Server struct {
	pb.UnimplementedMatcherServiceServer
	engine    *matcher.Engine
	db        *pgxpool.Pool
	cfg       *config.Config
	grpcSrv   *grpc.Server
	startTime time.Time
}

// NewServer creates a new gRPC server
func NewServer(engine *matcher.Engine, db *pgxpool.Pool, cfg *config.Config) *Server {
	return &Server{
		engine:    engine,
		db:        db,
		cfg:       cfg,
		startTime: time.Now(),
	}
}

// Start starts the gRPC server
func (s *Server) Start() error {
	lis, err := net.Listen("tcp", fmt.Sprintf(":%d", s.cfg.GRPCPort))
	if err != nil {
		return fmt.Errorf("failed to listen: %w", err)
	}

	s.grpcSrv = grpc.NewServer(
		grpc.MaxRecvMsgSize(10 * 1024 * 1024), // 10MB
		grpc.MaxSendMsgSize(10 * 1024 * 1024), // 10MB
	)

	pb.RegisterMatcherServiceServer(s.grpcSrv, s)

	log.Info().Int("port", s.cfg.GRPCPort).Msg("gRPC server starting")

	if err := s.grpcSrv.Serve(lis); err != nil {
		return fmt.Errorf("failed to serve: %w", err)
	}

	return nil
}

// Stop gracefully stops the gRPC server
func (s *Server) Stop() {
	if s.grpcSrv != nil {
		log.Info().Msg("Stopping gRPC server")
		s.grpcSrv.GracefulStop()
	}
}

// SubmitOrder handles order submission
func (s *Server) SubmitOrder(ctx context.Context, req *pb.SubmitOrderRequest) (*pb.SubmitOrderResponse, error) {
	log.Info().
		Str("user_address", req.UserAddress).
		Str("order_type", req.OrderType.String()).
		Str("base_token", req.BaseToken).
		Str("quote_token", req.QuoteToken).
		Msg("Received SubmitOrder request")

	// Validate request
	if err := validateSubmitOrderRequest(req); err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "invalid request: %v", err)
	}

	// Parse decimal values
	quantity, err := decimal.NewFromString(req.Quantity)
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "invalid quantity: %v", err)
	}

	price, err := decimal.NewFromString(req.Price)
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "invalid price: %v", err)
	}

	// Calculate min and max price based on variance
	varianceFactor := decimal.NewFromInt(int64(req.VarianceBps)).Div(decimal.NewFromInt(10000))
	minPrice := price.Mul(decimal.NewFromInt(1).Sub(varianceFactor))
	maxPrice := price.Mul(decimal.NewFromInt(1).Add(varianceFactor))

	// Calculate expiration time
	var expiresAt time.Time
	if req.ExpiresInSeconds > 0 {
		expiresAt = time.Now().Add(time.Duration(req.ExpiresInSeconds) * time.Second)
	}

	// Create order in database
	orderID := uuid.New().String()
	_, err = s.db.Exec(ctx, `
		INSERT INTO orders (
			id, user_address, chain_id, order_type, base_token, quote_token,
			quantity, price, variance_bps, min_price, max_price,
			filled_quantity, remaining_quantity, status,
			commitment_hash, order_id, sell_amount, min_buy_amount, expires_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
	`,
		orderID, req.UserAddress, req.ChainId, orderTypeToString(req.OrderType),
		req.BaseToken, req.QuoteToken,
		quantity.String(), price.String(), req.VarianceBps, minPrice.String(), maxPrice.String(),
		"0", quantity.String(), "REVEALED",
		req.CommitmentHash, req.OrderId, req.SellAmount, req.MinBuyAmount, nullTimeOrValue(expiresAt),
	)
	if err != nil {
		log.Error().Err(err).Msg("Failed to insert order")
		return nil, status.Errorf(codes.Internal, "failed to create order: %v", err)
	}

	// Wait for transaction to be committed and visible to concurrent readers
	// This eliminates the race condition where a matching order might query the DB
	// before this transaction is committed
	// Note: Using 50ms to ensure cross-connection visibility in the connection pool
	time.Sleep(50 * time.Millisecond)

	// Create order object
	order := &matcher.Order{
		ID:                orderID,
		UserAddress:       req.UserAddress,
		ChainID:           req.ChainId,
		OrderType:         orderTypeFromProto(req.OrderType),
		BaseToken:         req.BaseToken,
		QuoteToken:        req.QuoteToken,
		Quantity:          quantity,
		Price:             price,
		VarianceBPS:       req.VarianceBps,
		MinPrice:          minPrice,
		MaxPrice:          maxPrice,
		FilledQuantity:    decimal.Zero,
		RemainingQuantity: quantity,
		Status:            matcher.OrderStatusRevealed,
		CreatedAt:         time.Now(),
		ExpiresAt:         expiresAt,
	}

	// Submit to matching engine
	if err := s.engine.SubmitOrder(order); err != nil {
		log.Error().Err(err).Msg("Failed to submit order to engine")
		return nil, status.Errorf(codes.Internal, "failed to submit order: %v", err)
	}

	// Build response
	resp := &pb.SubmitOrderResponse{
		Order:            orderToProto(order),
		ImmediateMatches: make([]*pb.Match, 0),
	}

	log.Info().Str("order_id", orderID).Msg("Order submitted successfully")

	return resp, nil
}

// CancelOrder handles order cancellation
func (s *Server) CancelOrder(ctx context.Context, req *pb.CancelOrderRequest) (*pb.CancelOrderResponse, error) {
	log.Info().
		Str("order_id", req.OrderId).
		Str("user_address", req.UserAddress).
		Msg("Received CancelOrder request")

	if req.OrderId == "" {
		return nil, status.Errorf(codes.InvalidArgument, "order_id is required")
	}

	if req.UserAddress == "" {
		return nil, status.Errorf(codes.InvalidArgument, "user_address is required")
	}

	// Submit cancel request to engine
	if err := s.engine.CancelOrder(req.OrderId, req.UserAddress); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to cancel order: %v", err)
	}

	return &pb.CancelOrderResponse{
		Success: true,
		Message: "Order cancelled successfully",
	}, nil
}

// GetOrderBook retrieves the order book for a token pair
func (s *Server) GetOrderBook(ctx context.Context, req *pb.GetOrderBookRequest) (*pb.GetOrderBookResponse, error) {
	if req.BaseToken == "" || req.QuoteToken == "" {
		return nil, status.Errorf(codes.InvalidArgument, "base_token and quote_token are required")
	}

	depth := req.Depth
	if depth <= 0 {
		depth = 20 // default
	}

	orderBook := s.engine.GetOrderBook(req.BaseToken, req.QuoteToken)
	if orderBook == nil {
		// Return empty order book
		return &pb.GetOrderBookResponse{
			BaseToken:  req.BaseToken,
			QuoteToken: req.QuoteToken,
			Bids:       make([]*pb.PriceLevel, 0),
			Asks:       make([]*pb.PriceLevel, 0),
			Timestamp:  timestamppb.Now(),
		}, nil
	}

	// Get bids and asks
	bids := buildPriceLevels(orderBook.GetBids(), int(depth))
	asks := buildPriceLevels(orderBook.GetAsks(), int(depth))

	return &pb.GetOrderBookResponse{
		BaseToken:  req.BaseToken,
		QuoteToken: req.QuoteToken,
		Bids:       bids,
		Asks:       asks,
		Timestamp:  timestamppb.Now(),
	}, nil
}

// StreamMatches streams match events
func (s *Server) StreamMatches(req *pb.StreamMatchesRequest, stream pb.MatcherService_StreamMatchesServer) error {
	log.Info().
		Str("base_token", req.BaseToken).
		Str("quote_token", req.QuoteToken).
		Str("user_address", req.UserAddress).
		Msg("Client connected to StreamMatches")

	matchChan := s.engine.MatchChan()

	for {
		select {
		case <-stream.Context().Done():
			log.Info().Msg("Client disconnected from StreamMatches")
			return nil

		case match := <-matchChan:
			// Apply filters
			if req.BaseToken != "" && match.BaseToken != req.BaseToken {
				continue
			}
			if req.QuoteToken != "" && match.QuoteToken != req.QuoteToken {
				continue
			}
			if req.UserAddress != "" &&
				match.BuyerAddress != req.UserAddress &&
				match.SellerAddress != req.UserAddress {
				continue
			}

			// Send match event
			event := &pb.MatchEvent{
				Match:     matchToProto(match),
				EventTime: timestamppb.Now(),
			}

			if err := stream.Send(event); err != nil {
				log.Error().Err(err).Msg("Failed to send match event")
				return err
			}
		}
	}
}

// HealthCheck returns service health status
func (s *Server) HealthCheck(ctx context.Context, req *pb.HealthCheckRequest) (*pb.HealthCheckResponse, error) {
	stats := s.engine.GetStats()

	return &pb.HealthCheckResponse{
		Healthy:       true,
		Version:       s.cfg.ServiceVersion,
		UptimeSeconds: int64(time.Since(s.startTime).Seconds()),
		TotalOrders:   stats.TotalOrders,
		TotalMatches:  stats.TotalMatches,
	}, nil
}

// Helper functions

func validateSubmitOrderRequest(req *pb.SubmitOrderRequest) error {
	if req.UserAddress == "" {
		return fmt.Errorf("user_address is required")
	}
	if req.BaseToken == "" {
		return fmt.Errorf("base_token is required")
	}
	if req.QuoteToken == "" {
		return fmt.Errorf("quote_token is required")
	}
	if req.Quantity == "" || req.Quantity == "0" {
		return fmt.Errorf("quantity must be > 0")
	}
	if req.Price == "" || req.Price == "0" {
		return fmt.Errorf("price must be > 0")
	}
	if req.VarianceBps < 0 || req.VarianceBps > 10000 {
		return fmt.Errorf("variance_bps must be between 0 and 10000")
	}
	if req.OrderType == pb.OrderType_ORDER_TYPE_UNSPECIFIED {
		return fmt.Errorf("order_type is required")
	}
	return nil
}

func orderTypeToString(ot pb.OrderType) string {
	if ot == pb.OrderType_ORDER_TYPE_BUY {
		return "BUY"
	}
	return "SELL"
}

func orderTypeFromProto(ot pb.OrderType) matcher.OrderType {
	if ot == pb.OrderType_ORDER_TYPE_BUY {
		return matcher.OrderTypeBuy
	}
	return matcher.OrderTypeSell
}

func orderTypeToProto(ot matcher.OrderType) pb.OrderType {
	if ot == matcher.OrderTypeBuy {
		return pb.OrderType_ORDER_TYPE_BUY
	}
	return pb.OrderType_ORDER_TYPE_SELL
}

func orderStatusToProto(os matcher.OrderStatus) pb.OrderStatus {
	switch os {
	case matcher.OrderStatusPending:
		return pb.OrderStatus_ORDER_STATUS_PENDING
	case matcher.OrderStatusCommitted:
		return pb.OrderStatus_ORDER_STATUS_COMMITTED
	case matcher.OrderStatusRevealed:
		return pb.OrderStatus_ORDER_STATUS_REVEALED
	case matcher.OrderStatusPartiallyFilled:
		return pb.OrderStatus_ORDER_STATUS_PARTIALLY_FILLED
	case matcher.OrderStatusFilled:
		return pb.OrderStatus_ORDER_STATUS_FILLED
	case matcher.OrderStatusCancelled:
		return pb.OrderStatus_ORDER_STATUS_CANCELLED
	default:
		return pb.OrderStatus_ORDER_STATUS_UNSPECIFIED
	}
}

func orderToProto(o *matcher.Order) *pb.Order {
	return &pb.Order{
		Id:                o.ID,
		UserAddress:       o.UserAddress,
		ChainId:           o.ChainID,
		OrderType:         orderTypeToProto(o.OrderType),
		BaseToken:         o.BaseToken,
		QuoteToken:        o.QuoteToken,
		Quantity:          o.Quantity.String(),
		Price:             o.Price.String(),
		VarianceBps:       o.VarianceBPS,
		MinPrice:          o.MinPrice.String(),
		MaxPrice:          o.MaxPrice.String(),
		FilledQuantity:    o.FilledQuantity.String(),
		RemainingQuantity: o.RemainingQuantity.String(),
		Status:            orderStatusToProto(o.Status),
		CreatedAt:         timestamppb.New(o.CreatedAt),
		ExpiresAt:         timestamppb.New(o.ExpiresAt),
	}
}

func matchToProto(m *matcher.Match) *pb.Match {
	return &pb.Match{
		Id:               m.ID,
		BuyOrderId:       m.BuyOrderID,
		SellOrderId:      m.SellOrderID,
		BaseToken:        m.BaseToken,
		QuoteToken:       m.QuoteToken,
		Quantity:         m.Quantity.String(),
		Price:            m.Price.String(),
		SettlementStatus: settlementStatusToProto(m.SettlementStatus),
		MatchedAt:        timestamppb.New(m.MatchedAt),
		BuyerAddress:     m.BuyerAddress,
		SellerAddress:    m.SellerAddress,
	}
}

func settlementStatusToProto(status string) pb.SettlementStatus {
	switch status {
	case "PENDING":
		return pb.SettlementStatus_SETTLEMENT_STATUS_PENDING
	case "SETTLING":
		return pb.SettlementStatus_SETTLEMENT_STATUS_SETTLING
	case "SETTLED":
		return pb.SettlementStatus_SETTLEMENT_STATUS_SETTLED
	case "FAILED":
		return pb.SettlementStatus_SETTLEMENT_STATUS_FAILED
	default:
		return pb.SettlementStatus_SETTLEMENT_STATUS_UNSPECIFIED
	}
}

func buildPriceLevels(orders []*matcher.Order, depth int) []*pb.PriceLevel {
	// Aggregate orders by price
	priceMap := make(map[string]*pb.PriceLevel)
	prices := make([]string, 0)

	for _, order := range orders {
		priceStr := order.Price.String()

		if level, exists := priceMap[priceStr]; exists {
			qty, _ := decimal.NewFromString(level.Quantity)
			qty = qty.Add(order.RemainingQuantity)
			level.Quantity = qty.String()
			level.OrderCount++
		} else {
			priceMap[priceStr] = &pb.PriceLevel{
				Price:      priceStr,
				Quantity:   order.RemainingQuantity.String(),
				OrderCount: 1,
			}
			prices = append(prices, priceStr)
		}
	}

	// Build result (limit to depth)
	result := make([]*pb.PriceLevel, 0, len(prices))
	for i, priceStr := range prices {
		if i >= depth {
			break
		}
		result = append(result, priceMap[priceStr])
	}

	return result
}

func nullTimeOrValue(t time.Time) interface{} {
	if t.IsZero() {
		return nil
	}
	return t
}
