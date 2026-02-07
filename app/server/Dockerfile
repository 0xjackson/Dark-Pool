# Stage 1: Build TypeScript
FROM node:20-alpine AS builder
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev dependencies for build)
RUN npm ci

# Copy source code
COPY . .

# Compile TypeScript to JavaScript
RUN npm run build

# Stage 2: Production runtime
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 expressjs

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production

# Copy compiled code from builder
COPY --from=builder /app/dist ./dist

# Copy proto files (not compiled by tsc)
COPY --from=builder /app/src/proto ./dist/proto

# Copy ZK circuit files
COPY --from=builder /app/circuits ./circuits

# Set correct permissions
RUN chown -R expressjs:nodejs /app

USER expressjs

EXPOSE 3001

CMD ["node", "dist/server.js"]
