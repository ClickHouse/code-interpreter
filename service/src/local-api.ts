/**
 * Local Development API
 *
 * This is a simplified API for local testing that:
 * - Does NOT require SANDBOX_ACCESS_TOKEN or MONGODB_URI
 * - Does NOT validate API keys against remote services
 * - Uses a mock user for all requests
 *
 * NOT FOR PRODUCTION USE
 */
import express, { json, Router } from 'express';
import type { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from './types';
import type { IApiKey } from '@librechat/api-keys';
import serviceRouter from './service/router';
import programmaticRouter from './service/programmatic-router';
import { requestErrorLogger, requestNotFoundLogger } from './middleware/request-error-logger';
import { applyPrincipal } from './auth/principal';
import { pyQueue, otherQueue, webhookQueue, pyQueueEvents, otherQueueEvents, connection } from './queue';
import { setStartupComplete } from './lifecycle';
// Workers are imported to ensure they're started with the process
import './workers';
import { webhookWorker } from './webhook/worker';
import { env } from './config';
import logger from './logger';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const v1 = Router();

app.use(json({ limit: '50mb' }));

// Health check
app.get('/v1/health', async (_, res) => {
  try {
    await connection.ping();
    res.sendStatus(200);
  } catch (error) {
    logger.error('Health check failed:', error);
    res.sendStatus(503);
  }
});

// Mock auth middleware - always passes with a test user
const localAuth = async (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  // Set mock user data for local testing
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
  /* Mirror the populate that `apiKeyAuth` does for prod auth. Without
   * this, sessionKey resolvers that read `codeApiAuthContext.userId`
   * 500 with "authContext.userId is missing" under local mode. */
  applyPrincipal(req, {
    userId: mockApiKey.userId.toString(),
    tenantId: 'legacy',
    principalSource: 'legacy_api_key',
    credentialId: mockApiKey._id.toString(),
  });
  next();
};

v1.use(localAuth);
v1.use(serviceRouter);
v1.use(programmaticRouter);
app.use('/v1', v1);
app.use(requestNotFoundLogger);
app.use(requestErrorLogger);

// Simplified startup for local development
async function localStartup(): Promise<void> {
  logger.info('Starting local development server...');
  logger.info('⚠️  LOCAL MODE - No authentication required');

  try {
    // Set a local user ID for session management
    await connection.set('access-user', 'local-test-user');

    // Note: We no longer drain/clean queues on startup because they are shared
    // across all workers in a horizontally scaled deployment.
    // Stale jobs are handled by BullMQ's stalledInterval configuration.

    // Resume queues (in case they were paused)
    await Promise.all([
      pyQueue.resume(),
      otherQueue.resume(),
      webhookQueue.resume()
    ]);

    setStartupComplete();
    logger.info('Local startup complete');
  } catch (error) {
    logger.error('Error during local startup:', error);
    throw error;
  }
}

async function localShutdown(): Promise<void> {
  logger.info('Shutting down local server...');
  try {
    await Promise.all([
      pyQueue.close(),
      otherQueue.close(),
      pyQueueEvents.close(),
      otherQueueEvents.close(),
      webhookWorker.close()
    ]);
    logger.info('Local shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown:', error);
    process.exit(1);
  }
}

// Start server
localStartup().then(() => {
  app.listen(env.PORT, () => {
    logger.info(`[LOCAL] Server running on port ${env.PORT}`);
    logger.info(`[LOCAL] PYTHON_CONCURRENCY: ${env.PYTHON_CONCURRENCY} | OTHER_CONCURRENCY: ${env.OTHER_CONCURRENCY}`);
  });
}).catch((error) => {
  logger.error('Failed to start local server:', error);
  process.exit(1);
});

process.on('SIGTERM', localShutdown);
process.on('SIGINT', localShutdown);
process.on('SIGUSR2', localShutdown);

process.on('uncaughtException', async (error) => {
  logger.error('Uncaught Exception', error);
  await localShutdown();
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection', reason);
});
