/**
 * Custom API Error class with additional context
 */
export class ApiError extends Error {
  statusCode: number;
  details?: Record<string, unknown>;

  constructor(message: string, statusCode: number, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.details = details;

    // Maintains proper stack trace for where error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ApiError);
    }
  }
}

/**
 * Parses API errors and returns user-friendly error messages
 * @param error - The error object to parse
 * @returns A user-friendly error message
 */
export function parseApiError(error: unknown): string {
  // Handle ApiError instances
  if (error instanceof ApiError) {
    switch (error.statusCode) {
      case 400:
        return error.details?.message
          ? `Validation error: ${error.details.message}`
          : 'Invalid request. Please check your input and try again.';

      case 401:
        return 'You are not authenticated. Please connect your wallet and try again.';

      case 403:
        return 'You do not have permission to perform this action.';

      case 404:
        return 'The requested resource was not found. It may have been removed or is temporarily unavailable.';

      case 408:
        return 'Request timeout. The server took too long to respond. Please try again.';

      case 429:
        return 'Too many requests. Please wait a moment and try again.';

      case 500:
        return 'An internal server error occurred. Please try again later.';

      case 502:
        return 'Bad gateway. The server is temporarily unavailable. Please try again later.';

      case 503:
        return 'Service temporarily unavailable. Please try again in a few moments.';

      case 504:
        return 'Gateway timeout. The server took too long to respond. Please try again.';

      default:
        if (error.statusCode >= 400 && error.statusCode < 500) {
          return error.message || 'An error occurred while processing your request.';
        }
        if (error.statusCode >= 500) {
          return 'A server error occurred. Please try again later.';
        }
        return error.message || 'An unexpected error occurred.';
    }
  }

  // Handle network errors
  if (isNetworkError(error)) {
    return 'Network connection failed. Please check your internet connection and try again.';
  }

  // Handle timeout errors
  if (error instanceof Error && error.name === 'TimeoutError') {
    return 'Request timed out. Please try again.';
  }

  // Handle abort errors
  if (error instanceof Error && error.name === 'AbortError') {
    return 'Request was cancelled. Please try again.';
  }

  // Handle standard Error objects
  if (error instanceof Error) {
    return error.message;
  }

  // Handle string errors
  if (typeof error === 'string') {
    return error;
  }

  // Fallback for unknown error types
  return 'An unexpected error occurred. Please try again.';
}

/**
 * Detects if an error is related to network connectivity
 * @param error - The error to check
 * @returns True if the error is a network error
 */
export function isNetworkError(error: unknown): boolean {
  // Check for common network error patterns
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    const name = error.name.toLowerCase();

    // Common network error messages
    const networkErrorPatterns = [
      'network',
      'fetch',
      'connection',
      'timeout',
      'econnrefused',
      'enotfound',
      'enetunreach',
      'etimedout',
      'failed to fetch',
      'networkerror',
      'net::err',
    ];

    return (
      networkErrorPatterns.some(pattern => message.includes(pattern)) ||
      networkErrorPatterns.some(pattern => name.includes(pattern))
    );
  }

  // Check for TypeError (common when fetch fails)
  if (error instanceof TypeError) {
    return true;
  }

  // Check for DOMException with network-related names
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'NetworkError' || error.name === 'NotConnectedError';
  }

  return false;
}

/**
 * Extracts a generic error message from any error type
 * @param error - The error to extract a message from
 * @returns A string error message
 */
export function getErrorMessage(error: unknown): string {
  // Handle null or undefined
  if (error == null) {
    return 'An unknown error occurred.';
  }

  // Handle ApiError
  if (error instanceof ApiError) {
    return error.message;
  }

  // Handle Error objects
  if (error instanceof Error) {
    return error.message;
  }

  // Handle string errors
  if (typeof error === 'string') {
    return error;
  }

  // Handle objects with message property
  if (
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message;
  }

  // Handle objects with error property
  if (
    typeof error === 'object' &&
    'error' in error &&
    typeof error.error === 'string'
  ) {
    return error.error;
  }

  // Try to stringify the error
  try {
    const stringified = JSON.stringify(error);
    if (stringified !== '{}') {
      return stringified;
    }
  } catch {
    // JSON.stringify failed, continue to fallback
  }

  // Fallback
  return 'An unknown error occurred.';
}

/**
 * Checks if an error is an API error with a specific status code
 * @param error - The error to check
 * @param statusCode - The status code to match
 * @returns True if the error is an ApiError with the specified status code
 */
export function isApiErrorWithStatus(error: unknown, statusCode: number): boolean {
  return error instanceof ApiError && error.statusCode === statusCode;
}

/**
 * Creates an ApiError from a fetch Response
 * @param response - The fetch Response object
 * @param fallbackMessage - Optional fallback message if response body cannot be parsed
 * @returns A Promise that resolves to an ApiError
 */
export async function createApiErrorFromResponse(
  response: Response,
  fallbackMessage?: string
): Promise<ApiError> {
  let message = fallbackMessage || `HTTP ${response.status}: ${response.statusText}`;
  let details: Record<string, unknown> | undefined;

  try {
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      message = data.message || data.error || message;
      details = data;
    } else {
      const text = await response.text();
      if (text) {
        message = text;
      }
    }
  } catch {
    // Failed to parse response body, use fallback message
  }

  return new ApiError(message, response.status, details);
}

/**
 * Type guard to check if an error is an Error instance
 * @param error - The value to check
 * @returns True if the value is an Error instance
 */
export function isError(error: unknown): error is Error {
  return error instanceof Error;
}

/**
 * Type guard to check if an error is an ApiError instance
 * @param error - The value to check
 * @returns True if the value is an ApiError instance
 */
export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/**
 * Logs an error with context information
 * @param error - The error to log
 * @param context - Additional context about where/why the error occurred
 */
export function logError(error: unknown, context?: string): void {
  const prefix = context ? `[${context}]` : '[Error]';

  if (error instanceof ApiError) {
    console.error(prefix, 'ApiError:', {
      message: error.message,
      statusCode: error.statusCode,
      details: error.details,
      stack: error.stack,
    });
  } else if (error instanceof Error) {
    console.error(prefix, `${error.name}:`, {
      message: error.message,
      stack: error.stack,
    });
  } else {
    console.error(prefix, 'Unknown error:', error);
  }
}
