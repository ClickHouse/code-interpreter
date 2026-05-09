/**
 * API-Only Server
 *
 * This is a stateless API server that:
 * - Handles HTTP requests
 * - Submits jobs to the global queue
 * - Waits for results via Redis pub/sub
 * - Does NOT run workers (workers run in separate pods)
 *
 * For horizontal scaling:
 * - Scale this independently based on HTTP traffic
 * - Jobs are processed by Worker pods (worker-server.ts)
 */
import express, { json, Router } from 'express';
import type { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from './types';
import type { IApiKey } from '@librechat/api-keys';
import { startApiServer, gracefulShutdown } from './lifecycle';
import enterpriseRouter from './enterprise/router';
import { apiKeyAuth } from './middleware/auth';
import { requestErrorLogger, requestNotFoundLogger } from './middleware/request-error-logger';
import { applyPrincipal } from './auth/principal';
import { getAuthProviderMode } from './auth/provider';
import newsletterRouter from './emails/router';
import serviceRouter from './service/router';
import programmaticRouter from './service/programmatic-router';
import webhookRouter from './webhook/router';
import { connection } from './queue';
import { metricsHandler } from './metrics';
import { httpMetricsMiddleware } from './middleware/httpMetrics';
import { env } from './config';
import logger from './logger';

const { LOCAL_MODE: isLocalMode } = env;

// Mock auth middleware for local testing - always passes with a test user
const localAuth = async (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  const mockApiKey: IApiKey = {
    _id: 'local-test-key',
    userId: 'local-test-user',
    name: 'Local Test Key',
    secret: 'local-secret',
    usage: 0,
    lastUsedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  req.apiKey = mockApiKey;
  req.planId = 'local-plan';
  /* Mirror the populate that `apiKeyAuth` does for prod auth — both
   * code paths must set `codeApiAuthContext` so sessionKey resolvers
   * have a userId. Without this, /exec under LOCAL_MODE 500s with
   * "authContext.userId is missing" while prod works fine, masking
   * the regression for anyone running locally. */
  applyPrincipal(req, {
    userId: mockApiKey.userId.toString(),
    tenantId: 'legacy',
    principalSource: 'legacy_api_key',
    credentialId: mockApiKey._id.toString(),
  });
  next();
};

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(httpMetricsMiddleware);

const v1 = Router();

// IMPORTANT: Move this before any json() middleware
if (!isLocalMode) {
  app.use('/v1/webhook', webhookRouter);
}

app.use(json({ limit: '50mb' }));

if (!isLocalMode) {
  app.use('/v1/newsletter', newsletterRouter);
}

app.get('/metrics', metricsHandler);

app.get('/v1/health', async (_, res) => {
  try {
    await connection.ping();
    res.sendStatus(200);
  } catch (error) {
    logger.error('Health check failed:', error);
    res.sendStatus(503);
  }
});

v1.use(isLocalMode ? localAuth : apiKeyAuth);

if (!isLocalMode) {
  v1.use('/enterprise', enterpriseRouter);
}

v1.use(serviceRouter);
v1.use(programmaticRouter);

app.use('/v1', v1);
app.use(requestNotFoundLogger);
app.use(requestErrorLogger);

// Start API-only server (no workers)
startApiServer(app, async () => {
  if (!isLocalMode) {
    const mode = getAuthProviderMode();
    if (mode !== 'legacy-api-key' && mode !== 'both') {
      logger.info('Skipping Azure client initialization for non-legacy auth provider');
      return;
    }
    logger.info('Initializing Azure client...');
    const { initializeAzureClient } = await import('@librechat/api-keys');
    await initializeAzureClient();
    logger.info('Azure client initialized');
  }
});

// Graceful shutdown handlers
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
process.on('SIGUSR2', gracefulShutdown);

process.on('uncaughtException', async (error) => {
  logger.error('Uncaught Exception', error);
  await gracefulShutdown();
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection', reason);
});
