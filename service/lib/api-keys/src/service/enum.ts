export enum KeyErrors {
  /** Invalid API key */
  INVALID_API_KEY = 'INVALID_API_KEY',
}

export enum UserErrors {
  /** Invalid or expired subscription */
  INVALID_SUBSCRIPTION = 'INVALID_SUBSCRIPTION',
  /** Usage limit exceeded */
  USAGE_LIMIT_EXCEEDED = 'USAGE_LIMIT_EXCEEDED',
  /** User not found */
  USER_NOT_FOUND = 'USER_NOT_FOUND',
}

export enum TokenErrors {
  /** Invalid access token */
  INVALID_ACCESS_TOKEN = 'INVALID_ACCESS_TOKEN',
  /** Access token not provided */
  ACCESS_TOKEN_NOT_PROVIDED = 'ACCESS_TOKEN_NOT_PROVIDED',
}

export const ErrorMessages = {
  [KeyErrors.INVALID_API_KEY]: 'Invalid API key',
  [UserErrors.INVALID_SUBSCRIPTION]: 'Invalid or expired subscription',
  [UserErrors.USAGE_LIMIT_EXCEEDED]: 'Usage limit exceeded',
  [UserErrors.USER_NOT_FOUND]: 'User not found',
  [TokenErrors.INVALID_ACCESS_TOKEN]: 'Invalid access token',
  [TokenErrors.ACCESS_TOKEN_NOT_PROVIDED]: 'Access token not provided',
};
