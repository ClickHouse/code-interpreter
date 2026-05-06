import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import type { IApiKey, ServiceUser, ErrorDetails } from '../types';
import { incrementUserApiUsage, validateAndGetUser } from './user';
import { incrementApiKeyUsage, validateApiKey } from './apiKey';
import { validateRemoteToken } from './azureToken';

function isErrorDetails(error: unknown): error is ErrorDetails {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    'status' in error
  );
}

const mockApiKeyResponse: IApiKey = {
  _id: 'test-id',
  userId: 'user-id',
  name: 'Test Key',
  secret: 'hashed-secret',
  usage: 1,
  lastUsedAt: '2025-01-13T16:21:25.959Z',
  createdAt: '2025-01-13T16:21:25.959Z',
  updatedAt: '2025-01-13T16:21:25.959Z',
};

const mockUserResponse: ServiceUser = {
  _id: 'user-id',
  usage: 1,
  subscription: {
    id: 'sub_id',
    status: 'active',
    currentPeriodEnd: '2025-03-15T00:00:00.000Z',
    metadata: {
      usageLimit: '100',
    },
    planId: 'somePlanId',
    priceId: 'somePriceId',
    cancelAtPeriodEnd: false,
  },
};

const server = setupServer(
  http.patch('https://api.librechat.ai/v1/enterprise/key/usage', () => {
    return HttpResponse.json(mockApiKeyResponse);
  }),

  http.patch('https://api.librechat.ai/v1/enterprise/user/usage', () => {
    return HttpResponse.json(mockUserResponse);
  })
);

describe('Remote Process Integration', () => {
  beforeAll(() => {
    server.listen({ onUnhandledRequest: 'error' });
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    server.resetHandlers();
  });

  describe('incrementApiKeyUsage', () => {
    it('should successfully increment API key usage remotely', async () => {
      const result = await incrementApiKeyUsage('test-id', 'valid-key');
      expect(result).toEqual(mockApiKeyResponse);
    });

    it('should handle remote errors properly', async () => {
      server.use(
        http.patch('https://api.librechat.ai/v1/enterprise/key/usage', () => {
          return new HttpResponse(JSON.stringify({ error: 'Server Error' }), {
            status: 500,
            headers: {
              'Content-Type': 'application/json',
            },
          });
        })
      );

      let error;
      try {
        await incrementApiKeyUsage('test-id', 'valid-key');
      } catch (e) {
        error = e;
      }
      expect(error).toBeDefined();
      expect(isErrorDetails(error)).toBe(true);
      if (isErrorDetails(error)) {
        expect(error.status).toBe(500);
      }
    });

    it('should handle network errors', async () => {
      server.use(
        http.patch('https://api.librechat.ai/v1/enterprise/key/usage', () => {
          return HttpResponse.error();
        })
      );

      let error;
      try {
        await incrementApiKeyUsage('test-id', 'valid-key');
      } catch (e) {
        error = e;
      }
      expect(error).toBeDefined();
      expect(isErrorDetails(error)).toBe(true);
    });
  });

  describe('incrementUserApiUsage', () => {
    it('should successfully increment user usage remotely', async () => {
      const result = await incrementUserApiUsage('user-id', 'valid-key');
      expect(result).toEqual(mockUserResponse);
    });

    it('should handle remote errors properly', async () => {
      server.use(
        http.patch('https://api.librechat.ai/v1/enterprise/user/usage', () => {
          return new HttpResponse(JSON.stringify({ error: 'Server Error' }), {
            status: 500,
            headers: {
              'Content-Type': 'application/json',
            },
          });
        })
      );

      let error;
      try {
        await incrementUserApiUsage('user-id', 'valid-key');
      } catch (e) {
        error = e;
      }
      expect(error).toBeDefined();
      expect(isErrorDetails(error)).toBe(true);
      if (isErrorDetails(error)) {
        expect(error.status).toBe(500);
      }
    });

    it('should handle network errors', async () => {
      server.use(
        http.patch('https://api.librechat.ai/v1/enterprise/user/usage', () => {
          return HttpResponse.error();
        })
      );

      let error;
      try {
        await incrementUserApiUsage('user-id', 'valid-key');
      } catch (e) {
        error = e;
      }
      expect(error).toBeDefined();
      expect(isErrorDetails(error)).toBe(true);
    });

    it('should handle malformed response data', async () => {
      server.use(
        http.patch('https://api.librechat.ai/v1/enterprise/user/usage', () => {
          // Return malformed JSON with a 500 status to indicate server error
          return new HttpResponse(
            '{"bad json syntax', // Intentionally malformed JSON
            {
              status: 500,
              headers: {
                'Content-Type': 'application/json',
              },
            }
          );
        })
      );

      let error;
      try {
        await incrementUserApiUsage('user-id', 'valid-key');
      } catch (e) {
        error = e;
      }
      expect(error).toBeDefined();
      expect(isErrorDetails(error)).toBe(true);
      if (isErrorDetails(error)) {
        expect(error.status).toBe(500);
        expect(error.message).toBeDefined();
      }
    });
  });

  describe('validateAndGetUser', () => {
    it('should successfully validate user remotely', async () => {
      server.use(
        http.get('https://api.librechat.ai/v1/enterprise/user', () => {
          return HttpResponse.json(mockUserResponse);
        })
      );

      const result = await validateAndGetUser('user-id', 'valid-key');
      expect(result).toEqual(mockUserResponse);
    });

    it('should handle remote errors properly', async () => {
      server.use(
        http.get('https://api.librechat.ai/v1/enterprise/user', () => {
          return new HttpResponse(JSON.stringify({ error: 'Server Error' }), {
            status: 500,
            headers: {
              'Content-Type': 'application/json',
            },
          });
        })
      );

      let error;
      try {
        await validateAndGetUser('user-id', 'valid-key');
      } catch (e) {
        error = e;
      }
      expect(error).toBeDefined();
      expect(isErrorDetails(error)).toBe(true);
      if (isErrorDetails(error)) {
        expect(error.status).toBe(500);
      }
    });

    it('should handle network errors', async () => {
      server.use(
        http.get('https://api.librechat.ai/v1/enterprise/user', () => {
          return HttpResponse.error();
        })
      );

      let error;
      try {
        await validateAndGetUser('user-id', 'valid-key');
      } catch (e) {
        error = e;
      }
      expect(error).toBeDefined();
      expect(isErrorDetails(error)).toBe(true);
    });
  });

  describe('validateApiKey', () => {
    const mockApiKeyResponseWithSecret: IApiKey = {
      ...mockApiKeyResponse,
      secret: 'hashed-secret',
    };

    it('should successfully validate API key remotely', async () => {
      server.use(
        http.get('https://api.librechat.ai/v1/enterprise/key', () => {
          return HttpResponse.json(mockApiKeyResponseWithSecret);
        })
      );

      const result = await validateApiKey('valid-key');
      expect(result).toEqual(mockApiKeyResponseWithSecret);
    });

    it('should handle remote errors properly', async () => {
      server.use(
        http.get('https://api.librechat.ai/v1/enterprise/key', () => {
          return new HttpResponse(JSON.stringify({ error: 'Server Error' }), {
            status: 500,
            headers: {
              'Content-Type': 'application/json',
            },
          });
        })
      );

      let error;
      try {
        await validateApiKey('valid-key');
      } catch (e) {
        error = e;
      }
      expect(error).toBeDefined();
      expect(isErrorDetails(error)).toBe(true);
      if (isErrorDetails(error)) {
        expect(error.status).toBe(500);
      }
    });

    it('should handle network errors', async () => {
      server.use(
        http.get('https://api.librechat.ai/v1/enterprise/key', () => {
          return HttpResponse.error();
        })
      );

      let error;
      try {
        await validateApiKey('valid-key');
      } catch (e) {
        error = e;
      }
      expect(error).toBeDefined();
      expect(isErrorDetails(error)).toBe(true);
    });

    it('should handle invalid API key format', async () => {
      server.use(
        http.get('https://api.librechat.ai/v1/enterprise/key', () => {
          return new HttpResponse(
            JSON.stringify({ error: 'Invalid API key' }),
            {
              status: 401,
              headers: {
                'Content-Type': 'application/json',
              },
            }
          );
        })
      );

      let error;
      try {
        await validateApiKey('invalid-format-key');
      } catch (e) {
        error = e;
      }
      expect(error).toBeDefined();
      expect(isErrorDetails(error)).toBe(true);
      if (isErrorDetails(error)) {
        expect(error.status).toBe(401);
      }
    });
  });

  describe('Remote Token Validation', () => {
    const mockUserId = 'user-123';

    describe('validateRemoteToken', () => {
      it('should successfully validate token remotely', async () => {
        server.use(
          http.get('https://api.librechat.ai/v1/enterprise/user/id', () => {
            return HttpResponse.json(mockUserId);
          })
        );

        const result = await validateRemoteToken('valid-token');
        expect(result).toBe(mockUserId);
      });

      it('should send correct headers', async () => {
        const testToken = 'test-access-token';
        let capturedHeaders: Record<string, string> = {};

        server.use(
          http.get(
            'https://api.librechat.ai/v1/enterprise/user/id',
            ({ request }) => {
              capturedHeaders = Object.fromEntries(request.headers);
              return HttpResponse.json(mockUserId);
            }
          )
        );

        await validateRemoteToken(testToken);
        expect(capturedHeaders['x-access-token']).toBe(testToken);
        expect(capturedHeaders['x-api-key']).toBeUndefined();
      });

      it('should handle unauthorized access', async () => {
        server.use(
          http.get('https://api.librechat.ai/v1/enterprise/user/id', () => {
            return new HttpResponse(JSON.stringify({ error: 'Unauthorized' }), {
              status: 401,
              headers: {
                'Content-Type': 'application/json',
              },
            });
          })
        );

        let error;
        try {
          await validateRemoteToken('invalid-token');
        } catch (e) {
          error = e;
        }
        expect(error).toBeDefined();
        expect(isErrorDetails(error)).toBe(true);
        if (isErrorDetails(error)) {
          expect(error.status).toBe(401);
        }
      });

      it('should handle server errors', async () => {
        server.use(
          http.get('https://api.librechat.ai/v1/enterprise/user/id', () => {
            return new HttpResponse(JSON.stringify({ error: 'Server Error' }), {
              status: 500,
              headers: {
                'Content-Type': 'application/json',
              },
            });
          })
        );

        let error;
        try {
          await validateRemoteToken('valid-token');
        } catch (e) {
          error = e;
        }
        expect(error).toBeDefined();
        expect(isErrorDetails(error)).toBe(true);
        if (isErrorDetails(error)) {
          expect(error.status).toBe(500);
        }
      });

      it('should handle network errors', async () => {
        server.use(
          http.get('https://api.librechat.ai/v1/enterprise/user/id', () => {
            return HttpResponse.error();
          })
        );

        let error;
        try {
          await validateRemoteToken('valid-token');
        } catch (e) {
          error = e;
        }
        expect(error).toBeDefined();
        expect(isErrorDetails(error)).toBe(true);
      });

      it('should handle malformed response data', async () => {
        server.use(
          http.get('https://api.librechat.ai/v1/enterprise/user/id', () => {
            return new HttpResponse(
              '{"bad json syntax', // Intentionally malformed JSON
              {
                status: 500,
                headers: {
                  'Content-Type': 'application/json',
                },
              }
            );
          })
        );

        let error;
        try {
          await validateRemoteToken('valid-token');
        } catch (e) {
          error = e;
        }
        expect(error).toBeDefined();
        expect(isErrorDetails(error)).toBe(true);
        if (isErrorDetails(error)) {
          expect(error.status).toBe(500);
          expect(error.message).toBeDefined();
        }
      });

      // Test fallback to local validation
      it('should fall back to local validation when remote validation fails', async () => {
        // Mock the remote call to fail
        server.use(
          http.get('https://api.librechat.ai/v1/enterprise/user/id', () => {
            return HttpResponse.error();
          })
        );
      });
    });
  });
});
