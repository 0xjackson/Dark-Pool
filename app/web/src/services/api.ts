import { OrderRequest, OrderResponse, Order, Match, OrderStatus } from '@/types/order';
import { ApiError, createApiErrorFromResponse } from '@/utils/errors';

/** Response from POST /api/session-key/create */
export interface SessionKeyCreateResponse {
  active: boolean;
  sessionKeyAddress: string;
  expiresAt?: string;
  challengeRaw?: string;
  eip712?: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  };
}

/** Response from POST /api/session-key/activate */
export interface SessionKeyActivateResponse {
  success: boolean;
  expiresAt: string;
}

/**
 * Get the API base URL from environment variable
 * Defaults to http://localhost:3001 for local development
 */
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

/**
 * Default timeout for API requests (10 seconds)
 */
const DEFAULT_TIMEOUT = 10000;

/**
 * Custom timeout error class
 */
class TimeoutError extends Error {
  constructor(message: string = 'Request timed out') {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Creates a fetch request with timeout support
 * @param url - The URL to fetch
 * @param options - Fetch options
 * @param timeout - Timeout in milliseconds
 * @returns Promise that resolves to the Response or rejects with timeout
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeout: number = DEFAULT_TIMEOUT
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);

    // Check if the error is due to abort (timeout)
    if (error instanceof Error && error.name === 'AbortError') {
      throw new TimeoutError(`Request timed out after ${timeout}ms`);
    }

    throw error;
  }
}

/**
 * Submits an order to the dark pool
 * @param orderRequest - The order details to submit
 * @returns Promise resolving to the order response
 * @throws ApiError on failure
 */
export async function submitOrder(orderRequest: OrderRequest): Promise<OrderResponse> {
  const url = `${API_BASE_URL}/api/orders`;

  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(orderRequest),
      },
      DEFAULT_TIMEOUT
    );

    // Handle non-2xx responses
    if (!response.ok) {
      throw await createApiErrorFromResponse(response, 'Failed to submit order');
    }

    // Parse successful response
    const data: OrderResponse = await response.json();
    return data;
  } catch (error) {
    // Re-throw ApiError instances as-is
    if (error instanceof ApiError) {
      throw error;
    }

    // Convert TimeoutError to ApiError
    if (error instanceof TimeoutError) {
      throw new ApiError(error.message, 408, { type: 'timeout' });
    }

    // Handle network errors and other fetch failures
    if (error instanceof TypeError || error instanceof Error) {
      throw new ApiError(
        error.message || 'Network request failed',
        0,
        { type: 'network', originalError: error.message }
      );
    }

    // Fallback for unknown errors
    throw new ApiError('An unexpected error occurred while submitting the order', 500, {
      type: 'unknown',
      error: String(error),
    });
  }
}

/**
 * Fetches orders for a specific user address
 * @param address - User's wallet address
 * @param status - Optional filter by order status
 * @param limit - Maximum number of orders to return (default: 50)
 * @param offset - Pagination offset (default: 0)
 * @returns Promise resolving to array of orders
 * @throws ApiError on failure
 */
export async function fetchUserOrders(
  address: string,
  status?: OrderStatus,
  limit: number = 50,
  offset: number = 0
): Promise<Order[]> {
  const params = new URLSearchParams({
    limit: limit.toString(),
    offset: offset.toString(),
  });

  if (status) {
    params.append('status', status);
  }

  const url = `${API_BASE_URL}/api/orders/user/${address}?${params.toString()}`;

  try {
    const response = await fetchWithTimeout(url, { method: 'GET' }, DEFAULT_TIMEOUT);

    if (!response.ok) {
      throw await createApiErrorFromResponse(response, 'Failed to fetch user orders');
    }

    const data = await response.json();
    return data.orders || [];
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    if (error instanceof TimeoutError) {
      throw new ApiError(error.message, 408, { type: 'timeout' });
    }

    if (error instanceof TypeError || error instanceof Error) {
      throw new ApiError(
        error.message || 'Network request failed',
        0,
        { type: 'network', originalError: error.message }
      );
    }

    throw new ApiError('An unexpected error occurred while fetching orders', 500, {
      type: 'unknown',
      error: String(error),
    });
  }
}

/**
 * Fetches matches for a specific user address
 * @param address - User's wallet address
 * @param limit - Maximum number of matches to return (default: 50)
 * @param offset - Pagination offset (default: 0)
 * @returns Promise resolving to array of matches
 * @throws ApiError on failure
 */
export async function fetchUserMatches(
  address: string,
  limit: number = 50,
  offset: number = 0
): Promise<Match[]> {
  const params = new URLSearchParams({
    limit: limit.toString(),
    offset: offset.toString(),
  });

  const url = `${API_BASE_URL}/api/orders/matches/user/${address}?${params.toString()}`;

  try {
    const response = await fetchWithTimeout(url, { method: 'GET' }, DEFAULT_TIMEOUT);

    if (!response.ok) {
      throw await createApiErrorFromResponse(response, 'Failed to fetch user matches');
    }

    const data = await response.json();
    return data.matches || [];
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    if (error instanceof TimeoutError) {
      throw new ApiError(error.message, 408, { type: 'timeout' });
    }

    if (error instanceof TypeError || error instanceof Error) {
      throw new ApiError(
        error.message || 'Network request failed',
        0,
        { type: 'network', originalError: error.message }
      );
    }

    throw new ApiError('An unexpected error occurred while fetching matches', 500, {
      type: 'unknown',
      error: String(error),
    });
  }
}

/**
 * Fetches a single order by ID
 * @param orderId - The order ID
 * @returns Promise resolving to the order
 * @throws ApiError on failure
 */
export async function fetchOrderById(orderId: string): Promise<Order> {
  const url = `${API_BASE_URL}/api/orders/${orderId}`;

  try {
    const response = await fetchWithTimeout(url, { method: 'GET' }, DEFAULT_TIMEOUT);

    if (!response.ok) {
      throw await createApiErrorFromResponse(response, 'Failed to fetch order');
    }

    const data = await response.json();
    return data.order;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    if (error instanceof TimeoutError) {
      throw new ApiError(error.message, 408, { type: 'timeout' });
    }

    if (error instanceof TypeError || error instanceof Error) {
      throw new ApiError(
        error.message || 'Network request failed',
        0,
        { type: 'network', originalError: error.message }
      );
    }

    throw new ApiError('An unexpected error occurred while fetching order', 500, {
      type: 'unknown',
      error: String(error),
    });
  }
}

/**
 * Creates (or retrieves existing) session key for a user
 * @param userAddress - User's wallet address
 * @returns Session key creation response with EIP-712 data if signing is needed
 * @throws ApiError on failure
 */
export async function createSessionKey(userAddress: string): Promise<SessionKeyCreateResponse> {
  const url = `${API_BASE_URL}/api/session-key/create`;

  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ userAddress }),
      },
      DEFAULT_TIMEOUT
    );

    if (!response.ok) {
      throw await createApiErrorFromResponse(response, 'Failed to create session key');
    }

    const data: SessionKeyCreateResponse = await response.json();
    return data;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    if (error instanceof TimeoutError) {
      throw new ApiError(error.message, 408, { type: 'timeout' });
    }

    if (error instanceof TypeError || error instanceof Error) {
      throw new ApiError(
        error.message || 'Network request failed',
        0,
        { type: 'network', originalError: error.message }
      );
    }

    throw new ApiError('An unexpected error occurred while creating session key', 500, {
      type: 'unknown',
      error: String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// Channel management API
// ---------------------------------------------------------------------------

export interface ChannelInfo {
  channelId: string;
  channel: {
    participants: string[];
    adjudicator: string;
    challenge: number;
    nonce: number;
  };
  state: {
    intent: number;
    version: number;
    stateData: string;
    allocations: Array<{
      destination: string;
      token: string;
      amount: string;
    }>;
  };
  serverSignature: string;
}

export interface LedgerBalance {
  asset: string;
  amount: string;
}

export interface ChannelRecord {
  channelId: string;
  status: string;
  token: string;
  amount: string;
  chainId: number;
}

/**
 * Request channel creation from the clearnode via backend
 */
export async function requestCreateChannel(
  userAddress: string,
  token: string,
  chainId?: number,
): Promise<ChannelInfo> {
  const url = `${API_BASE_URL}/api/channel/create`;
  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userAddress, token, chainId }),
    },
    DEFAULT_TIMEOUT,
  );
  if (!response.ok) throw await createApiErrorFromResponse(response, 'Failed to create channel');
  return response.json();
}

/**
 * Request channel resize from the clearnode via backend
 */
export async function requestResizeChannel(
  userAddress: string,
  channelId: string,
  resizeAmount: string,
  allocateAmount: string,
): Promise<ChannelInfo> {
  const url = `${API_BASE_URL}/api/channel/resize`;
  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userAddress, channelId, resizeAmount, allocateAmount }),
    },
    DEFAULT_TIMEOUT,
  );
  if (!response.ok) throw await createApiErrorFromResponse(response, 'Failed to resize channel');
  return response.json();
}

/**
 * Get unified (ledger) balances for a user from the clearnode
 */
export async function getLedgerBalances(userAddress: string): Promise<LedgerBalance[]> {
  const url = `${API_BASE_URL}/api/channel/balances?address=${encodeURIComponent(userAddress)}`;
  const response = await fetchWithTimeout(url, { method: 'GET' }, DEFAULT_TIMEOUT);
  if (!response.ok) throw await createApiErrorFromResponse(response, 'Failed to get balances');
  const data = await response.json();
  return data.balances || [];
}

/**
 * Get user's Yellow Network channels
 */
export async function getChannels(userAddress: string): Promise<ChannelRecord[]> {
  const url = `${API_BASE_URL}/api/channel/list?address=${encodeURIComponent(userAddress)}`;
  const response = await fetchWithTimeout(url, { method: 'GET' }, DEFAULT_TIMEOUT);
  if (!response.ok) throw await createApiErrorFromResponse(response, 'Failed to list channels');
  const data = await response.json();
  return data.channels || [];
}

/**
 * Activates a session key after user signs the EIP-712 challenge
 * @param userAddress - User's wallet address
 * @param signature - The EIP-712 signature from the wallet
 * @param challengeRaw - The raw challenge string from /create
 * @returns Activation response with expiration
 * @throws ApiError on failure
 */
export async function activateSessionKey(
  userAddress: string,
  signature: string,
  challengeRaw: string
): Promise<SessionKeyActivateResponse> {
  const url = `${API_BASE_URL}/api/session-key/activate`;

  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ userAddress, signature, challengeRaw }),
      },
      DEFAULT_TIMEOUT
    );

    if (!response.ok) {
      throw await createApiErrorFromResponse(response, 'Failed to activate session key');
    }

    const data: SessionKeyActivateResponse = await response.json();
    return data;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    if (error instanceof TimeoutError) {
      throw new ApiError(error.message, 408, { type: 'timeout' });
    }

    if (error instanceof TypeError || error instanceof Error) {
      throw new ApiError(
        error.message || 'Network request failed',
        0,
        { type: 'network', originalError: error.message }
      );
    }

    throw new ApiError('An unexpected error occurred while activating session key', 500, {
      type: 'unknown',
      error: String(error),
    });
  }
}
