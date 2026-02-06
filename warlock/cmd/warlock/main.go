package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/darkpool/warlock/internal/config"
	"github.com/darkpool/warlock/internal/db"
	grpcserver "github.com/darkpool/warlock/internal/grpc"
	"github.com/darkpool/warlock/internal/matcher"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
)

func main() {
	// Setup logging
	setupLogging()

	log.Info().Msg("🧙 Warlock Matching Engine starting...")

	// Load configuration
	cfg, err := config.Load()
	if err != nil {
		log.Fatal().Err(err).Msg("Failed to load configuration")
	}

	if err := cfg.Validate(); err != nil {
		log.Fatal().Err(err).Msg("Invalid configuration")
	}

	log.Info().
		Int("grpc_port", cfg.GRPCPort).
		Int("workers", cfg.Workers).
		Str("log_level", cfg.LogLevel).
		Msg("Configuration loaded")

	// Create context for graceful shutdown
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Connect to database
	pool, err := db.New(ctx, cfg)
	if err != nil {
		log.Fatal().Err(err).Msg("Failed to connect to database")
	}
	defer db.Close(pool)

	// Run database migrations (simple check)
	if err := checkDatabaseSchema(ctx, pool); err != nil {
		log.Fatal().Err(err).Msg("Database schema check failed")
	}

	// Create matching engine
	engine := matcher.NewEngine(pool, cfg)

	// Start matching engine
	if err := engine.Start(ctx); err != nil {
		log.Fatal().Err(err).Msg("Failed to start matching engine")
	}
	defer engine.Stop()

	// Create gRPC server
	grpcSrv := grpcserver.NewServer(engine, pool, cfg)

	// Start gRPC server in a goroutine
	errChan := make(chan error, 1)
	go func() {
		if err := grpcSrv.Start(); err != nil {
			errChan <- err
		}
	}()

	// Wait for shutdown signal
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	select {
	case err := <-errChan:
		log.Fatal().Err(err).Msg("gRPC server error")
	case sig := <-sigChan:
		log.Info().Str("signal", sig.String()).Msg("Shutdown signal received")
	}

	// Graceful shutdown
	log.Info().Msg("Shutting down gracefully...")

	// Stop gRPC server
	grpcSrv.Stop()

	// Stop matching engine
	engine.Stop()

	// Close database
	db.Close(pool)

	log.Info().Msg("🧙 Warlock shut down successfully")
}

func setupLogging() {
	// Use console writer for human-readable logs
	output := zerolog.ConsoleWriter{
		Out:        os.Stdout,
		TimeFormat: time.RFC3339,
	}

	log.Logger = zerolog.New(output).With().Timestamp().Logger()

	// Set log level
	logLevel := os.Getenv("LOG_LEVEL")
	switch logLevel {
	case "debug":
		zerolog.SetGlobalLevel(zerolog.DebugLevel)
	case "warn":
		zerolog.SetGlobalLevel(zerolog.WarnLevel)
	case "error":
		zerolog.SetGlobalLevel(zerolog.ErrorLevel)
	default:
		zerolog.SetGlobalLevel(zerolog.InfoLevel)
	}
}

func checkDatabaseSchema(ctx context.Context, pool db.Pool) error {
	// Simple check to verify tables exist
	var exists bool
	err := pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT FROM information_schema.tables
			WHERE table_name = 'orders'
		)
	`).Scan(&exists)

	if err != nil {
		return err
	}

	if !exists {
		log.Warn().Msg("Database tables not found. Please run migrations:")
		log.Warn().Msg("  psql $DATABASE_URL < warlock/migrations/001_initial_schema.up.sql")
		return nil // Don't fail, just warn
	}

	log.Info().Msg("Database schema verified")
	return nil
}
