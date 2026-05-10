import crypto from 'crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { Readable } from 'stream';
import { env } from './config';
import {
  EGRESS_GRANT_HEADER,
  EgressGrantError,
  openEgressGrant,
  openPtcCallbackToken,
  sealEgressHandle,
  type EgressGrantClaims,
} from './egress-grant';
import { openEgressRouteHandle } from './egress-route-params';
import { internalServiceHeaders } from './internal-service-auth';
import { metricsHandler } from './metrics';
import { isValidId } from './utils';
import logger from './logger';
import { parseBoundedContentLength } from './http-limits';

export const app: Express = express();
app.disable('x-powered-by');

type EgressAuditFields = {
  execHash?: string;
  requestExecHash?: string;
  tenantHash?: string;
  userHash?: string;
  authContextHash?: string;
  principalSource?: string;
};

function routeFamily(req: Request): string {
  if (req.path === '/health' || req.path === '/ready' || req.path === '/metrics') return req.path.slice(1);
  if (req.path === '/tool-call') return 'ptc-tool-call';
  if (req.path.startsWith('/sessions/')) {
    if (req.method === 'PUT') return 'file-upload';
    if (req.method === 'GET' && req.path.includes('/objects/')) return 'file-download';
    if (req.method === 'GET' && req.path.endsWith('/objects')) return 'file-list';
    return 'file-unknown';
  }
  return 'unknown';
}

function requestId(res: Response): string | undefined {
  return res.locals.egressRequestId as string | undefined;
}

function hashLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return crypto.createHash('sha256').update(value, 'utf8').digest('base64url').slice(0, 16);
}

function auditFields(res: Response): EgressAuditFields {
  return (res.locals.egressAuditFields as EgressAuditFields | undefined) ?? {};
}

function setGrantAudit(res: Response, grant: EgressGrantClaims): void {
  res.locals.egressAuditFields = {
    execHash: hashLabel(grant.exec_id),
    tenantHash: hashLabel(grant.tenant_id),
    userHash: hashLabel(grant.user_id),
    authContextHash: hashLabel(grant.auth_context_hash),
    ...(grant.principal_source ? { principalSource: grant.principal_source } : {}),
  };
}

function setPtcAudit(res: Response, args: { callbackExecId: string; requestExecId: string }): void {
  res.locals.egressAuditFields = {
    execHash: hashLabel(args.callbackExecId),
    requestExecHash: hashLabel(args.requestExecId),
  };
}

app.use((req: Request, res: Response, next: NextFunction) => {
  const started = Date.now();
  const id = req.header('x-request-id') ?? crypto.randomUUID();
  res.locals.egressRequestId = id;
  res.setHeader('X-Request-ID', id);

  res.on('finish', () => {
    if (req.path === '/health' || req.path === '/ready' || req.path === '/metrics') return;
    logger.info('Egress gateway request completed', {
      requestId: id,
      method: req.method,
      route: routeFamily(req),
      statusCode: res.statusCode,
      durationMs: Date.now() - started,
      contentLength: req.header('content-length'),
      ...auditFields(res),
    });
  });

  next();
});

function errorStatus(error: EgressGrantError): number {
  if (error.reason === 'missing_secret' || error.reason === 'weak_secret') return 500;
  if (error.reason === 'malformed') return 400;
  if (error.reason === 'expired') return 401;
  return 403;
}

function sendEgressError(req: Request, res: Response, error: unknown): Response {
  if (error instanceof EgressGrantError) {
    const statusCode = errorStatus(error);
    logger.warn('Rejected egress gateway request', {
      requestId: requestId(res),
      reason: error.reason,
      method: req.method,
      route: routeFamily(req),
      statusCode,
      ...auditFields(res),
    });
    return res.status(statusCode).json({ error: error.message });
  }
  logger.error('Egress gateway request failed', {
    requestId: requestId(res),
    method: req.method,
    route: routeFamily(req),
    error,
    ...auditFields(res),
  });
  return res.status(500).json({ error: 'Internal server error' });
}

function getGrant(req: Request, res: Response): EgressGrantClaims {
  const token = req.header(EGRESS_GRANT_HEADER);
  if (!token) {
    throw new EgressGrantError('malformed', `${EGRESS_GRANT_HEADER} is required`);
  }
  const grant = openEgressGrant(token, env.EGRESS_GRANT_SECRET);
  setGrantAudit(res, grant);
  return grant;
}

function isDirkeepName(name: string): boolean {
  return name === '.dirkeep' || name.endsWith('/.dirkeep');
}

function assertGrantSession(grant: EgressGrantClaims, sessionId: string, direction: 'read' | 'write'): void {
  if (direction === 'read') {
    if (!grant.read_sessions.includes(sessionId)) {
      throw new EgressGrantError('scope_mismatch', 'Read session is outside the egress grant scope');
    }
    return;
  }
  if (grant.output_session_id !== sessionId) {
    throw new EgressGrantError('scope_mismatch', 'Write session is outside the egress grant scope');
  }
}

function openSessionParam(raw: string, grant: EgressGrantClaims, direction: 'read' | 'write'): string {
  const handle = openEgressRouteHandle(raw, env.EGRESS_GRANT_SECRET);
  if (handle.typ !== 'session' || handle.dir !== direction) {
    throw new EgressGrantError('wrong_type', `Expected an egress ${direction} session handle`);
  }
  if (handle.exec_id !== grant.exec_id) {
    throw new EgressGrantError('scope_mismatch', 'Session handle execution does not match grant');
  }
  assertGrantSession(grant, handle.session_id, direction);
  return handle.session_id;
}

function inputFileSet(grant: EgressGrantClaims): Set<string> {
  return new Set(grant.input_files.map(file => `${file.session_id}\0${file.id}`));
}

function openObjectParam(raw: string, grant: EgressGrantClaims, sessionId: string): { id: string; name: string } {
  const handle = openEgressRouteHandle(raw, env.EGRESS_GRANT_SECRET);
  if (handle.typ !== 'object') {
    throw new EgressGrantError('wrong_type', 'Expected an egress object handle');
  }
  if (handle.exec_id !== grant.exec_id || handle.session_id !== sessionId) {
    throw new EgressGrantError('scope_mismatch', 'Object handle does not match grant/session');
  }
  const allowed = inputFileSet(grant).has(`${handle.session_id}\0${handle.object_id}`);
  if (!allowed && !isDirkeepName(handle.name)) {
    throw new EgressGrantError('scope_mismatch', 'Object handle is outside the egress grant file scope');
  }
  return { id: handle.object_id, name: handle.name };
}

function responseHeaders(fetchResponse: globalThis.Response): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of fetchResponse.headers.entries()) {
    if (['connection', 'keep-alive', 'transfer-encoding'].includes(key.toLowerCase())) continue;
    headers[key] = value;
  }
  return headers;
}

function pipeFetchResponse(fetchResponse: globalThis.Response, res: Response): void {
  res.status(fetchResponse.status);
  res.set(responseHeaders(fetchResponse));
  if (!fetchResponse.body) {
    res.end();
    return;
  }
  Readable.fromWeb(fetchResponse.body as unknown as import('stream/web').ReadableStream).pipe(res);
}

function forwardUrl(base: string, path: string, search = ''): string {
  return `${base.replace(/\/+$/, '')}${path}${search}`;
}

app.get('/health', (_req, res) => res.sendStatus(200));
app.get('/ready', (_req, res) => res.sendStatus(200));
app.get('/metrics', metricsHandler);

app.get('/sessions/:sessionHandle/objects', async (req, res) => {
  try {
    if (Object.keys(req.query).some(key => key !== 'detail') || req.query.detail !== 'normalized') {
      return res.status(400).json({ error: 'Only detail=normalized object listings are supported' });
    }
    const grant = getGrant(req, res);
    const sessionId = openSessionParam(req.params.sessionHandle, grant, 'read');
    const upstream = await fetch(
      forwardUrl(
        env.EGRESS_GATEWAY_FILE_SERVER_URL,
        `/sessions/${encodeURIComponent(sessionId)}/objects`,
        '?detail=normalized',
      ),
      { headers: internalServiceHeaders({ Accept: 'application/json' }) },
    );
    if (!upstream.ok) {
      return pipeFetchResponse(upstream, res);
    }
    const data: unknown = await upstream.json();
    if (!Array.isArray(data)) {
      return res.status(502).json({ error: 'Invalid file-server object listing' });
    }

    const allowed = inputFileSet(grant);
    const now = Math.floor(Date.now() / 1000);
    const normalized = data
      .filter((obj): obj is { id: string; name: string; storage_session_id: string } => (
        obj != null &&
        typeof obj === 'object' &&
        typeof (obj as { id?: unknown }).id === 'string' &&
        typeof (obj as { name?: unknown }).name === 'string' &&
        typeof (obj as { storage_session_id?: unknown }).storage_session_id === 'string' &&
        (obj as { storage_session_id: string }).storage_session_id === sessionId
      ))
      .filter(obj => allowed.has(`${obj.storage_session_id}\0${obj.id}`) || isDirkeepName(obj.name))
      .map(obj => ({
        ...obj,
        storage_session_id: req.params.sessionHandle,
        id: sealEgressHandle({
          typ: 'object',
          dir: 'read',
          exec_id: grant.exec_id,
          session_id: obj.storage_session_id,
          object_id: obj.id,
          name: obj.name,
          iat: now,
          exp: grant.exp,
        }, env.EGRESS_GRANT_SECRET),
      }));

    return res.status(200).json(normalized);
  } catch (error) {
    return sendEgressError(req, res, error);
  }
});

app.get('/sessions/:sessionHandle/objects/:objectHandle', async (req, res) => {
  try {
    if (Object.keys(req.query).length > 0) {
      return res.status(400).json({ error: 'Object download query parameters are not supported' });
    }
    const grant = getGrant(req, res);
    const sessionId = openSessionParam(req.params.sessionHandle, grant, 'read');
    const object = openObjectParam(req.params.objectHandle, grant, sessionId);
    const upstream = await fetch(
      forwardUrl(
        env.EGRESS_GATEWAY_FILE_SERVER_URL,
        `/sessions/${encodeURIComponent(sessionId)}/objects/${encodeURIComponent(object.id)}`,
      ),
      { headers: internalServiceHeaders() },
    );
    return pipeFetchResponse(upstream, res);
  } catch (error) {
    return sendEgressError(req, res, error);
  }
});

app.put('/sessions/:sessionHandle/objects/:fileId', async (req, res) => {
  try {
    if (Object.keys(req.query).length > 0) {
      return res.status(400).json({ error: 'Object upload query parameters are not supported' });
    }
    const grant = getGrant(req, res);
    const sessionId = openSessionParam(req.params.sessionHandle, grant, 'write');
    const fileId = req.params.fileId;
    if (!isValidId(fileId)) {
      return res.status(400).json({ error: 'Invalid output file id' });
    }
    const parsedLength = parseBoundedContentLength(
      req.header('content-length'),
      grant.max_upload_bytes,
      'Upload exceeds grant byte limit',
    );
    if (!parsedLength.ok) {
      return res.status(parsedLength.status).json({ error: parsedLength.error });
    }
    const contentLength = parsedLength.length;
    const originalFilename = req.header('x-original-filename');
    if (!originalFilename) {
      return res.status(400).json({ error: 'X-Original-Filename is required' });
    }
    const headers = internalServiceHeaders({
      'Content-Type': req.header('content-type') ?? 'application/octet-stream',
      'Content-Length': String(contentLength),
      'X-Original-Filename': originalFilename,
    });
    const upstream = await fetch(
      forwardUrl(
        env.EGRESS_GATEWAY_FILE_SERVER_URL,
        `/sessions/${encodeURIComponent(sessionId)}/objects/${encodeURIComponent(fileId)}`,
      ),
      {
        method: 'PUT',
        headers,
        body: req as unknown as BodyInit,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' },
    );
    return pipeFetchResponse(upstream, res);
  } catch (error) {
    return sendEgressError(req, res, error);
  }
});

app.post('/tool-call', async (req, res) => {
  try {
    const executionId = req.header('x-execution-id') ?? '';
    const callId = req.header('x-tool-call-id') ?? '';
    const opaqueCallbackToken = req.header('x-callback-token') ?? '';
    if (!executionId || !callId || !opaqueCallbackToken) {
      return res.status(400).json({ error: 'Missing required PTC headers' });
    }
    const parsedLength = parseBoundedContentLength(
      req.header('content-length'),
      env.EGRESS_GATEWAY_MAX_TOOL_CALL_BYTES,
      'Tool call body exceeds gateway limit',
    );
    if (!parsedLength.ok) {
      return res.status(parsedLength.status).json({ error: parsedLength.error });
    }
    const length = parsedLength.length;
    const callback = openPtcCallbackToken(opaqueCallbackToken, env.EGRESS_GRANT_SECRET);
    setPtcAudit(res, { callbackExecId: callback.exec_id, requestExecId: executionId });
    if (callback.exec_id !== executionId) {
      throw new EgressGrantError('scope_mismatch', 'PTC callback token execution does not match request');
    }
    const upstream = await fetch(forwardUrl(env.EGRESS_GATEWAY_TOOL_CALL_SERVER_URL, '/tool-call'), {
      method: 'POST',
      headers: {
        'Content-Type': req.header('content-type') ?? 'application/json',
        'Content-Length': String(length),
        'X-Execution-ID': executionId,
        'X-Callback-Token': callback.callback_token,
        'X-Tool-Call-ID': callId,
      },
      body: req as unknown as BodyInit,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    return pipeFetchResponse(upstream, res);
  } catch (error) {
    return sendEgressError(req, res, error);
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

if (process.env.CODEAPI_EGRESS_GATEWAY_AUTOSTART !== 'false') {
  app.listen(env.EGRESS_GATEWAY_PORT, () => {
    logger.info(`Egress gateway listening on port ${env.EGRESS_GATEWAY_PORT}`);
  });
}
