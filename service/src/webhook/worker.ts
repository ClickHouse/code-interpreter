// src/queue/worker.ts
import { Worker } from 'bullmq';
import { processWebhookJob } from './processor';
import { connection } from '../queue';
import { env } from '../config';
import logger from '../logger';

const { INSTANCE_ID } = env;

export const webhookWorker = new Worker(
  'stripe-webhooks',
  async (job) => {
    await processWebhookJob(job);
  },
  {
    connection,
    concurrency: 1, // Process one job at a time
    lockDuration: 30000, // 30 seconds
    maxStalledCount: 2, // Number of times a job can be stalled before being marked as failed
  }
);

webhookWorker.on('ready', () => {
  if (process.env.STRIPE_PUBLIC_KEY == null) {
    return;
  }
  logger.info(`[${INSTANCE_ID}][stripe] Worker is ready`);
});

webhookWorker.on('active', (job) => {
  logger.info(`[${INSTANCE_ID}][stripe] Processing job ${job.id}`);
});

webhookWorker.on('completed', (job) => {
  logger.info(`[${INSTANCE_ID}][stripe] Completed ${job.id} of type ${job.name}`);
});

webhookWorker.on('failed', (job, err) => {
  logger.error(`[${INSTANCE_ID}][stripe] Failed job ${job?.id} of type ${job?.name}:`, err);
});

webhookWorker.on('error', (err) => {
  logger.error(`[${INSTANCE_ID}][stripe] Worker error:`, err);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  await webhookWorker.close();
});