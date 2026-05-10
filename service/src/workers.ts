import axios from 'axios';
import { Worker } from 'bullmq';
import type { CreateLogInput } from '@librechat/api-keys';
import type * as t from './types';
import { filterSystemLogs, applySystemReplacements, getAxiosErrorDetails } from './utils';
import { jobProcessingDuration, jobsCompleted, jobsFailed, activeJobs, workerRunning } from './metrics';
import { Jobs, Queues } from './enum';
import { connection } from './queue';
import { env } from './config';
import { summarizeSandboxResponse, summarizeText } from './execution-log';
import { createGatewayEgressGrant, restoreGatewaySandboxResult, revokeGatewayEgressGrant } from './egress-gateway-client';
import { refreshEgressGrantClaims } from './sandbox-egress';
import { buildSandboxExecuteRequest } from './sandbox-dispatch';
import logger from './logger';

const { INSTANCE_ID } = env;
const WORKER_ID = `${INSTANCE_ID}-${process.pid}`;

type Log = Omit<CreateLogInput, 'userId' | 'input'>;
type SandboxLogResponse = Log & {
  session_id: string;
  files?: t.FileRefs;
  run?: CreateLogInput['run'];
};
type ApiKeysModule = typeof import('@librechat/api-keys');

let apiKeysModulePromise: Promise<ApiKeysModule> | null = null;

function getApiKeysModule(): Promise<ApiKeysModule> {
  apiKeysModulePromise ??= import('@librechat/api-keys');
  return apiKeysModulePromise;
}

async function incrementAndCacheUser(userId: string, apiKeyString: string): Promise<void> {
  const { incrementUserApiUsage } = await getApiKeysModule();
  const user = await incrementUserApiUsage(userId, apiKeyString);
  await connection.set(
    `user:${userId}`,
    JSON.stringify(user),
    'EX',
    env.USER_CACHE_TTL
  );
}

async function incrementAndCacheApiKey(apiKeyId: string, apiKeyString: string): Promise<void> {
  const { incrementApiKeyUsage } = await getApiKeysModule();
  const apiKey = await incrementApiKeyUsage(apiKeyId, apiKeyString);
  await connection.set(
    `apiKey:${apiKeyString}`,
    JSON.stringify(apiKey),
    'EX',
    env.KEY_CACHE_TTL
  );
}

const { LOCAL_MODE: isLocalMode } = env;

function isAbortError(error: unknown): boolean {
  return axios.isAxiosError(error) && (error.name === 'AbortError' || error.code === 'ERR_CANCELED');
}

async function completeJob(job: t.ExecuteJob): Promise<void> {
  if (isLocalMode) {
    logger.debug('Skipping usage increment in local mode');
    return;
  }

  const { userId, apiKeyString, apiKeyId, principalSource } = job.data;
  if (principalSource !== undefined && principalSource !== 'legacy_api_key') {
    logger.debug('Skipping legacy API-key usage increment for non-API-key principal', {
      principalSource,
      userId,
    });
    return;
  }
  if (!apiKeyString || !apiKeyId) {
    logger.debug('Skipping legacy API-key usage increment without API-key credentials', {
      principalSource,
      userId,
    });
    return;
  }
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
  let egressGrantId: string | undefined;
  let egressGrantTokenForRestore: string | undefined;
  let revokeReason = 'completed';

  try {
    let sandboxPayload = payload;
    let executionManifestClaims = job.data.executionManifestClaims;
    let egressGrantToken = job.data.egressGrantToken;

    if (job.data.egressGrantClaims) {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const prepared = await createGatewayEgressGrant({
        payload,
        claims: refreshEgressGrantClaims(job.data.egressGrantClaims, nowSeconds),
        signal: controller.signal,
      });
      egressGrantId = prepared.grant_id;
      sandboxPayload = prepared.payload;
      egressGrantToken = prepared.egressGrantToken;
      egressGrantTokenForRestore = prepared.egressGrantToken;
      executionManifestClaims = (env.EXECUTION_MANIFEST_PRIVATE_KEY || env.EXECUTION_MANIFEST_SECRET)
        ? prepared.executionManifestClaims
        : undefined;
    }

    const sandboxRequest = buildSandboxExecuteRequest({
      payload: sandboxPayload,
      egressGrantToken,
      executionManifestClaims,
      executionManifestPrivateKey: env.EXECUTION_MANIFEST_PRIVATE_KEY,
      executionManifestSecret: env.EXECUTION_MANIFEST_SECRET,
      executionManifestTtlSeconds: env.EXECUTION_MANIFEST_TTL_SECONDS,
    });
    egressGrantTokenForRestore = egressGrantToken;

    const response = await axios.post<SandboxLogResponse>(
      `${SANDBOX_ENDPOINT}/${Jobs.execute}`,
      sandboxRequest.body,
      {
        headers: sandboxRequest.headers,
        signal: controller.signal
      }
    );

    if (response.status !== 200) {
      throw new Error('Error from sandbox');
    }

    const responseData = egressGrantTokenForRestore
      ? await restoreGatewaySandboxResult({
        grantId: egressGrantId,
        egressGrantToken: egressGrantTokenForRestore,
        result: response.data,
        signal: controller.signal,
      })
      : response.data;

    logger.info('Sandbox response', summarizeSandboxResponse(responseData));

    const { files } = responseData;
    try {
      if (
        env.LOGGING_ENABLED === true &&
        (job.data.principalSource === undefined || job.data.principalSource === 'legacy_api_key')
      ) {
        const { createLog } = await getApiKeysModule();
        createLog({
          userId: job.data.userId,
          ...responseData,
          input: code,
        }).catch((err: unknown) => logger.error('Error creating log', err));
      } else if (env.LOGGING_ENABLED === true) {
        logger.debug('Skipping legacy API-key log creation for non-API-key principal', {
          principalSource: job.data.principalSource,
          userId: job.data.userId,
        });
      }
    } catch (err) {
      logger.error('Error creating log', err);
    }
    const run = responseData.run as CreateLogInput['run'] | undefined;
    const stdout = applySystemReplacements(run?.stdout ?? '');
    const stderr = filterSystemLogs(run?.stderr ?? '', isPyPlot);

    const result: t.ExecuteResult = {
      session_id: responseData.session_id,
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
        session_id: responseData.session_id,
        code: result.code,
        signal: result.signal,
        message: summarizeText(result.message),
        status: result.status,
        wall_time: result.wall_time,
      });
    }

    return result;
  } catch (error) {
    revokeReason = isAbortError(error) ? 'timeout' : 'failed';
    const errorDetails = getAxiosErrorDetails(error);
    logger.error('Error processing job', errorDetails);

    if (isAbortError(error)) {
      throw new Error(`Job timed out after ${env.JOB_TIMEOUT}ms`);
    } else if (axios.isAxiosError(error)) {
      /** Preserve error message from sandbox */
      const sandboxError = (error.response?.data?.message as string) || (error.response?.data?.error as string) || error.message;
      throw new Error(`Error from sandbox: ${sandboxError}`);
    }
    throw error;
  } finally {
    if (egressGrantId || egressGrantTokenForRestore) {
      await revokeGatewayEgressGrant({
        grantId: egressGrantId,
        egressGrantToken: egressGrantId ? undefined : egressGrantTokenForRestore,
        reason: revokeReason,
        timeoutMs: env.EGRESS_GATEWAY_REVOKE_TIMEOUT_MS,
      }).catch(error => {
        logger.error('Failed to revoke egress grant', { grantId: egressGrantId, error: getAxiosErrorDetails(error) });
      });
    }
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
