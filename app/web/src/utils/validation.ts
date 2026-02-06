import { TradingPair, OrderFormData } from '../types';

/**
 * Validates the amount field
 * @param amount - The amount string to validate
 * @returns Error message if invalid, null if valid
 */
export function validateAmount(amount: string): string | null {
  // Check for empty string
  if (!amount || amount.trim() === '') {
    return 'Amount is required';
  }

  // Convert to number
  const numericAmount = parseFloat(amount);

  // Check for NaN
  if (isNaN(numericAmount)) {
    return 'Amount must be a valid number';
  }

  // Check for negative numbers
  if (numericAmount < 0) {
    return 'Amount cannot be negative';
  }

  // Check for zero
  if (numericAmount === 0) {
    return 'Amount must be greater than 0';
  }

  // Check for extremely large numbers (greater than 1 trillion)
  if (numericAmount > 1e12) {
    return 'Amount is too large';
  }

  // Check for too many decimal places (max 18 for most tokens)
  const decimalPart = amount.split('.')[1];
  if (decimalPart && decimalPart.length > 18) {
    return 'Amount has too many decimal places (max 18)';
  }

  // Check for invalid formats like multiple dots
  if ((amount.match(/\./g) || []).length > 1) {
    return 'Amount format is invalid';
  }

  return null;
}

/**
 * Validates the price field
 * @param price - The price string to validate
 * @returns Error message if invalid, null if valid
 */
export function validatePrice(price: string): string | null {
  // Check for empty string
  if (!price || price.trim() === '') {
    return 'Price is required';
  }

  // Convert to number
  const numericPrice = parseFloat(price);

  // Check for NaN
  if (isNaN(numericPrice)) {
    return 'Price must be a valid number';
  }

  // Check for negative numbers
  if (numericPrice < 0) {
    return 'Price cannot be negative';
  }

  // Check for zero
  if (numericPrice === 0) {
    return 'Price must be greater than 0';
  }

  // Check for extremely large numbers (greater than 1 trillion)
  if (numericPrice > 1e12) {
    return 'Price is too large';
  }

  // Check for too many decimal places (max 18 for precision)
  const decimalPart = price.split('.')[1];
  if (decimalPart && decimalPart.length > 18) {
    return 'Price has too many decimal places (max 18)';
  }

  // Check for invalid formats like multiple dots
  if ((price.match(/\./g) || []).length > 1) {
    return 'Price format is invalid';
  }

  return null;
}

/**
 * Validates the slippage field
 * @param slippage - The slippage number to validate
 * @returns Error message if invalid, null if valid
 */
export function validateSlippage(slippage: number): string | null {
  // Check for NaN
  if (isNaN(slippage)) {
    return 'Slippage must be a valid number';
  }

  // Check for negative numbers
  if (slippage < 0) {
    return 'Slippage cannot be negative';
  }

  // Check for values greater than 100
  if (slippage > 100) {
    return 'Slippage cannot exceed 100%';
  }

  // Warn about unusually high slippage (optional, but helpful)
  if (slippage > 50) {
    return 'Slippage is unusually high (greater than 50%)';
  }

  return null;
}

/**
 * Validates the token pair field
 * @param tokenPair - The trading pair to validate
 * @returns Error message if invalid, null if valid
 */
export function validateTokenPair(tokenPair: TradingPair | null): string | null {
  if (!tokenPair) {
    return 'Please select a trading pair';
  }

  // Additional validation to ensure the token pair has required properties
  if (!tokenPair.baseToken || !tokenPair.quoteToken) {
    return 'Invalid trading pair selected';
  }

  return null;
}

/**
 * Validates the entire order form
 * @param formData - The complete form data to validate
 * @returns Object with field-level errors (empty object if all valid)
 */
export function validateOrderForm(formData: OrderFormData): Record<string, string> {
  const errors: Record<string, string> = {};

  // Validate token pair
  const tokenPairError = validateTokenPair(formData.tokenPair);
  if (tokenPairError) {
    errors.tokenPair = tokenPairError;
  }

  // Validate amount
  const amountError = validateAmount(formData.amount);
  if (amountError) {
    errors.amount = amountError;
  }

  // Validate price
  const priceError = validatePrice(formData.price);
  if (priceError) {
    errors.price = priceError;
  }

  // Validate slippage
  const slippageError = validateSlippage(formData.slippage);
  if (slippageError) {
    errors.slippage = slippageError;
  }

  // Additional cross-field validation
  // For example, check if total value (amount * price) is within reasonable bounds
  if (!amountError && !priceError) {
    const amount = parseFloat(formData.amount);
    const price = parseFloat(formData.price);
    const totalValue = amount * price;

    if (totalValue > 1e15) {
      errors.general = 'Total order value is too large';
    }

    // Check for dust orders (very small values)
    if (totalValue < 0.000001) {
      errors.general = 'Total order value is too small';
    }
  }

  return errors;
}
