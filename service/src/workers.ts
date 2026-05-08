import axios from 'axios';
import { Worker } from 'bullmq';
import { incrementUserApiUsage, incrementApiKeyUsage, createLog } from '@librechat/api-keys';
import type { CreateLogInput } from '@librechat/api-keys';
import type * as t from './types';
import { filterSystemLogs, applySystemReplacements, getAxiosErrorDetails } from './utils';
import { jobProcessingDuration, jobsCompleted, jobsFailed, activeJobs, workerRunning } from './metrics';
import { Jobs, Queues } from './enum';
import { connection } from './queue';
import { env } from './config';
import { EXECUTION_MANIFEST_HEADER, signExecutionManifest } from './execution-manifest';
import logger from './logger';

const { INSTANCE_ID } = env;
const WORKER_ID = `${INSTANCE_ID}-${process.pid}`;

type Log = Omit<CreateLogInput, 'userId' | 'input'>;

async function incrementAndCacheUser(userId: string, apiKeyString: string): Promise<void> {
  const user = await incrementUserApiUsage(userId, apiKeyString);
  await connection.set(
    `user:${userId}`,
    JSON.stringify(user),
    'EX',
    env.USER_CACHE_TTL
  );
}

async function incrementAndCacheApiKey(apiKeyId: string, apiKeyString: string): Promise<void> {
  const apiKey = await incrementApiKeyUsage(apiKeyId, apiKeyString);
  await connection.set(
    `apiKey:${apiKeyString}`,
    JSON.stringify(apiKey),
    'EX',
    env.KEY_CACHE_TTL
  );
}

const { LOCAL_MODE: isLocalMode } = env;

async function completeJob(job: t.ExecuteJob): Promise<void> {
  if (isLocalMode) {
    logger.debug('Skipping usage increment in local mode');
    return;
  }

  const { userId, apiKeyString, apiKeyId } = job.data;
  const promises: Array<Promise<void>> = [];
  promises.push(incrementAndCacheUser(userId, apiKeyString).catch(err => {logger.error('Error incrementing user usage', err);}));
  promises.push(incrementAndCacheApiKey(apiKeyId, apiKeyString).catch(err => {logger.error('Error incrementing API key usage', err);}));
  await Promise.all(promises);
}

async function processJob(job: t.ExecuteJob): Promise<t.ExecuteResult> {
  const { code, payload, isPyPlot, SANDBOX_ENDPOINT } = job.data;
  const language = payload?.language ?? 'unknown';
  const endTimer = jobProcessingDuration.startTimer({ language });
  activeJobs.inc({ language });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.JOB_TIMEOUT);

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (job.data.executionManifestClaims) {
      const nowSeconds = Math.floor(Date.now() / 1000);
      headers[EXECUTION_MANIFEST_HEADER] = signExecutionManifest(
        {
          ...job.data.executionManifestClaims,
          iat: nowSeconds,
          exp: nowSeconds + env.EXECUTION_MANIFEST_TTL_SECONDS,
        },
        env.EXECUTION_MANIFEST_SECRET,
      );
    }

    const response = await axios.post<Log & { files?: t.FileRefs }>(
      `${SANDBOX_ENDPOINT}/${Jobs.execute}`,
      payload,
      {
        headers,
        signal: controller.signal
      }
    );

    if (response.status !== 200) {
      throw new Error('Error from sandbox');
    }

    logger.info('Sandbox response', { data: response.data });

    const { files } = response.data;
    try {
      if (env.LOGGING_ENABLED === true) {
        createLog({
          userId: job.data.userId,
          ...response.data,
          input: code,
        }).catch(err => logger.error('Error creating log', err));
      }
    } catch (err) {
      logger.error('Error creating log', err);
    }
    const run = response.data.run as CreateLogInput['run'] | undefined;
    const stdout = applySystemReplacements(run?.stdout ?? '');
    const stderr = filterSystemLogs(run?.stderr ?? '', isPyPlot);

    const result: t.ExecuteResult = {
      session_id: response.data.session_id,
      /* `files` is optional on the sandbox response (e.g. dry-run
       * execute with no outputs); the public `ExecuteResult.files` is
       * required and downstream callers always iterate it. Default to
       * `[]` so the strictened response type from Phase B doesn't
       * surface a regression that wasn't there before. */
      files: files ?? [],
      stdout,
      stderr,
    };

    if (run) {
      result.code = run.code ?? null;
      result.signal = run.signal != null ? String(run.signal) : null;
      result.message = run.message ?? null;
      result.status = run.status ?? null;
      result.wall_time = (run as Record<string, unknown>).wall_time as number | null ?? null;
    }

    if (result.message || result.signal) {
      logger.warn('Sandbox execution error metadata', {
        session_id: response.data.session_id,
        code: result.code,
        signal: result.signal,
        message: result.message,
        status: result.status,
        wall_time: result.wall_time,
      });
    }

    return result;
  } catch (error) {
    const errorDetails = getAxiosErrorDetails(error);
    logger.error('Error processing job', errorDetails);

    if (axios.isAxiosError(error) && error.name === 'AbortError') {
      throw new Error(`Job timed out after ${env.JOB_TIMEOUT}ms`);
    } else if (axios.isAxiosError(error)) {
      /** Preserve error message from sandbox */
      const sandboxError = (error.response?.data?.message as string) || (error.response?.data?.error as string) || error.message;
      throw new Error(`Error from sandbox: ${sandboxError}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    endTimer();
    activeJobs.dec({ language });
  }
}

// Global workers - no INSTANCE_ID prefix
// This enables horizontal scaling where any worker can process any job from the shared queue
// Each worker respects its own concurrency limit based on its co-located sandbox capacity
export const pyWorker = new Worker(Queues.python, processJob, {
  connection,
  concurrency: env.PYTHON_CONCURRENCY,
  limiter: {
    max: env.PYTHON_CONCURRENCY,
    duration: env.JOB_WINDOW,
  },
});

export const otherWorker = new Worker(Queues.other, processJob, {
  connection,
  concurrency: env.OTHER_CONCURRENCY,
  limiter: {
    max: env.OTHER_CONCURRENCY,
    duration: env.JOB_WINDOW,
  },
});

workerRunning.set({ worker_type: 'python' }, 1);
workerRunning.set({ worker_type: 'other' }, 1);

pyWorker.on('completed', job => {
  logger.info(`[${WORKER_ID}] Python job completed ${job.id}`);
  jobsCompleted.inc({ language: 'python' });
  completeJob(job).catch(err => logger.error('Error completing job', err));
});

otherWorker.on('completed', job => {
  logger.info(`[${WORKER_ID}] Other job completed ${job.id}`);
  jobsCompleted.inc({ language: 'other' });
  completeJob(job).catch(err => logger.error('Error completing job', err));
});

pyWorker.on('failed', (job, err) => {
  logger.error(`[${WORKER_ID}] Python job ${job?.id} failed`, err);
  jobsFailed.inc({ language: 'python' });
});

otherWorker.on('failed', (job, err) => {
  logger.error(`[${WORKER_ID}] Other job ${job?.id} failed`, err);
  jobsFailed.inc({ language: 'other' });
});

pyWorker.on('error', (err) => {
  logger.error(`[${WORKER_ID}] Python worker error`, err);
  workerRunning.set({ worker_type: 'python' }, 0);
});

otherWorker.on('error', (err) => {
  logger.error(`[${WORKER_ID}] Other worker error`, err);
  workerRunning.set({ worker_type: 'other' }, 0);
});

pyWorker.on('closed', () => {
  workerRunning.set({ worker_type: 'python' }, 0);
});

otherWorker.on('closed', () => {
  workerRunning.set({ worker_type: 'other' }, 0);
});
