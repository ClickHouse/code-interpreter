import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type net from 'node:net';

export interface ToolCallSocketProxyOptions {
  socketPath: string;
  rawTarget: string;
  maxConnections?: number;
  maxActiveRequests?: number;
  idleSocketTimeoutMs?: number;
  requestBodyTimeoutMs?: number;
  activeRequestTimeoutMs?: number;
  maxBodyBytes?: number;
  listenBacklog?: number;
  socketUid?: number;
  socketGid?: number;
  socketMode?: number;
  log?: Pick<typeof console, 'error' | 'log' | 'warn'>;
}

export interface ToolCallSocketProxyHandle {
  server: http.Server;
  close: () => Promise<void>;
  activeConnections: () => number;
  activeRequests: () => number;
  activeUpstreams: () => number;
}

const DEFAULT_MAX_CONNECTIONS = 64;
const DEFAULT_MAX_ACTIVE_REQUESTS = 16;
const DEFAULT_IDLE_SOCKET_TIMEOUT_MS = 2_000;
const DEFAULT_REQUEST_BODY_TIMEOUT_MS = 5_000;
const DEFAULT_ACTIVE_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_LISTEN_BACKLOG = 16;
const MAX_DEFAULT_CONNECTIONS = 256;
const MAX_DEFAULT_ACTIVE_REQUESTS = 64;
const ACTIVE_REQUEST_TIMEOUT_GRACE_MS = 5_000;
const MAX_DEFAULT_ACTIVE_REQUEST_TIMEOUT_MS = 60_000;

function normalizeTarget(rawTarget: string): URL {
  if (!rawTarget) {
    throw new Error('SANDBOX_FORWARD_TARGET is required');
  }
  return new URL(rawTarget.includes('://') ? rawTarget : `http://${rawTarget}`);
}

function destroySocket(socket: net.Socket): void {
  socket.destroy();
}

/* RFC 7230 §6.1 hop-by-hop headers. A proxy MUST NOT forward these to the
 * upstream — they describe the proxy<->client connection, not the request.
 * `host` is rewritten separately to point at the upstream. Forwarding the
 * client's `host` would let a malicious sandbox steer the upstream's
 * routing if it ever virtual-hosts. */
const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

function buildForwardedHeaders(
  reqHeaders: http.IncomingHttpHeaders,
  upstreamHost: string,
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(reqHeaders)) {
    if (HOP_BY_HOP_HEADERS.has(k.toLowerCase())) continue;
    if (v == null) continue;
    out[k] = v;
  }
  /* Set our own connection-management headers; the proxy never keep-alives
   * to upstream because each request is one-shot. */
  out.host = upstreamHost;
  out.connection = 'close';
  return out;
}

/* Request smuggling defense (CVE class). When a request carries BOTH
 * Transfer-Encoding and Content-Length, an upstream may pick the
 * different one than the proxy did, letting an attacker prepend bytes
 * to a synthesized "second request" that bypasses the proxy's path
 * filter. The fix per RFC 7230 §3.3.3 is to reject the request rather
 * than try to reconcile. */
function isSmugglingShaped(headers: http.IncomingHttpHeaders): boolean {
  const hasCL = headers['content-length'] != null;
  const hasTE = headers['transfer-encoding'] != null;
  return hasCL && hasTE;
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw == null) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return undefined;
  return Math.floor(n);
}

function defaultMaxConnections(): number {
  const maxConcurrentJobs = parsePositiveInt(process.env.SANDBOX_MAX_CONCURRENT_JOBS);
  if (maxConcurrentJobs == null) return DEFAULT_MAX_CONNECTIONS;
  return Math.min(Math.max(maxConcurrentJobs * 4, DEFAULT_MAX_CONNECTIONS), MAX_DEFAULT_CONNECTIONS);
}

function defaultMaxActiveRequests(): number {
  const maxConcurrentJobs = parsePositiveInt(process.env.SANDBOX_MAX_CONCURRENT_JOBS);
  if (maxConcurrentJobs == null) return DEFAULT_MAX_ACTIVE_REQUESTS;
  return Math.min(Math.max(maxConcurrentJobs, DEFAULT_MAX_ACTIVE_REQUESTS), MAX_DEFAULT_ACTIVE_REQUESTS);
}

function defaultActiveRequestTimeoutMs(): number {
  const runTimeoutMs = parsePositiveInt(process.env.SANDBOX_RUN_TIMEOUT);
  if (runTimeoutMs == null) return DEFAULT_ACTIVE_REQUEST_TIMEOUT_MS;
  return Math.min(
    Math.max(runTimeoutMs + ACTIVE_REQUEST_TIMEOUT_GRACE_MS, DEFAULT_REQUEST_BODY_TIMEOUT_MS),
    MAX_DEFAULT_ACTIVE_REQUEST_TIMEOUT_MS,
  );
}

export async function startToolCallSocketProxy(
  opts: ToolCallSocketProxyOptions,
): Promise<ToolCallSocketProxyHandle> {
  const log = opts.log ?? console;
  const socketPath = opts.socketPath;
  const target = normalizeTarget(opts.rawTarget);
  const transport = target.protocol === 'https:' ? https : http;
  const maxConnections = opts.maxConnections ?? defaultMaxConnections();
  const maxActiveRequests = opts.maxActiveRequests ?? defaultMaxActiveRequests();
  const idleSocketTimeoutMs = opts.idleSocketTimeoutMs ?? DEFAULT_IDLE_SOCKET_TIMEOUT_MS;
  const requestBodyTimeoutMs = opts.requestBodyTimeoutMs ?? DEFAULT_REQUEST_BODY_TIMEOUT_MS;
  const activeRequestTimeoutMs = opts.activeRequestTimeoutMs ?? defaultActiveRequestTimeoutMs();
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const listenBacklog = opts.listenBacklog ?? DEFAULT_LISTEN_BACKLOG;
  // The socket is intentionally connectable by sandbox jobs even when
  // SANDBOX_PER_JOB_UIDS maps each job to a distinct outside UID. Abuse is
  // bounded by the proxy's connection caps/timeouts, not by inode ownership.
  const socketMode = opts.socketMode ?? 0o666;

  const activeSockets = new Set<net.Socket>();
  let activeRequests = 0;
  let activeUpstreams = 0;

  const server = http.createServer((req, res) => {
    const socket = req.socket;
    socket.setTimeout(requestBodyTimeoutMs, () => destroySocket(socket));
    req.setTimeout(requestBodyTimeoutMs, () => destroySocket(socket));
    res.setHeader('Connection', 'close');

    res.on('finish', () => {
      socket.end();
    });

    if (req.method !== 'POST' || req.url !== '/tool-call') {
      req.resume();
      res.writeHead(404, { 'Content-Type': 'text/plain', Connection: 'close' });
      res.end('not found');
      return;
    }

    /* Smuggling defense — block before we do anything else with the
     * request so neither our active-request budget nor any upstream
     * connection is consumed. */
    if (isSmugglingShaped(req.headers)) {
      req.resume();
      res.writeHead(400, { 'Content-Type': 'text/plain', Connection: 'close' });
      res.end('ambiguous Content-Length and Transfer-Encoding');
      return;
    }

    /* Content-Length precheck — if the client honestly declares a body
     * larger than maxBodyBytes, reject BEFORE opening an upstream and
     * BEFORE leaking any of those bytes through req.pipe(upstream). The
     * runtime byte counter below is the second line of defense for
     * chunked uploads and dishonest CL values, but this gate handles
     * the common case cleanly. */
    const declaredCL = Number(req.headers['content-length'] ?? '0');
    if (Number.isFinite(declaredCL) && declaredCL > maxBodyBytes) {
      req.resume();
      res.writeHead(413, { 'Content-Type': 'text/plain', Connection: 'close' });
      res.end('request body too large');
      return;
    }

    if (activeRequests >= maxActiveRequests) {
      req.resume();
      res.writeHead(429, {
        'Content-Type': 'application/json',
        Connection: 'close',
        'Retry-After': '1',
      });
      res.end(JSON.stringify({
        success: false,
        error: 'Too many concurrent tool-call requests',
      }));
      return;
    }

    activeRequests += 1;
    let releasedActiveRequest = false;
    const releaseActiveRequest = (): void => {
      if (releasedActiveRequest) return;
      releasedActiveRequest = true;
      activeRequests = Math.max(0, activeRequests - 1);
    };
    res.on('finish', releaseActiveRequest);
    res.on('close', releaseActiveRequest);

    let bodyBytes = 0;
    let rejected = false;
    let upstreamClosed = false;

    /* Absolute body-upload deadline. socket.setTimeout / req.setTimeout
     * are idle timers and reset on every byte, so a malicious client
     * dripping bytes just under the idle threshold (slow-loris) bypasses
     * them. Node's `server.requestTimeout` was meant to bound this but
     * empirically does NOT fire mid-body for unix-socket clients in
     * Node 22 (probed; drip kept flowing past 3x the configured value).
     * This explicit setTimeout fires unconditionally `requestBodyTimeoutMs`
     * after the request handler runs and is cleared once the body is
     * fully received. */
    const bodyUploadDeadline = setTimeout(() => {
      if (req.complete || rejected) return;
      destroySocket(socket);
    }, requestBodyTimeoutMs);
    const clearBodyUploadDeadline = (): void => clearTimeout(bodyUploadDeadline);
    req.on('end', clearBodyUploadDeadline);
    req.on('aborted', clearBodyUploadDeadline);
    res.on('finish', clearBodyUploadDeadline);
    res.on('close', clearBodyUploadDeadline);

    req.on('end', () => {
      socket.setTimeout(activeRequestTimeoutMs, () => destroySocket(socket));
    });

    /* BUFFER then forward — do NOT open upstream or pipe bytes until the
     * full body is received. Streaming would let a slow-loris that drips
     * body bytes pin an UPSTREAM connection slot for the entire body-
     * upload window, even though the proxy itself bounds its own socket
     * lifetime. Tool-call payloads are small JSON (capped at maxBodyBytes,
     * default 1 MiB), so buffering is cheap and the security property
     * "upstream never sees a partial request" is much stronger. */
    const bodyChunks: Buffer[] = [];
    let upstream: http.ClientRequest | undefined;
    const abortUpstream = (): void => {
      if (!upstream || upstreamClosed || res.writableEnded) return;
      upstream.destroy(new Error('tool-call client disconnected'));
    };
    req.on('aborted', abortUpstream);
    res.on('close', abortUpstream);
    socket.on('close', abortUpstream);

    req.on('data', chunk => {
      if (rejected) return;
      bodyBytes += chunk.length;
      if (bodyBytes > maxBodyBytes) {
        rejected = true;
        res.writeHead(413, { 'Content-Type': 'text/plain', Connection: 'close' });
        res.end('request body too large');
        destroySocket(socket);
        return;
      }
      bodyChunks.push(Buffer.from(chunk));
    });

    req.on('end', () => {
      if (rejected) return;
      const body = bodyChunks.length === 1 ? bodyChunks[0] : Buffer.concat(bodyChunks);

      /* Strip ALL hop-by-hop headers before forwarding (RFC 7230 §6.1).
       * Previously we only stripped `proxy-connection`, which left
       * Upgrade, TE, Trailer, and friends as a vector for protocol
       * confusion at the upstream. */
      const headers = buildForwardedHeaders(req.headers, target.host);
      /* Override declared content-length with the actual buffered size
       * — if the client lied, what we send is what we have. */
      headers['content-length'] = body.length;

      upstream = transport.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        method: 'POST',
        path: '/tool-call',
        headers,
      }, upstreamRes => {
        if (rejected) {
          upstreamRes.resume();
          return;
        }
        /* Also strip hop-by-hop on the response path. Upstream's
         * Connection / Keep-Alive / Upgrade headers describe the proxy
         * <-> upstream link, not what we should tell the sandbox client. */
        const respHeaders: http.OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(upstreamRes.headers)) {
          if (HOP_BY_HOP_HEADERS.has(k.toLowerCase())) continue;
          if (v == null) continue;
          respHeaders[k] = v;
        }
        respHeaders.Connection = 'close';
        res.writeHead(upstreamRes.statusCode || 502, respHeaders);
        upstreamRes.pipe(res);
      });
      activeUpstreams += 1;

      upstream.on('close', () => {
        upstreamClosed = true;
        activeUpstreams = Math.max(0, activeUpstreams - 1);
        releaseActiveRequest();
      });

      upstream.setTimeout(activeRequestTimeoutMs, () => {
        upstream?.destroy(new Error('tool-call upstream timeout'));
      });

      upstream.on('error', error => {
        if (rejected) return;
        log.error('tool-call socket proxy upstream error', error);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain', Connection: 'close' });
        }
        res.end('bad gateway');
      });

      upstream.end(body);
    });
  });

  server.maxConnections = maxConnections;
  server.headersTimeout = idleSocketTimeoutMs;
  server.keepAliveTimeout = 1;
  /* Bound the entire request reception (first byte -> last body byte) to
   * the body-upload window. Prevents slow-loris drip attacks: socket-idle
   * timers reset on every byte, so a malicious client could otherwise
   * stretch body upload to activeRequestTimeoutMs (default 30s) by
   * sending one byte just under the idle threshold. */
  server.requestTimeout = requestBodyTimeoutMs;
  server.timeout = activeRequestTimeoutMs;

  server.on('connection', socket => {
    if (activeSockets.size >= maxConnections) {
      log.warn('tool-call socket proxy connection limit reached; dropping connection');
      destroySocket(socket);
      return;
    }

    activeSockets.add(socket);
    socket.setTimeout(idleSocketTimeoutMs, () => destroySocket(socket));
    socket.on('close', () => {
      activeSockets.delete(socket);
    });
    socket.on('error', () => {
      activeSockets.delete(socket);
    });
  });

  server.on('clientError', (_error, socket) => {
    destroySocket(socket as net.Socket);
  });

  try {
    fs.unlinkSync(socketPath);
  } catch {
    // Missing stale socket is fine.
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      if (opts.socketUid != null && opts.socketGid != null) {
        fs.chownSync(socketPath, opts.socketUid, opts.socketGid);
      }
      fs.chmodSync(socketPath, socketMode);
      log.log(`tool-call socket proxy listening on ${socketPath}`);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath, listenBacklog);
  });

  return {
    server,
    close: async () => {
      for (const socket of activeSockets) {
        destroySocket(socket);
      }
      await new Promise<void>((resolve) => {
        server.close(() => {
          try {
            fs.unlinkSync(socketPath);
          } catch {
            // Socket was already removed.
          }
          resolve();
        });
      });
    },
    activeConnections: () => activeSockets.size,
    activeRequests: () => activeRequests,
    activeUpstreams: () => activeUpstreams,
  };
}

if (require.main === module) {
  const socketPath = process.env.TCS_SOCKET || '/tmp/tcs.sock';
  const rawTarget = process.env.SANDBOX_FORWARD_TARGET || '';
  const socketUid = process.env.TCS_SOCKET_UID ? Number(process.env.TCS_SOCKET_UID) : undefined;
  const socketGid = process.env.TCS_SOCKET_GID ? Number(process.env.TCS_SOCKET_GID) : undefined;
  let handle: ToolCallSocketProxyHandle | undefined;
  let shuttingDown = false;

  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (!handle) {
      /* Signal arrived before startToolCallSocketProxy() resolved.
       * `process.exit` is terminal in Node, but the explicit `return` makes
       * the contract local: no `handle.close()` on `undefined` even if a
       * future runtime ever defers exit (atexit hook, async-cleanup mode). */
      process.exit(0);
      return;
    }
    void handle.close().finally(() => process.exit(0));
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  startToolCallSocketProxy({ socketPath, rawTarget, socketUid, socketGid })
    .then(started => {
      handle = started;
    })
    .catch(error => {
      console.error('tool-call socket proxy failed to start', error);
      process.exit(1);
    });
}
