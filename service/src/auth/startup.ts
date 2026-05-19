import { env } from '../config';
import logger from '../logger';
import { validateLibreChatJwtVerifierConfig } from './librechat-jwt';
import { AuthProviderConfigError, getAuthProviderMode } from './provider';
import { validateSyntheticAccessTokenConfig } from './synthetic';
import type { CodeApiAuthProviderMode } from './provider';

type StartupAuthOptions = {
  mode?: CodeApiAuthProviderMode;
  isLocalMode?: boolean;
  allowNone?: boolean;
  mongodbUri?: string | null;
  sandboxAccessToken?: string | null;
  setAccessUser?: (userId: string) => Promise<void>;
  validateJwtVerifierConfig?: () => void;
  validateRemoteToken?: (token: string) => Promise<string>;
};

function getNonEmptyConfigValue(value: string | null | undefined): string | null {
  if (value == null) {
    return null;
  }

  const trimmedValue = value.trim();
  return trimmedValue.length > 0 ? trimmedValue : null;
}

async function validateLegacyStartupAuth(options: StartupAuthOptions): Promise<void> {
  const mongodbUri = getNonEmptyConfigValue(
    'mongodbUri' in options ? options.mongodbUri : process.env.MONGODB_URI,
  );
  if (mongodbUri !== null) {
    logger.info('Connected to database');
    return;
  }

  const sandboxAccessToken = getNonEmptyConfigValue(
    'sandboxAccessToken' in options
      ? options.sandboxAccessToken
      : process.env.SANDBOX_ACCESS_TOKEN,
  );
  if (sandboxAccessToken !== null) {
    if (!options.validateRemoteToken || !options.setAccessUser) {
      throw new Error('Sandbox access token validation is not configured');
    }
    logger.info('Validating sandbox access token...');
    const accessUserId = await options.validateRemoteToken(sandboxAccessToken);
    await options.setAccessUser(accessUserId);
    logger.info('Sandbox access token validated');
    return;
  }

  logger.error('Unauthenticated access. Did you provide `SANDBOX_ACCESS_TOKEN`?');
  throw new Error('Unauthenticated access');
}

export async function validateStartupAuthConfig(
  options: StartupAuthOptions = {},
): Promise<void> {
  const mode = options.mode ?? getAuthProviderMode();
  const isLocalMode = options.isLocalMode ?? env.LOCAL_MODE;

  validateSyntheticAccessTokenConfig();

  if (isLocalMode) {
    logger.info('LOCAL MODE - Authentication bypassed');
    await options.setAccessUser?.('local-test-user');
    return;
  }

  if (mode === 'none') {
    const allowNone =
      options.allowNone ?? process.env.CODEAPI_ALLOW_AUTH_PROVIDER_NONE === 'true';
    if (!allowNone) {
      throw new AuthProviderConfigError(
        'CODEAPI_AUTH_PROVIDER=none is only allowed in local mode',
      );
    }
    logger.warn('CODEAPI_AUTH_PROVIDER=none - authentication bypassed');
    return;
  }

  if (mode === 'librechat-jwt' || mode === 'both') {
    const validateJwtVerifierConfig =
      options.validateJwtVerifierConfig ?? validateLibreChatJwtVerifierConfig;
    validateJwtVerifierConfig();
    logger.info('CodeAPI LibreChat JWT verifier configuration validated');
    if (mode === 'librechat-jwt') {
      return;
    }
  }

  await validateLegacyStartupAuth(options);
}
