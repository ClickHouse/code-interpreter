// src/queue.ts
import IORedis from 'ioredis';
import { Queue, QueueEvents } from 'bullmq';
import { setMaxListeners } from 'events';
import type { CommonRedisOptions } from 'ioredis';
import type * as tls from 'tls';
import type * as t from './types';
import { Jobs, Queues } from './enum';
import { env } from './config';
import logger from './logger';

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 2000;

const retryStrategy: CommonRedisOptions['retryStrategy'] = (times) => {
  if (times > MAX_RECONNECT_ATTEMPTS) {
    logger.error(`Failed to connect to Redis after ${times} attempts`);
    return null;
  }
  logger.warn(`Retrying Redis connection attempt ${times}`);
  return RECONNECT_DELAY;
};

const reconnectOnError: CommonRedisOptions['reconnectOnError'] = (err) => {
  logger.error('Redis connection error:', err);
  const targetError = 'READONLY';
  if (err.message.includes(targetError)) {
    return true;
  }
  return false;
};

const connection = new IORedis({
  host: process.env.REDIS_HOST ?? 'redis',
  port: Number(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD,
  maxRetriesPerRequest: null,
  retryStrategy,
  reconnectOnError,
  enableReadyCheck: true,
  connectTimeout: 10000,
  disconnectTimeout: 2000,
  tls: process.env.REDIS_TLS === 'true' ? {
    rejectUnauthorized: false
  } as tls.ConnectionOptions : undefined,
  // Alternative DNS lookup for AWS ElastiCache TLS connections
  ...(env.REDIS_USE_ALTERNATIVE_DNS_LOOKUP
    ? { dnsLookup: (address: string, callback: (err: Error | null, addr: string) => void): void => callback(null, address) }
    : {})
});

// Global queues - no INSTANCE_ID prefix
// This enables horizontal scaling where any worker can process any job
const pyQueue = new Queue<t.JobData, t.JobResult, Jobs.execute>(Queues.python, { connection });
const otherQueue = new Queue<t.JobData, t.JobResult, Jobs.execute>(Queues.other, { connection });

const pyQueueEvents = new QueueEvents(Queues.python, { connection });
const otherQueueEvents = new QueueEvents(Queues.other, { connection });

/* job.waitUntilFinished() attaches a short-lived `closing` listener to the
 * shared Queue for every in-flight HTTP request waiting on a result. Bursts
 * above Node's default listener limit are normal for CodeAPI throughput, so
 * keep the leak warning enabled elsewhere while disabling it for these shared
 * BullMQ coordination objects. */
setMaxListeners(0, pyQueue, otherQueue, pyQueueEvents, otherQueueEvents);

const webhookQueue = new Queue<t.WebhookJobData>('stripe-webhooks', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: true,
    removeOnFail: 1000,
  },
});

export { pyQueue, otherQueue, pyQueueEvents, otherQueueEvents, webhookQueue, connection };
