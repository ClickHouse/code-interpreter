import axios from 'axios';
import busboy from 'busboy';
import { nanoid } from 'nanoid';
import { Router } from 'express';
import type { Response } from 'express';
import type { Readable } from 'stream';
import type * as t from '../types';
import { checkServiceStartUp, checkServiceShutDown } from '../lifecycle';
import { sessionAuth, validateEntityId, validateEntityIdString } from '../middleware/auth';
import { executionLimiter, uploadLimiter, downloadLimiter, fetchLimiter } from '../middleware/limits';
import { internalServiceHeaders } from '../internal-service-auth';
import { resolveSessionKey } from '../session-key';
import { pyQueue, otherQueue, pyQueueEvents, otherQueueEvents, connection } from '../queue';
import { sleep, getAxiosErrorDetails } from '../utils';
import { env, planLimits, resolveLanguage } from '../config';
import { createPayload } from '../payload';
import { maybeBuildExecutionManifestClaims } from '../execution-manifest-claims';
import { jobsSubmitted } from '../metrics';
import { Jobs, Languages } from '../enum';
import { FileRefAuthorizationError, authorizeRequestedFiles } from './file-authorization';
import logger from '../logger';

const { INSTANCE_ID } = env;

const UPLOAD_TIMEOUT_MS = 30_000;
/* Batch cap sized for skill-priming uploads: a single skill (e.g. pptx)
 * can carry 60+ resource files including .xsd schemas, helper scripts,
 * docs, and Python __init__.py markers. The previous cap of 20 silently
 * dropped most files past the limit, surfacing as "missing files" in the
 * caller. */
const MAX_BATCH_FILES = 200;

function validateUploadRequest(req: t.AuthenticatedRequest, res: Response): string | null {
  const userId = (req.apiKey?.userId ?? '').toString();
  if (!userId) {
    res.status(401).json({ error: 'User not found' });
    return null;
  }
  if (req.headers['content-type']?.includes('multipart/form-data') !== true) {
    res.status(400).json({ error: 'Invalid content type. Must be multipart/form-data.' });
    return null;
  }
  if (checkServiceShutDown()) {
    res.status(503).json({ error: 'Service is shutting down' });
    return null;
  }
  if (checkServiceStartUp()) {
    res.status(503).json({ error: 'Service is starting up' });
    return null;
  }
  return userId;
}

function sendFileRefAuthorizationError(
  error: unknown,
  res: Response,
  req?: t.AuthenticatedRequest,
): boolean {
  if (error instanceof FileRefAuthorizationError) {
    const queryEntityId = typeof req?.query?.entity_id === 'string' ? req.query.entity_id : undefined;
    logger.warn('File reference authorization rejected', {
      status: error.status,
      reason: error.reason,
      message: error.message,
      requestUserId: req?.apiKey?.userId?.toString(),
      requestApiKeyId: req?.apiKey?._id?.toString(),
      requestEntityId: queryEntityId,
      tenantId: req?.codeApiAuthContext?.tenantId,
      ...error.context,
    });
    res.status(error.status).json({ error: error.message });
    return true;
  }
  return false;
}

const router = Router();

router.post('/exec', validateEntityId, executionLimiter, async (req: t.AuthenticatedRequest, res) => {
  const apiKeyString = req.header('X-API-Key') ?? '';
  const apiKeyId = (req.apiKey?._id ?? '').toString();
  const userId = (req.apiKey?.userId ?? '').toString();
  if (!userId) {
    return res.status(401).json({ error: 'User not found' });
  }

  if (checkServiceShutDown()) {
    return res.status(503).json({ error: 'Service is shutting down' });
  }

  if (checkServiceStartUp()) {
    return res.status(503).json({ error: 'Service is starting up' });
  }

  const body = req.body as t.RequestBody;
  const { user_id, entity_id, lang: rawLang, code, files } = body;
  const language = resolveLanguage(rawLang);
  if (language == null) {
    return res.status(400).json({ error: `Unsupported language: ${rawLang}` });
  }

  const sessionKey = resolveSessionKey(req, userId, entity_id);
  let authorizedFiles: t.RequestFile[];
  try {
    authorizedFiles = await authorizeRequestedFiles({
      req,
      files,
      userId,
      entityId: entity_id,
      store: connection,
    });
    body.files = authorizedFiles.length > 0 ? authorizedFiles : undefined;
  } catch (error) {
    if (sendFileRefAuthorizationError(error, res, req)) return;
    logger.error(`[${INSTANCE_ID}] Error authorizing file refs:`, error);
    return res.status(500).json({ error: 'Internal server error' });
  }

  const session_id = nanoid();
  const execution_id = nanoid();
  await connection.set(`session:${session_id}`, sessionKey, 'EX', env.SESSION_CACHE_TTL);

  try {
    logger.info('Request received', { userId, apiKeyId, user: user_id, session_id, language, entity_id, files: authorizedFiles, sessionKey });

    const isPyPlot = language === Languages.py && (code.includes('import matplotlib') || code.includes('import seaborn'));
    const payload = createPayload({
      req,
      isPyPlot,
      session_id,
    });
    const executionManifestClaims = maybeBuildExecutionManifestClaims({
      req,
      executionId: execution_id,
      userId,
      sessionKey,
      outputSessionId: session_id,
      payload,
    });

    const queue = language === Languages.py ? pyQueue : otherQueue;
    const queueEvents = language === Languages.py ? pyQueueEvents : otherQueueEvents;

    const job = await queue.add(Jobs.execute, {
      code,
      userId,
      payload,
      apiKeyId,
      isPyPlot,
      apiKeyString,
      executionId: execution_id,
      tenantId: executionManifestClaims?.tenant_id,
      canonicalUserId: executionManifestClaims?.user_id,
      executionManifestClaims,
      SANDBOX_ENDPOINT: env.SANDBOX_ENDPOINT
    }, {
      removeOnComplete: {
        age: 60,
        count: 1,
      },
      removeOnFail: {
        age: 180,
        count: 1,
      },
      attempts: 1,
      jobId: session_id,
    });
    jobsSubmitted.inc({ language });

    req.on('close', async () => {
      try {
        await job.remove();
        logger.info(`[${INSTANCE_ID}] Job ${job.id} removed due to client disconnect`);
      } catch (error) {
        logger.error(`[${INSTANCE_ID}] Error removing job ${job.id} on client disconnect:`, error);
      }
    });

    const result = await job.waitUntilFinished(queueEvents, env.JOB_TIMEOUT);

    logger.info('Execution completed', { session_id, user_id });
    return res.status(200).json(result);
  } catch (error) {
    logger.error(`[${INSTANCE_ID}] Session ID: ${session_id} | User ID: ${user_id} | Error during execution:`, error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/download/:session_id/:fileId', downloadLimiter, sessionAuth, async (req: t.AuthenticatedRequest, res: Response) => {
  const { session_id, fileId } = req.params;

  let exists = 0;
  const uploadKey = `upload:${req.sessionKey}${session_id}${fileId}`;
  for (let i = 0; i < env.MAX_UPLOAD_CHECKS; i++) {
    exists = await connection.exists(uploadKey);
    if (exists === 1) {
      break;
    }
    await sleep(env.MAX_UPLOAD_WAIT);
  }

  if (exists === 0) {
    logger.error(`[${INSTANCE_ID}] Session ID: ${session_id} | File ID: ${fileId} | File not found in cache`);
    return res.status(404).json({
      error: 'File not found',
      details: 'The file may have expired or does not exist'
    });
  }

  try {
    const response = await axios({
      method: 'get',
      url: `${env.FILE_SERVER_URL}/sessions/${session_id}/objects/${fileId}`,
      headers: internalServiceHeaders(),
      responseType: 'stream'
    });

    res.set(response.headers);
    response.data.pipe(res);
  } catch (error) {
    const errorDetails = getAxiosErrorDetails(error);
    logger.error(`[${INSTANCE_ID}] Session ID: ${session_id} | File ID: ${fileId} | Error downloading file:`, errorDetails);

    return res.status(500).json({
      error: 'Error downloading file',
      details: (error as Error).message
    });
  }
});

router.post('/upload', uploadLimiter, async (req: t.AuthenticatedRequest, res: Response) => {
  try {
    const userId = validateUploadRequest(req, res);
    if (userId == null) return;

    const session_id = nanoid();
    let entity_id: string | undefined;
    let readOnly = false;
    let hasResponded = false;

    const planFileSize = planLimits[req.planId ?? '']?.max_file_size ?? planLimits.default.max_file_size;
    /* preservePath keeps subdirectory components in the multipart filename
     * (e.g. `pptx/editing.md`). The busboy 1.x default strips to basename,
     * which collapses skill-file paths and breaks the caller's filename
     * lookups (skill files look "missing" even when uploaded). */
    const bb = busboy({
      headers: req.headers,
      limits: { fileSize: planFileSize },
      preservePath: true,
    });

    const uploadPromises: Promise<t.UploadResult>[] = [];

    bb.on('field', (fieldname: string, val: string) => {
      if (fieldname === 'entity_id') {
        entity_id = val;
      } else if (fieldname === 'read_only') {
        /* `read_only=true` declares these uploads as infrastructure inputs
         * (e.g. skill files) — the sandbox API and downstream callers
         * MUST treat them as never-emit-back artifacts even if sandboxed
         * code modifies the bytes on disk. Persisted as MinIO object
         * metadata downstream so it travels with the file. */
        readOnly = val.toLowerCase() === 'true';
      }
    });

    bb.on('file', (_fieldname: string, file: Readable, info: busboy.FileInfo) => {
      const { filename, mimeType } = info;
      const fileId = nanoid();
      const abortController = new AbortController();

      file.on('limit', () => {
        if (hasResponded) {
          logger.warn(`[${INSTANCE_ID}] Post-process file size limit exceeded: ${filename} | Session: ${session_id}`);
          return;
        }
        hasResponded = true;
        logger.warn(`[${INSTANCE_ID}] File size limit exceeded: ${filename} | Session: ${session_id}`);
        abortController.abort();
        file.resume();
        res.status(413).json({ error: 'File size limit exceeded' });
      });

      const uploadPromise = new Promise<t.UploadResult>((resolve, reject) => {
        const uploadTimeout = setTimeout(() => {
          abortController.abort();
          file.resume();
          reject(new Error('Upload timeout'));
        }, UPLOAD_TIMEOUT_MS);

        if (entity_id != null && !validateEntityIdString(entity_id)) {
          clearTimeout(uploadTimeout);
          file.resume();
          reject(new Error('Invalid entity ID'));
          return;
        }

        const sessionKey = resolveSessionKey(req, userId, entity_id);
        connection.set(`session:${session_id}`, sessionKey, 'EX', env.SESSION_CACHE_TTL);
        logger.info(`[${INSTANCE_ID}] Upload: Session ID: ${session_id} | User ID: ${userId} | Session key: ${sessionKey}`);

        const putHeaders: Record<string, string> = {
          'Content-Type': mimeType,
          /* file-server URL-decodes this header before storing metadata.
           * Encoding here preserves `/` as `%2F` in transit and keeps
           * non-ASCII filenames legal as HTTP header values. */
          'X-Original-Filename': encodeURIComponent(filename),
        };
        if (readOnly) {
          putHeaders['X-Read-Only'] = 'true';
        }
        axios.put<t.UploadResult>(
          `${env.FILE_SERVER_URL}/sessions/${session_id}/objects/${fileId}`,
          file,
          {
            headers: internalServiceHeaders(putHeaders),
            maxBodyLength: planFileSize,
            maxContentLength: planFileSize,
            signal: abortController.signal,
          }
        )
          .then(response => {
            clearTimeout(uploadTimeout);
            resolve(response.data);
          })
          .catch(error => {
            clearTimeout(uploadTimeout);
            reject(error);
          });
      });

      uploadPromises.push(uploadPromise);
    });

    bb.on('error', (error) => {
      if (hasResponded) {
        logger.warn(`[${INSTANCE_ID}] Post-process busboy error for session ${session_id}:`, error);
        return;
      }
      hasResponded = true;
      logger.error(`[${INSTANCE_ID}] Busboy error for session ${session_id}:`, error);
      res.status(500).json({ error: 'Error processing upload' });
    });

    bb.on('finish', async () => {
      if (hasResponded) {
        logger.warn(`[${INSTANCE_ID}] Post-process upload already responded for session ${session_id}`);
        void Promise.allSettled(uploadPromises);
        return;
      }
      hasResponded = true;
      try {
        const results = await Promise.all(uploadPromises);
        res.status(200).json({
          message: 'success',
          session_id,
          files: results,
        });
      } catch (error) {
        logger.error(`[${INSTANCE_ID}] Error uploading files for session ${session_id}:`, error);
        if (!res.headersSent) {
          if (error instanceof Error) {
            if (error.message === 'Upload timeout') {
              res.status(504).json({ error: 'Upload timeout' });
            } else {
              res.status(500).json({ error: 'Error uploading files' });
            }
          } else {
            res.status(500).json({ error: 'Error uploading files' });
          }
        }
      }
    });

    req.pipe(bb);

    req.on('error', (error) => {
      if (hasResponded) {
        logger.warn(`[${INSTANCE_ID}] Post-process request error for session ${session_id}:`, error);
        return;
      }
      hasResponded = true;
      logger.error(`[${INSTANCE_ID}] Request error for session ${session_id}:`, error);
      res.status(500).json({ error: 'Error processing request' });
    });

  } catch (error) {
    logger.error(`[${INSTANCE_ID}] Unexpected upload error:`, error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'An unexpected error occurred' });
    }
  }
});

router.post('/upload/batch', uploadLimiter, async (req: t.AuthenticatedRequest, res: Response) => {
  try {
    const userId = validateUploadRequest(req, res);
    if (userId == null) return;

    const session_id = nanoid();
    let entity_id: string | undefined;
    let readOnly = false;
    let sessionKeySet = false;
    let hasResponded = false;
    let filesLimitReached = false;

    const planFileSize = planLimits[req.planId ?? '']?.max_file_size ?? planLimits.default.max_file_size;
    /* See note on the single-upload busboy above for why preservePath is set. */
    const bb = busboy({
      headers: req.headers,
      limits: { fileSize: planFileSize, files: MAX_BATCH_FILES },
      preservePath: true,
    });

    const uploadPromises: Promise<t.BatchUploadFileResult>[] = [];

    bb.on('field', (fieldname: string, val: string) => {
      if (fieldname === 'entity_id') {
        entity_id = val;
      } else if (fieldname === 'read_only') {
        /* See `/upload` for semantics. The flag applies to every file in
         * this batch — sized for skill priming where all files share the
         * same read-only intent. */
        readOnly = val.toLowerCase() === 'true';
      }
    });

    bb.on('filesLimit', () => {
      filesLimitReached = true;
      logger.warn(`[${INSTANCE_ID}] Batch upload files limit reached (${MAX_BATCH_FILES}) for session ${session_id}`);
    });

    bb.on('file', (_fieldname: string, file: Readable, info: busboy.FileInfo) => {
      const { filename, mimeType } = info;
      const fileId = nanoid();
      const abortController = new AbortController();

      file.on('limit', () => {
        logger.warn(`[${INSTANCE_ID}] Batch upload file size limit exceeded: ${filename} | Session: ${session_id}`);
        abortController.abort('size_limit');
        file.resume();
      });

      const uploadPromise = new Promise<t.BatchUploadFileResult>((resolve) => {
        /** If abort('size_limit') fires first, its microtask-queued .catch resolves the promise and clears this timeout before it can fire. */
        const uploadTimeout = setTimeout(() => {
          abortController.abort('timeout');
          file.resume();
          resolve({ status: 'error', filename, error: 'Upload timeout' });
        }, UPLOAD_TIMEOUT_MS);

        if (entity_id != null && !validateEntityIdString(entity_id)) {
          clearTimeout(uploadTimeout);
          file.resume();
          resolve({ status: 'error', filename, error: 'Invalid entity ID' });
          return;
        }

        const sessionKey = resolveSessionKey(req, userId, entity_id);
        if (!sessionKeySet) {
          connection.set(`session:${session_id}`, sessionKey, 'EX', env.SESSION_CACHE_TTL);
          sessionKeySet = true;
          logger.info(`[${INSTANCE_ID}] Batch upload: Session ID: ${session_id} | User ID: ${userId} | Session key: ${sessionKey}`);
        }

        const putHeaders: Record<string, string> = {
          'Content-Type': mimeType,
          /* file-server URL-decodes this header before storing metadata.
           * Encoding here preserves `/` as `%2F` in transit and keeps
           * non-ASCII filenames legal as HTTP header values. */
          'X-Original-Filename': encodeURIComponent(filename),
        };
        if (readOnly) {
          putHeaders['X-Read-Only'] = 'true';
        }
        axios.put<t.UploadResult>(
          `${env.FILE_SERVER_URL}/sessions/${session_id}/objects/${fileId}`,
          file,
          {
            headers: internalServiceHeaders(putHeaders),
            maxBodyLength: planFileSize,
            maxContentLength: planFileSize,
            signal: abortController.signal,
          }
        )
          .then(response => {
            clearTimeout(uploadTimeout);
            resolve({ status: 'success', filename: response.data.filename, fileId: response.data.fileId });
          })
          .catch(error => {
            clearTimeout(uploadTimeout);
            if (abortController.signal.aborted) {
              const reason = abortController.signal.reason === 'timeout' ? 'Upload timeout' : 'File size limit exceeded';
              resolve({ status: 'error', filename, error: reason });
              return;
            }
            const message = error instanceof Error ? error.message : 'Unknown upload error';
            logger.error(`[${INSTANCE_ID}] Batch upload file failed: ${filename} | Session: ${session_id}`, { error: message });
            resolve({ status: 'error', filename, error: message });
          });
      });

      uploadPromises.push(uploadPromise);
    });

    bb.on('error', (error) => {
      if (hasResponded) {
        logger.warn(`[${INSTANCE_ID}] Post-process busboy error for batch session ${session_id}:`, error);
        return;
      }
      hasResponded = true;
      logger.error(`[${INSTANCE_ID}] Busboy error for batch session ${session_id}:`, error);
      res.status(500).json({ error: 'Error processing upload' });
    });

    bb.on('finish', async () => {
      if (hasResponded) {
        logger.warn(`[${INSTANCE_ID}] Post-process batch upload already responded for session ${session_id}`);
        return;
      }
      hasResponded = true;

      try {
        const results = await Promise.all(uploadPromises);

        if (results.length === 0) {
          res.status(400).json({ error: 'No files provided' });
          return;
        }

        if (entity_id != null && validateEntityIdString(entity_id)) {
          connection.set(`session:${session_id}`, resolveSessionKey(req, userId, entity_id), 'EX', env.SESSION_CACHE_TTL);
        }

        let succeeded = 0;
        let failed = 0;
        for (const r of results) {
          if (r.status === 'success') succeeded++;
          else failed++;
        }

        let message: t.BatchUploadResponse['message'];
        if (failed === 0) message = 'success';
        else if (succeeded === 0) message = 'error';
        else message = 'partial_success';

        const statusCode = message === 'error' ? 400 : 200;
        const response: t.BatchUploadResponse = {
          message,
          session_id,
          files: results,
          succeeded,
          failed,
          ...(filesLimitReached ? { filesLimitReached: true, maxFiles: MAX_BATCH_FILES } : {}),
        };
        res.status(statusCode).json(response);
      } catch (error) {
        logger.error(`[${INSTANCE_ID}] Error in batch upload finish for session ${session_id}:`, error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Error processing batch upload' });
        }
      }
    });

    req.pipe(bb);

    req.on('error', (error) => {
      if (hasResponded) {
        logger.warn(`[${INSTANCE_ID}] Post-process request error for batch session ${session_id}:`, error);
        return;
      }
      hasResponded = true;
      logger.error(`[${INSTANCE_ID}] Request error for batch session ${session_id}:`, error);
      res.status(500).json({ error: 'Error processing request' });
    });

  } catch (error) {
    logger.error(`[${INSTANCE_ID}] Unexpected batch upload error:`, error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'An unexpected error occurred' });
    }
  }
});

router.get('/files/:session_id', fetchLimiter, validateEntityId, sessionAuth, async (req: t.AuthenticatedRequest, res: Response) => {
  const { session_id } = req.params;
  const { detail = 'simple' } = req.query;

  try {
    const response = await axios.get(`${env.FILE_SERVER_URL}/sessions/${session_id}/objects`, {
      params: { detail },
      headers: internalServiceHeaders({ 'Accept': 'application/json' })
    });

    return res.status(200).json(response.data);
  } catch (error) {
    const errorDetails = getAxiosErrorDetails(error);
    logger.error(`[${INSTANCE_ID}] Error fetching file info for session ${session_id}:`, errorDetails);
    return res.status(500).json({
      error: 'Error fetching file information',
    });
  }
});

/**
 * Single-file metadata lookup for caller-side freshness checks.
 * LibreChat's `primeSkillFiles` reads `lastModified` from this response
 * to decide whether a previously-uploaded skill bundle is still alive
 * in the sandbox or needs to be re-uploaded. Without this route on the
 * public service-api, that freshness GET 404s and every priming call
 * falls through to a fresh upload (massive egress at scale).
 *
 * Proxies the file-server's `/metadata` variant — which returns
 * `{ lastModified, size, etag, ... }` from `minioClient.statObject` —
 * authenticated by `sessionAuth` so the requester must own the
 * `(session_id, entity_id)` pair the file was stored under.
 */
router.get('/sessions/:session_id/objects/:fileId', fetchLimiter, validateEntityId, sessionAuth, async (req: t.AuthenticatedRequest, res: Response) => {
  const { session_id, fileId } = req.params;

  try {
    const response = await axios.get(
      `${env.FILE_SERVER_URL}/sessions/${session_id}/objects/${fileId}/metadata`,
      { headers: internalServiceHeaders({ Accept: 'application/json' }) },
    );

    return res.status(200).json(response.data);
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      return res.status(404).json({ error: 'File not found' });
    }
    const errorDetails = getAxiosErrorDetails(error);
    logger.error(
      `[${INSTANCE_ID}] Error fetching object metadata - Session ID: ${session_id} | File ID: ${fileId}:`,
      errorDetails,
    );
    return res.status(500).json({ error: 'Error fetching object metadata' });
  }
});

router.delete('/files/:session_id/:fileId', fetchLimiter, validateEntityId, sessionAuth, async (req: t.AuthenticatedRequest, res: Response) => {
  const { session_id, fileId } = req.params;

  try {
    const response = await axios.delete(
      `${env.FILE_SERVER_URL}/sessions/${session_id}/objects/${fileId}`,
      { headers: internalServiceHeaders() }
    );

    await connection.del(`upload:${req.sessionKey}${session_id}${fileId}`);
    logger.info(`[${INSTANCE_ID}] File deleted: Session ID: ${session_id} | File ID: ${fileId}`);
    return res.status(200).json(response.data);
  } catch (error) {
    const errorDetails = getAxiosErrorDetails(error);
    logger.error(`[${INSTANCE_ID}] Error deleting file - Session ID: ${session_id} | File ID: ${fileId}:`, errorDetails);
    return res.status(500).json({
      error: 'Error deleting file',
    });
  }
});

export default router;
