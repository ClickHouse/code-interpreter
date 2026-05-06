import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as semver from 'semver';
import { Job, type TFile } from './job';
import type { Runtime } from './runtime';
import { config } from './config';

/**
 * Integration tests for `Job.downloadAndWriteFile` against a real HTTP
 * listener. These exercise the cross-repo round-trip: the file-server
 * (codeapi/service) emits `Content-Disposition: attachment;
 * filename*=UTF-8''<percent-encoded-path>` for nested artifacts, and the
 * sandbox-side parser must recover the path so the file lands at the same
 * nested location on the next prime(). Hitting a real listener (not a
 * mocked Response) catches anything fetch-level that a unit test would miss.
 */

interface DownloadInternals {
  submissionDir: string;
  files: TFile[];
  inputFileHashes: Map<string, { hash: string; path: string; originalId?: string; originalSessionId?: string }>;
}

function asInternals(job: Job): DownloadInternals {
  return job as unknown as DownloadInternals;
}

function makeRuntime(): Runtime {
  return {
    language: 'python',
    version: new semver.SemVer('3.11.0'),
    aliases: [],
    pkgdir: '/tmp',
    compiled: false,
    env_vars: {},
    timeouts: { compile: 5000, run: 5000 },
    cpu_times: { compile: 5000, run: 5000 },
    memory_limits: { compile: 100_000_000, run: 100_000_000 },
    max_process_count: 100,
    max_open_files: 100,
    max_file_size: 10_000_000,
    output_max_size: 1_000_000,
  };
}

function makeJob(files: TFile[] = []): Job {
  return new Job({
    session_id: 'test-session',
    runtime: makeRuntime(),
    files,
    args: [],
    stdin: '',
    timeouts: { compile: 5000, run: 5000 },
    cpu_times: { compile: 5000, run: 5000 },
    memory_limits: { compile: 100_000_000, run: 100_000_000 },
  });
}

/* Minimal stand-in for the file-server's `GET /sessions/:sid/objects/:id`.
 * Configurable per test via the `routes` map so individual cases can wire
 * different headers / status codes / bodies. */
type Route = {
  status: number;
  contentDisposition?: string;
  body?: string;
};

let server: ReturnType<typeof Bun.serve>;
let serverPort = 0;
const routes = new Map<string, Route>();
let originalFileServerUrl: string;

beforeAll(() => {
  originalFileServerUrl = config.file_server_url;
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const route = routes.get(url.pathname);
      if (!route) return new Response('not found', { status: 404 });
      const headers = new Headers();
      if (route.contentDisposition) {
        headers.set('content-disposition', route.contentDisposition);
      }
      return new Response(route.body ?? '', { status: route.status, headers });
    },
  });
  /* `Bun.serve(...)`'s `port` is typed `number | undefined` because the
   * field is also writable post-construction; in practice it's always
   * populated after the server boots. Coerce defensively so a zero would
   * still produce an unreachable URL rather than a malformed one. */
  serverPort = server.port ?? 0;
  /* Override config.file_server_url so the Job under test points at our
   * listener. `config` is a plain object, not frozen, so direct mutation
   * works — restored in afterAll. */
  (config as { file_server_url: string }).file_server_url = `http://127.0.0.1:${serverPort}`;
});

afterAll(() => {
  (config as { file_server_url: string }).file_server_url = originalFileServerUrl;
  server.stop(true);
});

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codeapi-download-'));
  routes.clear();
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('downloadAndWriteFile / RFC 5987 round-trip', () => {
  it('writes a nested-path artifact at the encoded location', async () => {
    /* Simulates the matplotlib-bug shape: codeapi previously returned a
     * flat `file.name` and the original path was carried only by the
     * server's `filename*=` header. The fix is: parser recovers the path,
     * `mkdir { recursive: true }` creates the parent dir, file ends up
     * where the user expects to `cat` it on the next turn. */
    const file: TFile = {
      id: 'nested-id',
      session_id: 'prev-session',
      name: 'flat-fallback.txt',
    };
    routes.set(`/sessions/${encodeURIComponent(file.session_id!)}/objects/${encodeURIComponent(file.id!)}`, {
      status: 200,
      contentDisposition: "attachment; filename*=UTF-8''proj%2Fnotes.txt",
      body: 'hello from a nested artifact\n',
    });

    const job = makeJob([file]);
    const internals = asInternals(job);
    internals.submissionDir = tmpDir;

    const writtenName = await job.downloadAndWriteFile(file);

    expect(writtenName).toBe('proj/notes.txt');
    const expectedFull = path.join(tmpDir, 'proj', 'notes.txt');
    const contents = await fsp.readFile(expectedFull, 'utf8');
    expect(contents).toBe('hello from a nested artifact\n');
  });

  it('falls back to the legacy filename= form when filename*= is absent', async () => {
    /* Backwards-compat: older file-servers (or proxies that strip RFC
     * 5987 extended-form headers) still send the legacy quoted form. The
     * parser must still find a name and write the file. */
    const file: TFile = {
      id: 'legacy-id',
      session_id: 'prev-session',
      name: 'ignored.txt',
    };
    routes.set(`/sessions/${encodeURIComponent(file.session_id!)}/objects/${encodeURIComponent(file.id!)}`, {
      status: 200,
      contentDisposition: 'attachment; filename="legacy.txt"',
      body: 'legacy bytes',
    });

    const job = makeJob([file]);
    asInternals(job).submissionDir = tmpDir;

    const writtenName = await job.downloadAndWriteFile(file);

    expect(writtenName).toBe('legacy.txt');
    const contents = await fsp.readFile(path.join(tmpDir, 'legacy.txt'), 'utf8');
    expect(contents).toBe('legacy bytes');
  });

  it('decodes UTF-8 percent-encoded names with non-ASCII characters', async () => {
    const file: TFile = {
      id: 'utf8-id',
      session_id: 'prev-session',
      name: 'ignored.txt',
    };
    routes.set(`/sessions/${encodeURIComponent(file.session_id!)}/objects/${encodeURIComponent(file.id!)}`, {
      status: 200,
      contentDisposition: "attachment; filename*=UTF-8''%E4%BD%A0%E5%A5%BD.txt",
      body: 'hi',
    });

    const job = makeJob([file]);
    asInternals(job).submissionDir = tmpDir;

    const writtenName = await job.downloadAndWriteFile(file);

    expect(writtenName).toBe('你好.txt');
    const contents = await fsp.readFile(path.join(tmpDir, '你好.txt'), 'utf8');
    expect(contents).toBe('hi');
  });

  it('returns null when the server keeps 404-ing past the retry cap (no phantom write)', async () => {
    const file: TFile = {
      id: 'missing-id',
      session_id: 'prev-session',
      name: 'should-not-exist.txt',
    };
    /* No route registered → listener returns 404 for every retry. */

    const job = makeJob([file]);
    asInternals(job).submissionDir = tmpDir;

    const writtenName = await job.downloadAndWriteFile(file, 2, 1);

    expect(writtenName).toBeNull();
    /* Defensive: confirm we did not leave a partial / phantom file on
     * disk after exhausting retries. */
    await expect(fsp.access(path.join(tmpDir, 'should-not-exist.txt'))).rejects.toThrow();
  });

  it('rejects a server-supplied filename that escapes the submission dir', async () => {
    /* Companion guarantee for the path-preserving sanitizer on the
     * LibreChat side: if a malicious / misconfigured server tries to
     * smuggle a `..` traversal via Content-Disposition, the codeapi-side
     * `validateFilePath` aborts before any write happens. */
    const file: TFile = {
      id: 'evil-id',
      session_id: 'prev-session',
      name: 'innocent.txt',
    };
    routes.set(`/sessions/${encodeURIComponent(file.session_id!)}/objects/${encodeURIComponent(file.id!)}`, {
      status: 200,
      contentDisposition: "attachment; filename*=UTF-8''..%2F..%2Fescape.txt",
      body: 'should never be written',
    });

    const job = makeJob([file]);
    asInternals(job).submissionDir = tmpDir;

    /* downloadAndWriteFile rethrows ValidationError fast (no retries) so
     * `expect(...).rejects` is the right assertion. */
    await expect(job.downloadAndWriteFile(file)).rejects.toThrow();
    /* Defensive: nothing escaped to a parent dir. */
    const parent = path.dirname(tmpDir);
    await expect(fsp.access(path.join(parent, 'escape.txt'))).rejects.toThrow();
  });
});
