import express, { json, Router } from 'express';
import { startServer, gracefulShutdown } from './lifecycle';
import enterpriseRouter from './enterprise/router';
import { apiKeyAuth } from './middleware/auth';
import { requestErrorLogger, requestNotFoundLogger } from './middleware/request-error-logger';
import { getAuthProviderMode } from './auth/provider';
import newsletterRouter from './emails/router';
import serviceRouter from './service/router';
import programmaticRouter from './service/programmatic-router';
import webhookRouter from './webhook/router';
import { connection } from './queue';
import { env } from './config';
import logger from './logger';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const v1 = Router();

// IMPORTANT: Move this before any json() middleware
app.use('/v1/webhook', webhookRouter);

app.use(json({ limit: env.HTTP_JSON_LIMIT })); // Large scripts/tool definitions are configurable.

app.use('/v1/newsletter', newsletterRouter);

app.get('/v1/health', async (_, res) => {
  try {
    await connection.ping();
    res.sendStatus(200);
  } catch (error) {
    logger.error('Health check failed:', error);
    res.sendStatus(503);
  }
});

v1.use(apiKeyAuth);

v1.use('/enterprise', enterpriseRouter);

v1.use(serviceRouter);
v1.use(programmaticRouter);

app.use('/v1', v1);
app.use(requestNotFoundLogger);
app.use(requestErrorLogger);

startServer(app, async () => {
  const mode = getAuthProviderMode();
  if (mode !== 'legacy-api-key' && mode !== 'both') {
    logger.info('Skipping Azure client initialization for non-legacy auth provider');
    return;
  }
  logger.info('Initializing Azure client...');
  const { initializeAzureClient } = await import('@librechat/api-keys');
  await initializeAzureClient();
  logger.info('Azure client initialized');
});

// Add SIGTERM handler
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
process.on('SIGUSR2', gracefulShutdown); // For nodemon restarts

// Improve your existing handlers
process.on('uncaughtException', async (error) => {
  logger.error('Uncaught Exception', error);
  await gracefulShutdown();
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection', reason);
});
