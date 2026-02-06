package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// Config holds all configuration for the warlock service
type Config struct {
	// Server configuration
	GRPCPort int
	Workers  int

	// Database configuration
	DatabaseURL         string
	DatabaseMaxConns    int
	DatabaseMinConns    int
	DatabaseMaxConnLife time.Duration

	// Matching engine configuration
	OrderChannelSize  int
	MatchChannelSize  int
	CancelChannelSize int

	// Logging
	LogLevel string

	// Service metadata
	ServiceName    string
	ServiceVersion string
}

// Load reads configuration from environment variables
func Load() (*Config, error) {
	cfg := &Config{
		// Defaults
		GRPCPort:            50051,
		Workers:             4,
		DatabaseMaxConns:    25,
		DatabaseMinConns:    5,
		DatabaseMaxConnLife: 30 * time.Minute,
		OrderChannelSize:    1000,
		MatchChannelSize:    1000,
		CancelChannelSize:   100,
		LogLevel:            "info",
		ServiceName:         "warlock",
		ServiceVersion:      "0.1.0",
	}

	// Override from environment variables
	if port := os.Getenv("GRPC_PORT"); port != "" {
		p, err := strconv.Atoi(port)
		if err != nil {
			return nil, fmt.Errorf("invalid GRPC_PORT: %w", err)
		}
		cfg.GRPCPort = p
	}

	if workers := os.Getenv("WORKERS"); workers != "" {
		w, err := strconv.Atoi(workers)
		if err != nil {
			return nil, fmt.Errorf("invalid WORKERS: %w", err)
		}
		cfg.Workers = w
	}

	// Database URL is required
	cfg.DatabaseURL = os.Getenv("DATABASE_URL")
	if cfg.DatabaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL environment variable is required")
	}

	if maxConns := os.Getenv("DB_MAX_CONNS"); maxConns != "" {
		mc, err := strconv.Atoi(maxConns)
		if err != nil {
			return nil, fmt.Errorf("invalid DB_MAX_CONNS: %w", err)
		}
		cfg.DatabaseMaxConns = mc
	}

	if logLevel := os.Getenv("LOG_LEVEL"); logLevel != "" {
		cfg.LogLevel = logLevel
	}

	return cfg, nil
}

// Validate checks that the configuration is valid
func (c *Config) Validate() error {
	if c.GRPCPort < 1 || c.GRPCPort > 65535 {
		return fmt.Errorf("invalid GRPC_PORT: must be between 1 and 65535")
	}

	if c.Workers < 1 {
		return fmt.Errorf("invalid WORKERS: must be at least 1")
	}

	if c.DatabaseURL == "" {
		return fmt.Errorf("DATABASE_URL is required")
	}

	if c.DatabaseMaxConns < c.DatabaseMinConns {
		return fmt.Errorf("DB_MAX_CONNS must be >= DB_MIN_CONNS")
	}

	return nil
}
