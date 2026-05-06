// src/webhook/processor.ts
import { Job } from 'bullmq';
import type { SupportedEventType, WebhookJobData } from '../types';
import { WebhookJob } from '../models/WebhookJob';
import { StripeWebhookHandler } from './handler';
import { env } from '../config';
import logger from '../logger';

const { INSTANCE_ID } = env;

export async function processWebhookJob(job: Job<WebhookJobData>): Promise<void> {
  const { event, timestamp } = job.data;
  logger.info(`[${INSTANCE_ID}] Processing event ${event.type}`);

  try {
    // Create or update job status
    await WebhookJob.findOneAndUpdate(
      { stripeEventId: event.id },
      {
        $set: {
          eventType: event.type,
          status: 'processing',
          timestamp,
        },
        $inc: { attempts: 1 },
      },
      { upsert: true }
    );

    // Get handler for event type
    const handler = StripeWebhookHandler.eventHandlers[event.type as SupportedEventType];
    if (!handler) {
      logger.warn(`[${INSTANCE_ID}] No handler for event type ${event.type}, skipping...`);
      await WebhookJob.findOneAndUpdate(
        { stripeEventId: event.id },
        {
          status: 'skipped',
          processedAt: new Date(),
          message: `No handler for event type: ${event.type}`,
        }
      );
      return;
    }

    logger.info(`[${INSTANCE_ID}] Processing event ${event.type} with handler: ${handler.name}`);
    await handler(event);

    // Update job status
    logger.info(`[${INSTANCE_ID}] Event ${event.type} processed successfully, updating job status`);
    await WebhookJob.findOneAndUpdate(
      { stripeEventId: event.id },
      {
        status: 'completed',
        processedAt: new Date(),
      }
    );

    await job.updateProgress(100);
  } catch (_error: unknown) {
    logger.error('Webhook processing failed:', _error);
    const error = _error as Error;
    await WebhookJob.findOneAndUpdate(
      { stripeEventId: event.id },
      {
        status: 'failed',
        error: error.message,
        stackTrace: error.stack,
      }
    );
    throw error; // Rethrow to trigger BullMQ retry
  }
}