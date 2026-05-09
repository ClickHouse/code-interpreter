import { describe, expect, test } from 'bun:test';
import { AuthProviderConfigError } from './provider';
import { validateStartupAuthConfig } from './startup';

describe('validateStartupAuthConfig', () => {
  test('validates JWT verifier config without legacy auth config in JWT-only mode', async () => {
    let jwtConfigValidated = false;
    let legacyTokenValidated = false;

    await validateStartupAuthConfig({
      mode: 'librechat-jwt',
      isLocalMode: false,
      mongodbUri: null,
      sandboxAccessToken: null,
      validateJwtVerifierConfig: () => {
        jwtConfigValidated = true;
      },
      validateRemoteToken: async () => {
        legacyTokenValidated = true;
        return 'legacy-user';
      },
      setAccessUser: async () => undefined,
    });

    expect(jwtConfigValidated).toBe(true);
    expect(legacyTokenValidated).toBe(false);
  });

  test('validates both JWT and legacy auth config in cutover mode', async () => {
    let jwtConfigValidated = false;
    let accessUser = '';

    await validateStartupAuthConfig({
      mode: 'both',
      isLocalMode: false,
      mongodbUri: null,
      sandboxAccessToken: 'sandbox-token',
      validateJwtVerifierConfig: () => {
        jwtConfigValidated = true;
      },
      validateRemoteToken: async (token) => `validated-${token}`,
      setAccessUser: async (userId) => {
        accessUser = userId;
      },
    });

    expect(jwtConfigValidated).toBe(true);
    expect(accessUser).toBe('validated-sandbox-token');
  });

  test('preserves legacy auth config requirement for legacy API-key mode', async () => {
    await expect(
      validateStartupAuthConfig({
        mode: 'legacy-api-key',
        isLocalMode: false,
        mongodbUri: null,
        sandboxAccessToken: null,
      }),
    ).rejects.toThrow('Unauthenticated access');
  });

  test('rejects empty legacy auth config values in cutover mode', async () => {
    let legacyTokenValidated = false;

    await expect(
      validateStartupAuthConfig({
        mode: 'both',
        isLocalMode: false,
        mongodbUri: '',
        sandboxAccessToken: '   ',
        validateJwtVerifierConfig: () => undefined,
        validateRemoteToken: async () => {
          legacyTokenValidated = true;
          return 'legacy-user';
        },
        setAccessUser: async () => undefined,
      }),
    ).rejects.toThrow('Unauthenticated access');

    expect(legacyTokenValidated).toBe(false);
  });

  test('fails closed when auth provider none is not explicitly allowed', async () => {
    await expect(
      validateStartupAuthConfig({
        mode: 'none',
        isLocalMode: false,
        allowNone: false,
      }),
    ).rejects.toBeInstanceOf(AuthProviderConfigError);
  });
});
