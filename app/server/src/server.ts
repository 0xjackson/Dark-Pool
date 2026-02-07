import express from 'express';
import { createServer } from 'http';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import ordersRouter, { setDatabase } from './routes/orders';
import sessionKeysRouter, { setSessionKeysDatabase } from './routes/sessionKeys';
import channelsRouter from './routes/channels';
import DarkPoolWebSocketServer from './websocket/server';
import { getWarlockClient } from './services/warlockClient';
import { initEngineConnection, setChannelDb } from './services/yellowConnection';
import { startSettlementWorker, stopSettlementWorker } from './services/settlementWorker';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

// Create HTTP server
const server = createServer(app);

// Database connection
const db = new Pool({
  connectionString: DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// Test database connection
db.query('SELECT NOW()', (err: Error | null, res: any) => {
  if (err) {
    console.error('Database connection error:', err);
    process.exit(1);
  }
  console.log('✅ Database connected:', res.rows[0].now);
});

// Set database for routes
setDatabase(db);
setSessionKeysDatabase(db);
setChannelDb(db);

// Middleware
app.use(express.json());

// CORS (enable in development)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Health check
app.get('/health', async (req, res) => {
  try {
    // Check database
    await db.query('SELECT 1');

    // Check Warlock connection
    const warlockClient = getWarlockClient();
    const warlockHealth = await warlockClient.healthCheck();

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      services: {
        database: 'connected',
        warlock: warlockHealth,
      },
    });
  } catch (error: any) {
    res.status(503).json({
      status: 'error',
      error: error.message,
    });
  }
});

// API Routes
app.use('/api/orders', ordersRouter);
app.use('/api/session-key', sessionKeysRouter);
app.use('/api/channel', channelsRouter);


// Initialize WebSocket server
const wsServer = new DarkPoolWebSocketServer(server);

// WebSocket stats endpoint
app.get('/api/ws/stats', (req, res) => {
  res.json(wsServer.getStats());
});

// Initialize Yellow Network connection and settlement worker
(async () => {
  try {
    await initEngineConnection(db);
    startSettlementWorker(db, wsServer);
  } catch (err) {
    console.error('Failed to initialize Yellow Network connection:', err);
    // Server still runs — settlement will be retried when connection recovers
  }
})();

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Dark Pool Backend running on port ${PORT}`);
  console.log(`   - HTTP: http://localhost:${PORT}`);
  console.log(`   - WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`   - Warlock gRPC: ${process.env.WARLOCK_GRPC_URL || 'localhost:50051'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  stopSettlementWorker();
  server.close(() => {
    wsServer.shutdown();
    db.end(() => {
      console.log('Database pool closed');
      process.exit(0);
    });
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  stopSettlementWorker();
  server.close(() => {
    wsServer.shutdown();
    db.end(() => {
      console.log('Database pool closed');
      process.exit(0);
    });
  });
});
