import express, { type Request, type Response, type NextFunction } from 'express';
import type { Runtime } from '../runtime';
import type { TFile } from '../job';
import { getLatestRuntimeMatchingLanguageVersion, getRuntimes } from '../runtime';
import { logger } from '../logger';
import { config } from '../config';
import { Job, ValidationError } from '../job';
import { EXECUTION_MANIFEST_HEADER, ExecutionManifestError } from '../execution-manifest';
import { verifyExecuteRequestManifest } from '../execution-manifest-request';
import { EGRESS_GRANT_HEADER } from '../egress';

const router = express.Router();

export interface ExecuteRequestBody {
  /** Top-level execution session id (one sandbox `/exec` invocation).
   *  Intra-monorepo wire — service-api and sandbox ship together, so
   *  the rename is hard with no backward-compat alias. */
  session_id?: string;
  /** Output storage session id/handle used for generated file uploads. */
  output_session_id?: string;
  language: string;
  version: string;
  args?: string[];
  stdin?: string;
  files: TFile[];
  compile_memory_limit?: number;
  run_memory_limit?: number;
  run_timeout?: number;
  compile_timeout?: number;
  run_cpu_time?: number;
  compile_cpu_time?: number;
  env_vars?: Record<string, string>;
  egress_grant?: string;
  execution_manifest?: string;
}

export const ENV_VAR_KEY_RE = /^[A-Z_][A-Z0-9_]*$/i;
export const MAX_ENV_VAR_BYTES = 1_000_000;

export function sanitizeEnvVars(raw: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, string> = {};
  let totalBytes = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== 'string' || typeof value !== 'string') continue;
    if (!ENV_VAR_KEY_RE.test(key)) continue;
    const entryBytes = Buffer.byteLength(key) + Buffer.byteLength(value);
    if (totalBytes + entryBytes > MAX_ENV_VAR_BYTES) {
      throw new Error(`env_vars exceeds maximum total size of ${MAX_ENV_VAR_BYTES} bytes`);
    }
    totalBytes += entryBytes;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Service-worker sends large opaque capabilities in the JSON body because
 * skill-heavy executions can make encrypted grants/manifests exceed HTTP
 * header limits and fail with 431 before this route can validate them.
 * Header fallback keeps rolling upgrades compatible.
 */
export function tokenFromBodyOrHeader(
  body: ExecuteRequestBody,
  field: 'egress_grant' | 'execution_manifest',
  headerValue: string | undefined,
): string | undefined {
  const bodyValue = body[field];
  if (typeof bodyValue === 'string' && bodyValue !== '') return bodyValue;
  return headerValue;
}

function getJob(body: ExecuteRequestBody, egressGrantToken?: string): Job {
  const {
    session_id, language, version, args, stdin, files,
    compile_memory_limit, run_memory_limit,
    run_timeout, compile_timeout,
    run_cpu_time, compile_cpu_time,
    env_vars,
  } = body;

  if (!language || typeof language !== 'string') {
    throw { message: 'language is required as a string' };
  }
  if (!version || typeof version !== 'string') {
    throw { message: 'version is required as a string' };
  }
  if (!files || !Array.isArray(files)) {
    throw { message: 'files is required as an array' };
  }
  for (const [i, file] of files.entries()) {
    if (typeof file.content !== 'string' && typeof file.id !== 'string') {
      throw { message: `files[${i}].content is required as a string if no id is provided` };
    }
  }

  const rt = getLatestRuntimeMatchingLanguageVersion(language, version);
  if (!rt) {
    throw { message: `${language}-${version} runtime is unknown` };
  }

  if (
    rt.language !== 'file' &&
    !files.some(file => !file.encoding || file.encoding === 'utf8')
  ) {
    throw { message: 'files must include at least one utf8 encoded file' };
  }

  validateConstraints(body, rt);

  return new Job({
    session_id: session_id ?? null,
    runtime: rt,
    args: args ?? [],
    stdin: stdin ?? '',
    files,
    timeouts: {
      run: run_timeout ?? rt.timeouts.run,
      compile: compile_timeout ?? rt.timeouts.compile,
    },
    cpu_times: {
      run: run_cpu_time ?? rt.cpu_times.run,
      compile: compile_cpu_time ?? rt.cpu_times.compile,
    },
    memory_limits: {
      run: run_memory_limit ?? rt.memory_limits.run,
      compile: compile_memory_limit ?? rt.memory_limits.compile,
    },
    extra_env_vars: sanitizeEnvVars(env_vars),
    output_session_id: body.output_session_id,
    egress_grant: egressGrantToken,
  });
}

function validateConstraints(body: ExecuteRequestBody, rt: Runtime): void {
  const constraints = ['memory_limit', 'timeout', 'cpu_time'] as const;
  const types = ['compile', 'run'] as const;

  for (const constraint of constraints) {
    for (const type of types) {
      const key = `${type}_${constraint}` as keyof ExecuteRequestBody;
      const value = body[key];
      if (value === undefined || value === null) continue;

      if (typeof value !== 'number') {
        throw { message: `If specified, ${key} must be a number` };
      }

      const limitMap: Record<string, Record<string, number>> = {
        memory_limit: rt.memory_limits,
        timeout: rt.timeouts,
        cpu_time: rt.cpu_times,
      };

      const configured = limitMap[constraint]?.[type] ?? 0;
      if (configured <= 0) continue;
      if (value > configured) {
        throw { message: `${key} cannot exceed the configured limit of ${configured}` };
      }
      if (value < 0) {
        throw { message: `${key} must be non-negative` };
      }
    }
  }
}

function manifestErrorStatus(error: ExecutionManifestError): number {
  if (error.reason === 'missing_secret') return 500;
  if (error.reason === 'missing_header') return 401;
  if (error.reason === 'malformed') return 400;
  return 403;
}

router.use((req: Request, res: Response, next: NextFunction) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!req.headers['content-type']?.startsWith('application/json')) {
    return res.status(415).json({ message: 'requests must be of type application/json' });
  }
  next();
});

/** Replay PTC payloads (user code + tool definitions + inlined
 * `_ptc_history.json` + pyplot assets) can far exceed Express's default
 * ~100kb body limit. The parser is installed *here* rather than globally
 * in `index.ts` because a global parser would run before this route and
 * its limit would be the effective cap (see the long comment in
 * `index.ts` for the routing-order rationale). Keep the limit configurable:
 * analyst workflows may send large scripts or replay payloads, while file
 * bytes should still move through the gateway/file path. */
router.post('/execute', express.json({ limit: config.execute_body_limit }), async (req: Request, res: Response) => {
  let job: Job | undefined;
  let cleanedUp = false;

  const cleanupHandler = async (): Promise<void> => {
    if (!job || cleanedUp) return;
    cleanedUp = true;
    await job.cleanup();
  };

  req.on('close', () => { cleanupHandler().catch(err => logger.error({ err }, 'Cleanup handler error')); });

  if (config.require_execution_manifest) {
    try {
      verifyExecuteRequestManifest({
        headerValue: tokenFromBodyOrHeader(req.body, 'execution_manifest', req.header(EXECUTION_MANIFEST_HEADER)),
        publicKey: config.execution_manifest_public_key,
        secret: config.execution_manifest_secret,
        body: req.body,
      });
    } catch (error) {
      if (error instanceof ExecutionManifestError) {
        const status = manifestErrorStatus(error);
        logger.warn({ reason: error.reason, status }, 'Rejected sandbox request by execution manifest');
        return res.status(status).json({ message: error.message });
      }
      logger.error({ err: error }, 'Execution manifest validation failed unexpectedly');
      return res.status(500).json({ message: 'Execution manifest validation failed' });
    }
  }

  try {
    job = getJob(
      req.body,
      tokenFromBodyOrHeader(req.body, 'egress_grant', req.header(EGRESS_GRANT_HEADER) ?? undefined),
    );
  } catch (error) {
    /** Validation paths in `getJob`/`sanitizeEnvVars` may throw either
     * plain `{ message }` objects (the historical shape used by the
     * inline validators above) or proper `Error` instances (used by
     * `sanitizeEnvVars` so callers get a real stack trace and can do
     * `instanceof Error` checks). `res.json(err)` for an `Error` would
     * serialize to `{}` because `message` is a non-enumerable property,
     * dropping the reason on the floor. Normalize both shapes to
     * `{ message }` so the client always sees why the request was
     * rejected. */
    const message = error instanceof Error
      ? error.message
      : (error as { message?: unknown })?.message;
    return res.status(400).json({ message: message || 'Bad request' });
  }

  try {
    await job.prime();
    const result = await job.execute();

    if (result.run === undefined) {
      result.run = result.compile;
    }

    if (result.files && result.files.length > 0) {
      /* Upload returns the set of file IDs that were actually transferred to
       * the file server. Files we minted IDs for but failed to ship (e.g. the
       * EFAULT-from-Bun-fetch incident) are pruned from the response so they
       * never become phantom IDs that the next prime() will hammer with 404
       * retries before giving up. Inherited refs that were inlined from
       * autoLoadDirkeep / unchanged inputs have no `path` and are passed
       * through unchanged — they were never local to upload. */
      const uploaded = await job.uploadGeneratedFiles()
        .catch((err) => {
          logger.error({ job: job!.uuid, err }, 'File upload failed');
          return new Set<string>();
        });

      const generatedIds = new Set(job.getGeneratedFileIds());
      const before = result.files.length;
      result.files = result.files.filter(
        f => !generatedIds.has(f.id) || uploaded.has(f.id),
      );
      const dropped = before - result.files.length;
      if (dropped > 0) {
        logger.warn(
          { job: job.uuid, dropped, kept: result.files.length },
          'Pruned files from response because upload did not reach file_server',
        );
      }
    }

    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof ValidationError) {
      return res.status(400).json({ message: error.message });
    }
    logger.error({ job: job?.uuid, err: error }, 'Error executing job');
    return res.status(500).send();
  } finally {
    await cleanupHandler();
  }
});

router.get('/runtimes', (_req: Request, res: Response) => {
  const runtimes = getRuntimes().map(rt => ({
    language: rt.language,
    version: rt.version.raw,
    aliases: rt.aliases,
    runtime: rt.runtime,
  }));
  return res.status(200).json(runtimes);
});

export default router;
