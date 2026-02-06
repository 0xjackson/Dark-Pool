# Dark Pool Frontend Architecture

## Overview

The Dark Pool frontend is built with Next.js 14, featuring a purple-themed UI with animated liquid pool effects. Users connect their wallet, place orders (which commit on-chain), and view order/match history.

## Technology Stack

### Core Framework
- **Next.js 14** - React framework with App Router
- **React 18** - UI library with hooks
- **TypeScript** - Type safety

### Wallet + Contract Integration
- **wagmi v2** - React hooks for Ethereum (useAccount, useWalletClient, usePublicClient)
- **viem** - TypeScript Ethereum library (keccak256, encodeAbiParameters, parseUnits)
- **RainbowKit v2** - Pre-built wallet UI (MetaMask, WalletConnect, Coinbase)
- **TanStack Query v5** - State management (required by wagmi)

### Animations
- **Framer Motion v11** - Component animations, SVG path animations
- **CSS Keyframes** - `liquidFloat` (blob movement), `pulseGlow` (glow pulsing)

### Styling
- **Tailwind CSS v3** - Utility-first CSS with custom purple palette

## Folder Structure

```
src/
├── app/
│   ├── layout.tsx              # Root layout with providers
│   ├── page.tsx                # Home page
│   └── globals.css             # Global styles and animations
│
├── components/
│   ├── trading/
│   │   ├── OrderForm.tsx       # Order creation form
│   │   ├── TradeModal.tsx      # Trade confirmation modal
│   │   ├── OrderCard.tsx       # Single order display
│   │   ├── MatchCard.tsx       # Single match display
│   │   ├── OrdersDrawer.tsx    # Orders/matches side panel
│   │   ├── OrdersDrawerToggle.tsx
│   │   ├── OrderTypeToggle.tsx # BUY/SELL toggle
│   │   ├── SlippageInput.tsx   # Slippage tolerance input
│   │   └── TokenPairSelector.tsx
│   │
│   ├── wallet/
│   │   ├── ConnectWallet.tsx   # Disconnected state UI
│   │   └── WalletButton.tsx    # Connected state UI
│   │
│   ├── animations/
│   │   ├── PoolBackground.tsx  # Liquid background blobs
│   │   └── GlowOrb.tsx        # Floating purple orbs
│   │
│   └── ui/
│       ├── Logo.tsx            # Dark Pool logo
│       ├── Container.tsx       # Layout container
│       └── Modal.tsx           # Reusable modal wrapper
│
├── hooks/
│   ├── useSubmitTrade.ts       # Core trade flow: approve → commit → submit
│   ├── useTradeModal.ts        # Trade modal state management
│   ├── useUserOrders.ts        # Fetch user's orders from API
│   ├── useUserMatches.ts       # Fetch user's matches from API
│   └── useWalletConnection.ts  # Wallet state abstraction
│
├── config/
│   ├── chains.ts               # Supported chains config
│   ├── contracts.ts            # Router address, Router ABI, ERC20 ABI
│   ├── tokens.ts               # Token list and pairs
│   └── wagmi.ts                # Wagmi/RainbowKit config
│
├── services/
│   └── api.ts                  # API client (submitOrder, fetchUserOrders, fetchUserMatches)
│
├── types/
│   ├── order.ts                # OrderRequest, Order, Match, TradeSubmitStep
│   ├── trading.ts              # OrderFormData, TokenPair
│   └── wallet.ts               # Wallet types
│
└── utils/
    ├── errors.ts               # ApiError class
    ├── tokens.ts               # Token utilities
    └── validation.ts           # Form validation
```

## Core Hook: useSubmitTrade

The main trade submission hook handles the entire flow without EIP-712 signatures:

```
idle → approving → committing → submitting_order → complete
                                                  → error
```

**Steps:**
1. **approving** — Check ERC20 allowance, call `approve(router, MaxUint256)` if needed (first time only)
2. **committing** — Call `depositAndCommit(token, amount, orderId, orderHash)` on DarkPoolRouter
3. **submitting_order** — POST order details to backend API

**Order hash computation** (must match contract's `keccak256(abi.encode(OrderDetails))`):
```typescript
const orderHash = keccak256(
  encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' },
     { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
    [orderId, userAddress, sellToken, buyToken, sellAmount, minBuyAmount, expiresAt]
  )
);
```

## Contract Config (config/contracts.ts)

Contains minimal ABIs for frontend contract interaction:
- `ROUTER_ADDRESS` — from `NEXT_PUBLIC_ROUTER_ADDRESS` env var
- `ROUTER_ABI` — `depositAndCommit`, `commitOnly`, `cancel`, `commitments` (read)
- `ERC20_ABI` — `allowance` (read), `approve`

## API Client (services/api.ts)

All requests include timeout handling (10s) and structured error handling via `ApiError`.

| Function | Endpoint | Purpose |
|----------|----------|---------|
| `submitOrder` | `POST /api/orders` | Submit order after on-chain commit |
| `fetchUserOrders` | `GET /api/orders/user/:address` | Get user's orders |
| `fetchUserMatches` | `GET /api/orders/matches/user/:address` | Get user's matches |
| `fetchOrderById` | `GET /api/orders/:id` | Get single order |

## State Management

- **Wallet state** — managed by wagmi + TanStack Query
- **Trade submission state** — managed by `useSubmitTrade` hook (step, error, loading)
- **Modal state** — managed by `useTradeModal` hook
- **No Redux/Zustand** — not needed yet. Add when implementing real-time order book updates.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `NEXT_PUBLIC_API_URL` | Backend API URL (default: `http://localhost:3001`) |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | WalletConnect project ID |
| `NEXT_PUBLIC_DEFAULT_CHAIN_ID` | Default chain (default: `1`) |
| `NEXT_PUBLIC_ROUTER_ADDRESS` | DarkPoolRouter contract address |

## Development

```bash
cd app/web
npm install
npm run dev       # http://localhost:3000
npm run build
npm run lint
```

## Docker

```bash
# From project root
docker-compose up frontend

# Or build directly
docker build --build-arg NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=your_id -t darkpool-frontend app/web
```

Note: `NEXT_PUBLIC_*` variables are inlined at build time — rebuild required if changed.
