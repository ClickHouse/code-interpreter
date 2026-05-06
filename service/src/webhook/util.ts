import type { IUser } from '@librechat/api-keys';

/**
 * Transforms any string into a valid ACR token name
 * Rules:
 * - Must be 5-50 characters
 * - Can only contain alphanumeric, dash, underscore
 * - Must start with alphanumeric
 * - Cannot end with dash or underscore
 *
 * @param input Any string
 * @returns Valid ACR token name
 */
export const sanitizeTokenName = (input: string): string => {
  // Remove any characters that aren't alphanumeric, dash, or underscore
  let sanitized = input.replace(/[^a-zA-Z0-9\-_]/g, '-');

  // Ensure starts with alphanumeric
  while (sanitized.charAt(0) === '-' || sanitized.charAt(0) === '_') {
    sanitized = sanitized.substring(1);
  }

  // Ensure doesn't end with dash or underscore
  while (sanitized.endsWith('-') || sanitized.endsWith('_')) {
    sanitized = sanitized.slice(0, -1);
  }

  // If too short, pad with 'token-' prefix
  if (sanitized.length < 5) {
    sanitized = `token-${sanitized}`;
  }

  // If still too short (was empty or nearly empty), add timestamp
  if (sanitized.length < 5) {
    sanitized = `token-${Date.now()}`;
  }

  // If too long, truncate to 50 chars but ensure doesn't end with dash/underscore
  if (sanitized.length > 50) {
    sanitized = sanitized.slice(0, 50);
    while (sanitized.endsWith('-') || sanitized.endsWith('_')) {
      sanitized = sanitized.slice(0, -1);
    }
  }

  return sanitized;
};

export function isEnterpriseUser(user: IUser): boolean {
  return user.subscription?.metadata?.enterprise === 'true'
  || (user.enterprisePlans ?? []).some((plan) => user.subscription?.planId === plan);
}