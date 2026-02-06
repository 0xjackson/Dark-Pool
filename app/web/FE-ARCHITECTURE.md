# Dark Pool Frontend Architecture

## Overview

The Dark Pool frontend is built with Next.js 14, featuring a stunning purple-themed UI with animated liquid pool effects and professional wallet connection functionality.

## Technology Stack

### Core Framework
- **Next.js 14** - React framework with App Router
- **React 18** - UI library with hooks and server components
- **TypeScript** - Type safety and developer experience

### Wallet + Contract Integration
- **wagmi v2** - React hooks for Ethereum
  - Type-safe, composable hooks
  - Built-in caching and state management
  - Multi-chain support
  - Key hooks: `useAccount`, `useWalletClient`, `usePublicClient`, `useChainId`
- **viem** - TypeScript Ethereum library
  - Modern replacement for ethers.js
  - Tree-shakeable, performant
  - Used for `keccak256`, `encodeAbiParameters`, `parseUnits`, `maxUint256`
- **RainbowKit v2** - Pre-built wallet UI
  - Support for MetaMask, WalletConnect, Coinbase
  - Beautiful, customizable modals
  - Mobile-optimized with WalletConnect
- **TanStack Query v5** - State management
  - Required by wagmi
  - Handles caching, deduplication, background updates

### Animations
- **Framer Motion v11** - Animation library
  - Declarative API
  - GPU-accelerated transforms
  - SVG path animations
- **CSS Keyframes** - Simple looping animations
  - `liquidFloat` - Blob movement
  - `pulseGlow` - Glow pulsing

### Styling
- **Tailwind CSS v3** - Utility-first CSS
  - Custom purple color palette
  - Responsive design utilities
  - Dark theme optimized

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

## Component Patterns

### Hooks + Presentation Pattern
We follow the hooks + presentation component pattern:

1. **Custom Hooks** - Encapsulate logic
   - `useWalletConnection()` - Abstracts wallet state
   - `useSubmitTrade()` - Handles on-chain approval, commitment, and backend order submission
   - Wagmi hooks (`useAccount`, `usePublicClient`, `useWalletClient`, etc.)

2. **Presentation Components** - Render UI
   - Receive data from hooks
   - Handle user interactions
   - No direct blockchain logic

**Example:**
```typescript
// Hook (logic)
export function useWalletConnection() {
  const { address, isConnected } = useAccount();
  return { address, isConnected, ... };
}

// Component (presentation)
export function WalletButton() {
  const { isConnected } = useWalletConnection();
  return <button>...</button>;
}
```

## Trade Submission Flow

The trade submission flow is entirely on-chain -- there are no EIP-712 signatures involved. The `useSubmitTrade` hook drives the following steps:

### Steps (`TradeSubmitStep`)

```
idle → approving → committing → submitting_order → complete
                                                  → error
```

1. **idle** -- Waiting for user action.
2. **approving** -- Checking the sell-token allowance; if insufficient, prompts an `approve(MaxUint256)` transaction.
3. **committing** -- Calls `depositAndCommit` on the DarkPoolRouter contract to deposit tokens and record the commitment hash on-chain.
4. **submitting_order** -- POSTs the full order details (order ID, commitment hash, amounts, tokens, expiry, etc.) to the backend matching engine via `submitOrder` in `services/api.ts`.
5. **complete** -- Order successfully submitted.

### Data flow diagram
```
User fills order form
        |
        v
Check ERC-20 allowance (publicClient.readContract)
        |
        v  (if allowance < sellAmount)
approve(ROUTER_ADDRESS, MaxUint256)  --  walletClient.writeContract
        |
        v
depositAndCommit(token, amount, orderId, orderHash)  --  walletClient.writeContract
        |
        v
POST /api/orders  --  backend receives order details
        |
        v
Complete
```

### Key implementation details
- Uses `useWalletClient` and `usePublicClient` from wagmi (no `useSignTypedData`).
- The commitment hash is computed client-side with `keccak256(abi.encode(OrderDetails))` using viem helpers.
- Contract ABIs and the router address live in `config/contracts.ts`.

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
- `ROUTER_ADDRESS` -- from `NEXT_PUBLIC_ROUTER_ADDRESS` env var
- `ROUTER_ABI` -- `depositAndCommit`, `commitOnly`, `cancel`, `commitments` (read)
- `ERC20_ABI` -- `allowance` (read), `approve`

## API Client (services/api.ts)

All requests include timeout handling (10s) and structured error handling via `ApiError`.

| Function | Endpoint | Purpose |
|----------|----------|---------|
| `submitOrder` | `POST /api/orders` | Submit order after on-chain commit |
| `fetchUserOrders` | `GET /api/orders/user/:address` | Get user's orders |
| `fetchUserMatches` | `GET /api/orders/matches/user/:address` | Get user's matches |
| `fetchOrderById` | `GET /api/orders/:id` | Get single order |

## State Management Strategy

### Wallet State
- **Managed by:** wagmi + TanStack Query
- **No custom state needed**
- Automatic caching, revalidation, optimistic updates

### Trade Submission State
- **Managed by:** `useSubmitTrade` hook (step, error, loading)

### Modal State
- **Managed by:** `useTradeModal` hook

### Why No Redux/Zustand?
- wagmi handles all wallet state
- No complex app state yet (order book will need this later)
- Keep it simple until needed

### When to Add State Management
Add Zustand when implementing:
- Order book real-time updates
- Trade history caching
- User preferences/settings
- Complex form state

## Animation Strategy

### CSS Keyframes
Used for simple, looping animations:
- `liquidFloat` - Background blob movement
- `pulseGlow` - Glow effect pulsing

**Pros:**
- Performant (GPU-accelerated)
- No JavaScript overhead
- Perfect for infinite loops

### Framer Motion
Used for complex, interactive animations:
- Component entrance/exit
- SVG path animations
- User-triggered animations

**Pros:**
- Declarative API
- Easy orchestration
- Great SVG support

### Performance Considerations
1. **GPU Acceleration**
   - Only animate `transform` and `opacity`
   - Use `will-change` sparingly

2. **Reduced Motion**
   - Respect `prefers-reduced-motion` media query
   - Disable animations for accessibility

3. **Animation Throttling**
   - 60fps target on desktop
   - 30fps acceptable on mobile
   - Reduce blob count on low-end devices

## Styling Guidelines

### Purple Theme
Three color families:

1. **Dark Palette** - Backgrounds
   - `dark-bg`: #0a0014 (deep space purple/black)
   - `dark-surface`: #1a0b2e (dark purple surface)
   - `dark-elevated`: #2d1b4e (elevated cards)

2. **Purple Palette** - Accents
   - `purple-primary`: #7c3aed (vibrant purple)
   - `purple-secondary`: #a78bfa (light purple)
   - `purple-accent`: #c084fc (pink-purple)
   - `purple-glow`: #9333ea (glow effects)

3. **Pool Palette** - Liquids
   - `pool-light`: #e9d5ff (light liquid)
   - `pool-medium`: #c084fc (medium liquid)
   - `pool-dark`: #7c3aed (dark liquid)

### Glass Morphism Pattern
```css
bg-dark-surface/30 backdrop-blur-xl border border-purple-primary/20
```

### Glow Effects
```css
shadow-[0_0_50px_rgba(147,51,234,0.5)]
```

### Responsive Breakpoints
- Mobile: `< 640px` (sm)
- Tablet: `640px - 1024px` (md, lg)
- Desktop: `> 1024px` (xl, 2xl)

## Modals Architecture (Future)

When implementing order forms, trade modals, etc:

### Pattern
1. **State:** Zustand store for modal state
2. **Component:** Framer Motion for animations
3. **Portal:** Render outside main tree
4. **Accessibility:** Focus trap, ESC to close, aria-modal

### Example Structure
```
src/components/modals/
├── OrderFormModal.tsx
├── TradeConfirmModal.tsx
└── SettingsModal.tsx
```

## Hooks Documentation

### useWalletConnection
Abstracts wallet logic into reusable hook.

**Returns:**
```typescript
{
  address: string | undefined;
  isConnected: boolean;
  isConnecting: boolean;
  chainId: number | undefined;
  truncatedAddress: string; // "0x1234...5678"
  disconnect: () => void;
  connect: () => void;
}
```

**Usage:**
```typescript
const { isConnected, address } = useWalletConnection();
```

### useSubmitTrade
Handles the full trade submission lifecycle: token approval, on-chain deposit and commitment, and backend order submission. Uses `useWalletClient` and `usePublicClient` from wagmi for all on-chain interactions.

**Returns:**
```typescript
{
  currentStep: TradeSubmitStep;   // 'idle' | 'approving' | 'committing' | 'submitting_order' | 'complete' | 'error'
  stepMessage: string;            // Human-readable step description
  loading: boolean;               // True while any async step is in progress
  error: string | null;           // Error message if step is 'error'
  success: boolean;               // True when step is 'complete'
  submitTrade: (formData: OrderFormData) => Promise<void>;
  reset: () => void;              // Returns to 'idle' state
}
```

**Usage:**
```typescript
const { submitTrade, currentStep, loading, error, success } = useSubmitTrade();

// On form submit:
await submitTrade({
  tokenPair: { baseToken, quoteToken },
  amount: '100',
  price: '1.5',
  slippage: 0.5,
  orderType: 'buy',
});
```

## Performance Considerations

### Bundle Size
- Tree-shake unused dependencies
- Dynamic imports for heavy components
- Monitor bundle with `@next/bundle-analyzer`

### Runtime Performance
- Memoize expensive calculations
- Use React.memo for stable components
- Lazy load animations on mobile

### Network Requests
- wagmi handles caching automatically
- Use stale-while-revalidate pattern
- Minimize RPC calls

## Security

### Wallet Connection
- Never request private keys (RainbowKit handles this)
- Only read wallet address; all trade actions are explicit on-chain transactions
- No sensitive data in localStorage

### On-Chain Transactions
- Token approvals use `MaxUint256` for a single approval flow; users sign each approval and deposit transaction explicitly in their wallet
- Commitment hashes are computed client-side with `keccak256` and verified on-chain by the DarkPoolRouter contract
- No off-chain signatures (EIP-712 or otherwise) are used in the trade submission flow

### Environment Variables
- Prefix public vars with `NEXT_PUBLIC_`
- Never expose private keys
- WalletConnect project ID is public (safe)
- `NEXT_PUBLIC_ROUTER_ADDRESS` -- DarkPoolRouter contract address (per-chain)

### HTTPS Required
- WalletConnect requires HTTPS in production
- Use Vercel/Netlify for automatic HTTPS

## Accessibility

### Keyboard Navigation
- All interactive elements focusable
- Logical tab order
- Visible focus indicators

### Screen Readers
- Semantic HTML
- ARIA labels on icon buttons
- Announcements for state changes

### Color Contrast
- WCAG AA minimum (4.5:1 for text)
- Purple on dark backgrounds tested
- High contrast mode support

## Future Enhancements

### Short Term
1. ENS name resolution
2. Token balance display
3. Network switching UI
4. Transaction notifications

### Medium Term
1. Order form integration
2. Order book display
3. Trade history
4. Portfolio view

### Long Term
1. Advanced charting
2. Analytics dashboard
3. Mobile app (React Native)
4. Desktop app (Tauri)

## Development Workflow

### Getting Started
```bash
cd app/web
npm install
npm run dev
```

### Building
```bash
npm run build
npm start
```

### Testing
```bash
# Manual testing checklist in TODO.md
# Automated tests: TODO (Jest + React Testing Library)
```

### Linting
```bash
npm run lint
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | Yes | WalletConnect project ID from https://cloud.walletconnect.com/ |
| `NEXT_PUBLIC_DEFAULT_CHAIN_ID` | No | Default chain ID (defaults to 1) |
| `NEXT_PUBLIC_API_URL` | No | Backend API base URL (defaults to http://localhost:3001) |
| `NEXT_PUBLIC_ROUTER_ADDRESS` | Yes | DarkPoolRouter contract address for the target chain |

## Troubleshooting

### Common Issues

1. **"WalletConnect project ID required"**
   - Get free ID at https://cloud.walletconnect.com/
   - Add to `.env.local`

2. **"Animations are janky"**
   - Check FPS in Chrome DevTools
   - Reduce number of GlowOrb components
   - Lower blob count in PoolBackground

3. **"Wallet not connecting"**
   - Check browser extension installed
   - Verify network configuration
   - Clear browser cache

## Contributing

### Code Style
- Use TypeScript for type safety
- Follow existing component patterns
- Comment complex logic
- Keep components focused (single responsibility)

### Git Workflow
- Feature branches from `main`
- Descriptive commit messages
- Test before pushing

### Documentation
- Update TODO.md when adding features
- Update this file for architectural changes
- Add JSDoc comments to hooks/utils

## Docker Deployment

### Prerequisites
1. Get a free WalletConnect project ID from https://cloud.walletconnect.com/
2. Create a `.env` file at the project root (copy from `.env.example`)
3. Set `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` in the `.env` file
4. Set `NEXT_PUBLIC_ROUTER_ADDRESS` in the `.env` file

### Building with Docker Compose
```bash
# From project root
docker-compose build frontend

# Or build and run all services
docker-compose up --build
```

### Building Frontend Container Directly
```bash
# From app/web directory
docker build \
  --build-arg NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=your_project_id \
  --build-arg NEXT_PUBLIC_DEFAULT_CHAIN_ID=1 \
  --build-arg NEXT_PUBLIC_ROUTER_ADDRESS=0xYourRouterAddress \
  -t darkpool-frontend .
```

### Important Notes
- `NEXT_PUBLIC_*` environment variables are inlined at build time
- You must provide the WalletConnect project ID during build
- You must provide the router contract address during build
- Rebuilding is required if you change the project ID or router address
- The Dockerfile uses multi-stage builds for optimized image size

## Resources

- [wagmi Documentation](https://wagmi.sh/)
- [RainbowKit Documentation](https://www.rainbowkit.com/)
- [Framer Motion Documentation](https://www.framer.com/motion/)
- [Next.js Documentation](https://nextjs.org/docs)
- [Tailwind CSS Documentation](https://tailwindcss.com/docs)
