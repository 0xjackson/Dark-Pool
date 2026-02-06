import { OrderRequest, OrderResponse } from '@/types/order';
import { ApiError, createApiErrorFromResponse } from '@/utils/errors';

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
