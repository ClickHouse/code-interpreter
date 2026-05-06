import * as fs from 'fs';
import * as path from 'path';
import { nanoid } from 'nanoid';
import * as crypto from 'crypto';
import * as semver from 'semver';
import * as fsp from 'fs/promises';
import { pipeline } from 'stream/promises';
import { Readable, Transform } from 'stream';
import type { Logger } from 'pino';
import type { NsJailResult } from './nsjail';
import type { Runtime } from './runtime';
import { logger as rootLogger } from './logger';
import { getRuntimes } from './runtime';
import { execute } from './nsjail';
import { config } from './config';
import { internalServiceHeaders } from './internal-service-auth';
import {
  DIRKEEP,
  SANDBOX_DIR_MODE,
  SANDBOX_FILE_MODE,
  ValidationError,
  isDirkeep,
  isValidPathShape,
  validateFilePath,
  isValidFilePath,
} from './validation';

export {
  DIRKEEP,
  SANDBOX_DIR_MODE,
  SANDBOX_FILE_MODE,
  ValidationError,
  isDirkeep,
  checkPathShape,
  isValidPathShape,
  validateFilePath,
  isValidFilePath,
} from './validation';

const AUTO_LOAD_DIRKEEP_TIMEOUT_MS = 10000;

/**
 * Bridges a `fetch` response body to a Node-stream Readable. The types at the
 * module boundary (Node's `stream/web` vs. lib.dom) don't overlap cleanly,
 * hence the isolated cast; at runtime they're structurally compatible.
 */
function toNodeReadable(body: import('stream/web').ReadableStream | ReadableStream): Readable {
  return Readable.fromWeb(body as import('stream/web').ReadableStream);
}

/**
 * Aggregates extra pkgdirs for the bash runtime so bash scripts can shell out
 * to every other installed language. Walks all registered runtimes sorted by
 * (language, descending version) and picks the first pkgdir per language,
 * skipping the bash runtime's own pkgdir and any duplicates. Mutates
 * `envVars.PATH` in place to prepend each runtime's PATH entries without
 * re-introducing duplicates, so packaged runtimes win over base-image tools.
 *
 * Exported for unit testing — the mutation on `envVars` is observable.
 */
export function aggregateBashExtras(
  bashPkgdir: string,
  envVars: Record<string, string>,
  runtimes: readonly Runtime[] = getRuntimes(),
  linkTarget?: { nodeModulesPath?: string },
): string[] | undefined {
  const seenDirs = new Set<string>([bashPkgdir]);
  const seenLangs = new Set<string>();
  const seenPathEntries = new Set<string>(
    (envVars.PATH ?? '').split(':').filter(Boolean),
  );
  const seenNodePathEntries = new Set<string>(
    (envVars.NODE_PATH ?? '').split(':').filter(Boolean),
  );
  const pathSources: string[] = [];
  const nodePathSources: string[] = [];

  const sorted = [...runtimes].sort((a, b) =>
    a.language.localeCompare(b.language) || semver.rcompare(a.version, b.version),
  );

  let extraPkgdirs: string[] | undefined;
  for (const rt of sorted) {
    if (seenDirs.has(rt.pkgdir)) continue;
    if (seenLangs.has(rt.language)) continue;
    seenDirs.add(rt.pkgdir);
    seenLangs.add(rt.language);
    extraPkgdirs ??= [];
    extraPkgdirs.push(rt.pkgdir);
    collectDelimitedEnvEntries(rt.env_vars.PATH, pathSources, seenPathEntries);
    if (rt.env_vars.NODE_PATH) {
      if (rt.language === 'node' || rt.runtime === 'node') {
        nodePathSources.unshift(rt.env_vars.NODE_PATH);
      } else {
        nodePathSources.push(rt.env_vars.NODE_PATH);
      }
    }
  }
  prependDelimitedEnvEntries('PATH', pathSources, envVars);
  for (const source of nodePathSources) {
    if (linkTarget) rememberPreferredNodeModules(source, linkTarget);
    mergeDelimitedEnvEntries('NODE_PATH', source, envVars, seenNodePathEntries);
  }
  return extraPkgdirs;
}

function rememberPreferredNodeModules(
  source: string,
  linkTarget: { nodeModulesPath?: string },
): void {
  if (linkTarget.nodeModulesPath) return;
  const nodeModulesPath = source
    .split(':')
    .filter(Boolean)
    .find(entry => path.isAbsolute(entry) && path.basename(entry) === 'node_modules');
  if (nodeModulesPath) linkTarget.nodeModulesPath = nodeModulesPath;
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code?: unknown }).code)
    : undefined;
}

export function ensureNodeModulesSymlink(
  submissionDir: string,
  nodeModulesPath?: string,
): void {
  if (!nodeModulesPath) return;
  const linkPath = path.join(submissionDir, 'node_modules');
  try {
    fs.lstatSync(linkPath);
    return;
  } catch (err) {
    if (errorCode(err) !== 'ENOENT') throw err;
  }

  try {
    fs.symlinkSync(nodeModulesPath, linkPath, 'dir');
  } catch (err) {
    if (errorCode(err) !== 'EEXIST') throw err;
  }
}

/**
 * Extracts the on-disk filename from a Content-Disposition response header,
 * falling back to the request-supplied `file.name` (or `file.id` if no name
 * was provided). Pure; exported for unit testing.
 *
 * Matches RFC 5987 / 8187 `filename*=UTF-8''<percent-encoded>` first because
 * the file server emits that form for UTF-8-safe transport of arbitrary
 * names — including paths with `/` separators that the legacy `filename=`
 * form would mangle. Falls back to the legacy quoted (`filename="..."`) or
 * unquoted (`filename=...`) forms, each stopping at the closing quote or
 * the first whitespace/semicolon so trailing params like
 * `attachment; filename="foo.txt"; size=123` correctly yield `foo.txt`.
 */
export function resolveOriginalName(response: Response, file: TFile): string {
  const fallback = file.name || (file.id ?? '');
  const header = response.headers.get('content-disposition');
  if (!header) return fallback;

  const star = header.match(/filename\*=(?:UTF-8'[^']*')?([^;]+)/i);
  if (star) {
    const raw = star[1].trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      /* Malformed percent-encoding (e.g. `%ZZ`) — fall through to the legacy
       * forms. The same header may emit both `filename*=` and a legacy
       * `filename=` per RFC 5987 §4.3, so a corrupt extended form should
       * not poison a valid fallback. */
    }
  }

  const match = header.match(/filename="([^"]+)"/i)
    ?? header.match(/filename=([^\s;]+)/i);
  return match ? match[1] : fallback;
}

/**
 * Type-guard factory for the file server's normalized-detail response. Only
 * accepts objects whose `session_id` matches `sid` exactly, closing the
 * MinIO prefix-list leak where listing `abc` also returns keys under
 * `abcdef/`. Exported for unit testing.
 */
export function isNormalizedObjectForSession(
  sid: string,
): (o: unknown) => o is { id: string; name: string; session_id: string } {
  return (o): o is { id: string; name: string; session_id: string } => {
    if (!o || typeof o !== 'object') return false;
    const rec = o as Record<string, unknown>;
    if (typeof rec.id !== 'string') return false;
    if (typeof rec.name !== 'string') return false;
    if (typeof rec.session_id !== 'string') return false;
    return rec.session_id === sid;
  };
}

/**
 * Run `fn` over `items` with at most `concurrency` in flight at once. Workers
 * pick the next index off a shared counter, so finished workers steal work
 * from busier ones rather than waiting for a fixed-size batch to drain.
 * Preserves input order in the result. Pure; exported for unit testing.
 *
 * Cap defensively at `items.length` and at 1 — a 0 or negative cap would
 * spawn no workers and the function would never resolve. A cap above the
 * input length wastes nothing but a few stale `>= length` comparisons.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const cap = Math.max(1, Math.min(concurrency, items.length));
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: cap }, worker));
  return results;
}

/**
 * Extension → MIME map covering the file types that come out of code
 * execution on this sandbox: images, documents, plain text / config, code,
 * archives, audio/video, and a handful of byte-soup formats. Used for the
 * upload `Content-Type` header so the file-server stores the real media
 * type as object metadata and downloads round-trip with the right header
 * for inline rendering / handler dispatch on the LibreChat side.
 *
 * Hand-rolled rather than pulled from `mime-types` to keep the codeapi
 * dependency surface minimal — the receiving side is the file-server,
 * which only stores whatever string we send, so coverage of the long tail
 * isn't load-bearing. Anything not on this list falls back to
 * `application/octet-stream`.
 */
const MIME_TYPE_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  // Images
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.tiff', 'image/tiff'],
  ['.tif', 'image/tiff'],
  ['.ico', 'image/x-icon'],
  ['.svg', 'image/svg+xml'],
  ['.heic', 'image/heic'],
  ['.heif', 'image/heif'],
  ['.avif', 'image/avif'],
  // Documents
  ['.pdf', 'application/pdf'],
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.ppt', 'application/vnd.ms-powerpoint'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.odt', 'application/vnd.oasis.opendocument.text'],
  ['.ods', 'application/vnd.oasis.opendocument.spreadsheet'],
  ['.odp', 'application/vnd.oasis.opendocument.presentation'],
  // Text / structured text
  ['.txt', 'text/plain'],
  ['.log', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.rst', 'text/x-rst'],
  ['.csv', 'text/csv'],
  ['.tsv', 'text/tab-separated-values'],
  ['.html', 'text/html'],
  ['.htm', 'text/html'],
  ['.css', 'text/css'],
  ['.xml', 'application/xml'],
  ['.json', 'application/json'],
  ['.jsonl', 'application/x-ndjson'],
  ['.yaml', 'application/yaml'],
  ['.yml', 'application/yaml'],
  ['.toml', 'application/toml'],
  ['.ini', 'text/plain'],
  ['.conf', 'text/plain'],
  /* `.env` matches *.env files (e.g. `app.env`, `prod.env`) only.
   * `mimeTypeFor` treats the literal `.env` dotfile as having no extension
   * (`dot === 0` early-return) so it falls through to octet-stream — that's
   * intentional, since dotfile `.env` is conventionally a secrets file we
   * shouldn't auto-serve as text. */
  ['.env', 'text/plain'],
  // Code (text-typed; some prefer `text/x-<lang>` but `text/plain` is
  // safer for the file-server's download Content-Type since most browsers
  // treat unknown text/x-* as octet-stream anyway)
  ['.js', 'text/javascript'],
  ['.mjs', 'text/javascript'],
  ['.ts', 'text/x-typescript'],
  ['.tsx', 'text/x-typescript'],
  ['.jsx', 'text/javascript'],
  ['.py', 'text/x-python'],
  ['.rb', 'text/x-ruby'],
  ['.go', 'text/x-go'],
  ['.rs', 'text/x-rust'],
  ['.java', 'text/x-java'],
  ['.kt', 'text/x-kotlin'],
  ['.kts', 'text/x-kotlin'],
  ['.scala', 'text/x-scala'],
  ['.c', 'text/x-c'],
  ['.h', 'text/x-c'],
  ['.cpp', 'text/x-c++'],
  ['.cs', 'text/x-csharp'],
  ['.php', 'application/x-php'],
  ['.pl', 'text/x-perl'],
  ['.r', 'text/x-r'],
  ['.lua', 'text/x-lua'],
  ['.swift', 'text/x-swift'],
  ['.sh', 'application/x-sh'],
  ['.ps1', 'application/x-powershell'],
  ['.sql', 'application/sql'],
  // Archives
  ['.zip', 'application/zip'],
  ['.tar', 'application/x-tar'],
  ['.gz', 'application/gzip'],
  ['.tgz', 'application/gzip'],
  ['.bz2', 'application/x-bzip2'],
  ['.xz', 'application/x-xz'],
  ['.7z', 'application/x-7z-compressed'],
  ['.rar', 'application/vnd.rar'],
  // Audio / video
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.flac', 'audio/flac'],
  ['.ogg', 'audio/ogg'],
  ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.mp4', 'video/mp4'],
  ['.mkv', 'video/x-matroska'],
  ['.mov', 'video/quicktime'],
  ['.avi', 'video/x-msvideo'],
  ['.webm', 'video/webm'],
  // Fonts
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  // Data formats
  ['.parquet', 'application/vnd.apache.parquet'],
  ['.bson', 'application/bson'],
  ['.wasm', 'application/wasm'],
]);

/**
 * Returns the registered MIME type for `filename` based on its extension,
 * falling back to `application/octet-stream`. Extension lookup uses the
 * basename so directory-name dots (e.g. `proj.v1/notes`) don't false-trigger.
 * Pure; exported for unit testing.
 */
export function mimeTypeFor(filename: string): string {
  const lastSep = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'));
  const basename = lastSep >= 0 ? filename.slice(lastSep + 1) : filename;
  const dot = basename.lastIndexOf('.');
  if (dot <= 0) return 'application/octet-stream';
  const ext = basename.slice(dot).toLowerCase();
  return MIME_TYPE_BY_EXTENSION.get(ext) ?? 'application/octet-stream';
}

/**
 * True when `name` is a hidden-directory basename (starts with `.`). Excludes
 * `.` and `..` traversal markers, which `walkDir`'s readdir never emits but
 * are guarded here for defense in depth. Pure; exported for unit testing.
 */
export function isHiddenDirectory(name: string): boolean {
  if (name.length <= 1) return false;
  if (name === '..') return false;
  return name.startsWith('.');
}

/**
 * True when any explicit input file lives at or under `relativePath`. Used to
 * keep the hidden-directory filter from silently dropping a directory that
 * the user explicitly primed something into (e.g. an inherited `.config/foo`
 * input file). Pure; exported for unit testing.
 *
 * Accepts both `/` and the platform separator in the prefix check because
 * walkDir's `path.relative()` returns platform-separated paths while user
 * input file names typically arrive POSIX-normalized. Either combination
 * lights up the same input.
 */
export function inputsLiveUnder(
  inputByName: Map<string, TFile>,
  relativePath: string,
): boolean {
  const posixPrefix = relativePath.replace(/\\/g, '/') + '/';
  const nativePrefix = relativePath + path.sep;
  for (const key of inputByName.keys()) {
    if (key === relativePath) return true;
    const posixKey = key.replace(/\\/g, '/');
    if (posixKey.startsWith(posixPrefix)) return true;
    if (path.sep !== '/' && key.startsWith(nativePrefix)) return true;
  }
  return false;
}

/**
 * True when importing `markerName` would require its parent directory to
 * exist at a path where the current request already places a regular file.
 * Exported for unit testing.
 */
export function markerConflictsWithExplicitFile(
  markerName: string,
  explicitFilePaths: string[],
): boolean {
  const markerDir = path.dirname(markerName);
  if (markerDir === '' || markerDir === '.') return false;
  for (const p of explicitFilePaths) {
    if (p === markerDir) return true;
    if (markerDir.startsWith(p + '/')) return true;
  }
  return false;
}

function mergeDelimitedEnvEntries(
  key: string,
  source: string | undefined,
  envVars: Record<string, string>,
  seenEntries: Set<string>,
): void {
  if (!source) return;
  for (const entry of source.split(':')) {
    if (!entry) continue;
    if (seenEntries.has(entry)) continue;
    seenEntries.add(entry);
    envVars[key] = envVars[key] ? envVars[key] + ':' + entry : entry;
  }
}

function collectDelimitedEnvEntries(
  source: string | undefined,
  target: string[],
  seenEntries: Set<string>,
): void {
  if (!source) return;
  for (const entry of source.split(':')) {
    if (!entry) continue;
    if (seenEntries.has(entry)) continue;
    seenEntries.add(entry);
    target.push(entry);
  }
}

function prependDelimitedEnvEntries(
  key: string,
  entries: string[],
  envVars: Record<string, string>,
): void {
  if (entries.length === 0) return;
  const joinedEntries = entries.join(':');
  envVars[key] = envVars[key] ? joinedEntries + ':' + envVars[key] : joinedEntries;
}

/** Environment variables that must never be influenced by caller-supplied
 * `extra_env_vars`. Keys are compared upper-case. Prefixes cover loader-
 * sensitive variables (LD_*, DYLD_*) whose exhaustive enumeration isn't
 * practical. Hoisted to module scope so we don't rebuild the Set on every
 * `safeCall()` invocation. */
export const RESERVED_ENV_KEYS: ReadonlySet<string> = new Set([
  'OPENBLAS_NUM_THREADS',
  'MKL_NUM_THREADS',
  'OMP_NUM_THREADS',
  'SANDBOX_LANGUAGE',
  'HOME',
  'PATH',
  'TOOL_CALL_SOCKET',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'PYTHONHOME',
  'PYTHONEXECUTABLE',
  'PYTHONIOENCODING',
  'NODE_OPTIONS',
  'NODE_PATH',
  'BASH_ENV',
  'ENV',
  'PROMPT_COMMAND',
  'IFS',
  'SHELLOPTS',
  'BASHOPTS',
  'GLIBC_TUNABLES',
  /** PTC replay history file path. The programmatic router sets this
   * internally to point at the submission-dir `_ptc_history.json`; a
   * direct `/v2/execute` caller could otherwise redirect the preamble
   * to an empty / attacker-controlled file and force the sandbox to
   * re-emit already-resolved tool calls. Defense-in-depth — the
   * programmatic router never populates `env_vars` from user input,
   * but the v2 endpoint surface is broader. */
  'PTC_HISTORY_PATH',
]);
export const RESERVED_ENV_PREFIXES: readonly string[] = ['LD_', 'DYLD_', 'PTC_'];

/** Filter a caller-supplied env-var map by the same rules `safeCall()`
 * applies before spreading into nsjail. Exposed for unit tests so the
 * blocklist can be exercised without spinning up a real Job. */
export function filterExtraEnvVars(
  raw: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const [key, value] of Object.entries(raw)) {
    const upperKey = key.toUpperCase();
    if (RESERVED_ENV_KEYS.has(upperKey)) continue;
    if (RESERVED_ENV_PREFIXES.some(p => upperKey.startsWith(p))) continue;
    out[key] = value;
  }
  return out;
}

const SUPPORTED_EXTENSIONS = new Set([
  '.c', '.cs', '.cpp', '.go', '.java', '.js', '.kt', '.kts', '.lua',
  '.php', '.pl', '.ps1', '.py', '.r', '.rb', '.rs', '.scala', '.sh',
  '.sql', '.swift', '.ts', '.jsx', '.tsx', '.groovy',
  '.css', '.htm', '.html', '.less', '.sass', '.scss', '.svg', '.svelte', '.vue',
  '.adoc', '.asciidoc', '.md', '.rst', '.tex', '.txt', '.wiki',
  '.csv', '.json', '.bson', '.json5', '.jsonl', '.parquet', '.tsv',
  '.xml', '.yaml', '.yml',
  '.ics', '.ical', '.ifb', '.icalendar',
  '.conf', '.env', '.gitignore', '.ini', '.properties', '.toml',
  '.doc', '.docx', '.pdf', '.ppt', '.pptx', '.xls', '.xlsx',
  '.odt', '.ods', '.odp', '.rtf',
  '.avif', '.bmp', '.gif', '.ico', '.jpeg', '.jpg', '.png',
  '.tif', '.tiff', '.webp',
  '.eot', '.ttf', '.woff', '.woff2',
  '.7z', '.bz2', '.gz', '.gzip', '.rar', '.tar', '.zip',
  '.tf', '.tfvars', '.tfstate', '.hcl',
  '.dockerfile', '.Dockerfile', '.dockerignore',
  '.helmignore', '.helmfile', '.jenkinsfile', '.vagrantfile',
  '.eslintrc', '.prettierrc', '.editorconfig', '.nomad',
  '.bat', '.cmd', '.deb', '.log', '.rpm', '.vbs',
]);

export interface TFile {
  id?: string;
  session_id?: string;
  name: string;
  content?: string;
  encoding?: 'base64' | 'hex' | 'utf8';
  /**
   * Per-file entity scope from the caller's authorization model. Carried
   * through the worker so it can be echoed back on `inherited: true`
   * output refs — the caller relies on the round-trip to preserve the
   * scope across multi-turn sessions.
   */
  entity_id?: string;
}

interface FileRef {
  id: string;
  name: string;
  session_id: string;
  modified_from?: { id: string; session_id: string };
  /**
   * `true` when this ref is an unchanged passthrough of an input the caller
   * already owns (downloaded inputs, inherited `.dirkeep` markers). Surfaced
   * so callers can skip post-processing — re-downloading a skill- or
   * entity-scoped input with the end-user's session key 403s, and is pure
   * waste regardless: the file is already persisted at its origin.
   */
  inherited?: true;
  /**
   * Echoed verbatim from the matching input `TFile` when present. Lets
   * callers preserve per-file entity scope across multi-turn sessions
   * without defensive carry-forward logic on their side.
   */
  entity_id?: string;
}

interface GeneratedFile {
  id: string;
  name: string;
  path: string;
}

interface InputFileInfo {
  originalId?: string;
  originalSessionId?: string;
  hash: string;
  path: string;
  /**
   * Mirrors the file-server `X-Read-Only` flag captured at download time.
   * When set, the walker MUST emit this input as inherited (preserving the
   * caller's original id/session_id) regardless of whether sandboxed code
   * modified the bytes on disk — the file is infrastructure (e.g. a skill
   * file) and modifications are not surfaced as artifacts to the client.
   */
  readOnly?: boolean;
}

interface ExecuteResult {
  compile?: NsJailResult;
  run?: NsJailResult;
  language: string;
  version: string;
  session_id: string;
  files: FileRef[];
}

let remainingJobSpaces = config.max_concurrent_jobs;
const jobQueue: Array<() => void> = [];

export class Job {
  uuid: string;
  runtime: Runtime;
  files: TFile[];
  args: string[];
  stdin: string;
  timeouts: { run: number; compile: number };
  cpu_times: { run: number; compile: number };
  memory_limits: { run: number; compile: number };
  extra_env_vars?: Record<string, string>;

  private log: Logger;
  private submissionDir = '';
  private generatedFiles: GeneratedFile[] = [];
  private sessionFiles: FileRef[] = [];
  private inheritedRefs: FileRef[] = [];
  private inputFileHashes = new Map<string, InputFileInfo>();
  private entryPointName: string | undefined;
  private chmoddedDirs = new Set<string>();

  constructor(opts: {
    session_id?: string | null;
    runtime: Runtime;
    files: TFile[];
    args: string[];
    stdin: string;
    timeouts: { run: number; compile: number };
    cpu_times: { run: number; compile: number };
    memory_limits: { run: number; compile: number };
    extra_env_vars?: Record<string, string>;
  }) {
    this.uuid = opts.session_id ?? nanoid();
    this.log = rootLogger.child({ job: this.uuid });
    this.runtime = opts.runtime;
    this.files = opts.files.map((file, i) => ({
      id: file.id,
      session_id: file.session_id ?? this.uuid,
      name: file.name || `file${i}.code`,
      content: file.content,
      encoding: (['base64', 'hex', 'utf8'] as const).includes(file.encoding as 'base64' | 'hex' | 'utf8')
        ? file.encoding
        : 'utf8',
      /* Carry `entity_id` forward so `tryEchoUnchangedInput` and
       * `echoInheritedKeep` can preserve it on inherited refs. The
       * explicit field selection above drops everything not named —
       * without this line the entity_id arrives on the request body
       * but is invisible by the time the walker echoes inputs back. */
      entity_id: file.entity_id,
    }));
    this.args = opts.args;
    this.stdin = opts.stdin.endsWith('\n') ? opts.stdin : opts.stdin + '\n';
    this.timeouts = opts.timeouts;
    this.cpu_times = opts.cpu_times;
    this.memory_limits = opts.memory_limits;
    this.extra_env_vars = opts.extra_env_vars;
  }

  async computeFileHash(filePath: string): Promise<string> {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return hash.digest('hex');
  }

  /**
   * True when no further walkDir traversal can contribute to the final
   * response. Only short-circuits when `generatedFiles` is at the cap:
   * generated entries take priority in `handleSessionFiles`, so once they
   * fill every slot the inherited back-fill contributes zero.
   *
   * We intentionally do NOT stop when `inheritedRefs` alone hits the cap —
   * doing so would let directory iteration order silently drop real generated
   * outputs that haven't been walked yet (inherited refs would claim slots
   * that generated files would otherwise displace). Each `inheritedRefs.push`
   * site already guards against its own unbounded growth.
   */
  private isOutputCapFull(): boolean {
    return this.generatedFiles.length >= config.max_output_files;
  }

  /**
   * Chmod every directory between submissionDir (exclusive) and `leaf` (inclusive)
   * to SANDBOX_DIR_MODE. `mkdir({ recursive: true })` creates ancestors with
   * umask-derived perms (typically 0755), which blocks the jailed runtime user
   * from creating siblings/children in those intermediate directories.
   */
  private async chmodAncestors(leaf: string): Promise<void> {
    const rel = path.relative(this.submissionDir, leaf);
    if (!rel || rel === '..' || rel.startsWith('..' + path.sep)) return;
    const parts = rel.split(path.sep).filter(Boolean);
    let cursor = this.submissionDir;
    for (const part of parts) {
      cursor = path.join(cursor, part);
      /* Parallel downloads under shared parent dirs call into this method
       * concurrently. Skip paths we've already chmodded to avoid N*M redundant
       * syscalls (N files × M shared ancestors). */
      if (this.chmoddedDirs.has(cursor)) continue;
      await fsp.chmod(cursor, SANDBOX_DIR_MODE);
      this.chmoddedDirs.add(cursor);
    }
  }

  async prime(): Promise<void> {
    if (remainingJobSpaces < 1) {
      this.log.info('Awaiting job slot');
      await new Promise<void>(resolve => { jobQueue.push(resolve); });
    }
    remainingJobSpaces--;

    const tmpBase = '/tmp/sandbox';
    await fsp.mkdir(tmpBase, { recursive: true });
    this.submissionDir = path.join(tmpBase, this.uuid);
    await fsp.mkdir(this.submissionDir, { recursive: true });
    await fsp.chmod(this.submissionDir, SANDBOX_DIR_MODE);

    this.log.info({ submissionDir: this.submissionDir }, 'Priming job');

    if (config.file_server_url && this.files.some(f => f.id && f.session_id)) {
      await this.autoLoadDirkeep();
    }

    const fileOps: Promise<void>[] = [];
    for (const file of this.files) {
      if (file.id) {
        fileOps.push(this.downloadAndWriteFile(file).then(() => {}));
      } else if (file.content !== undefined) {
        fileOps.push(this.writeFile(file));
      }
    }
    await Promise.all(fileOps);
  }

  private async autoLoadDirkeep(): Promise<void> {
    const sessionIds = new Set(
      this.files.filter(f => f.id && f.session_id).map(f => f.session_id!),
    );
    const existingNames = new Set(this.files.map(f => f.name));
    const explicitFilePaths = this.files
      .filter(f => !isDirkeep(f.name))
      .map(f => f.name);

    const fetches = Array.from(sessionIds).map(sid => this.fetchSessionMarkers(sid));
    const results = await Promise.all(fetches);

    let added = 0;
    let hitCap = false;
    for (const objects of results) {
      for (const obj of objects) {
        if (added >= config.max_output_files) { hitCap = true; break; }
        if (this.tryRegisterInheritedMarker(obj, existingNames, explicitFilePaths)) added++;
      }
      if (hitCap) break;
    }
    if (hitCap) {
      this.log.warn(
        { added, cap: config.max_output_files },
        'autoLoadDirkeep: hit marker cap; some inherited empty directories will not be restored',
      );
    }
  }

  /**
   * Fetches normalized objects for one inherited session and returns the
   * `.dirkeep` markers belonging to exactly that session. Guards against:
   *   - non-OK responses (empty list, no throw)
   *   - non-array JSON bodies
   *   - missing/malformed id/name/session_id fields
   *   - MinIO prefix-list leakage (`abc` prefix also matches `abcdef/...`)
   *     by requiring `session_id === sid`.
   */
  private async fetchSessionMarkers(
    sid: string,
  ): Promise<Array<{ id: string; name: string; session_id: string }>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AUTO_LOAD_DIRKEEP_TIMEOUT_MS);
    try {
      const res = await fetch(
        `${config.file_server_url}/sessions/${encodeURIComponent(sid)}/objects?detail=normalized`,
        {
          headers: internalServiceHeaders(),
          signal: controller.signal,
        },
      );
      if (!res.ok) return [];
      const data: unknown = await res.json();
      if (!Array.isArray(data)) return [];
      return data.filter(isNormalizedObjectForSession(sid));
    } catch (err) {
      this.log.warn({ sessionId: sid, err }, 'Failed to auto-load .dirkeep markers');
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Decides whether a normalized marker object is accepted into `this.files`
   * for the current prime() run. Returns `true` when the marker was pushed,
   * `false` when it was filtered out. Filters (in order): wrong basename,
   * duplicate name, invalid/traversing path, conflict with explicit file.
   */
  private tryRegisterInheritedMarker(
    obj: { id: string; name: string; session_id: string },
    existingNames: Set<string>,
    explicitFilePaths: string[],
  ): boolean {
    if (!isDirkeep(obj.name)) return false;
    if (existingNames.has(obj.name)) return false;
    if (!isValidFilePath(obj.name, this.submissionDir)) {
      this.log.warn(
        { sessionId: obj.session_id, name: obj.name },
        'autoLoadDirkeep: rejected marker with invalid or traversing path',
      );
      return false;
    }
    if (markerConflictsWithExplicitFile(obj.name, explicitFilePaths)) {
      this.log.debug(
        { sessionId: obj.session_id, name: obj.name },
        'autoLoadDirkeep: skipping marker that conflicts with explicit request file',
      );
      return false;
    }
    this.files.push({ id: obj.id, session_id: obj.session_id, name: obj.name });
    existingNames.add(obj.name);
    return true;
  }

  async downloadAndWriteFile(file: TFile, maxRetries = 5, retryDelay = 500): Promise<string | null> {
    if (!file.id || !file.session_id) return null;

    validateFilePath(file.name, this.submissionDir);

    const tempPath = path.join(this.submissionDir, `.tmp-${nanoid()}`);

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(this.buildDownloadUrl(file), {
          headers: internalServiceHeaders(),
        });

        if (response.status === 404 && attempt < maxRetries) {
          const delay = retryDelay * Math.pow(2, attempt - 1);
          this.log.info({ fileId: file.id, attempt, maxRetries, delay }, 'File not found, retrying');
          await sleep(delay);
          continue;
        }

        if (!response.ok) throw new Error(`HTTP error: ${response.status}`);

        const originalName = resolveOriginalName(response, file);
        validateFilePath(originalName, this.submissionDir);
        const finalPath = path.join(this.submissionDir, originalName);
        const finalParent = path.dirname(finalPath);
        await fsp.mkdir(finalParent, { recursive: true });
        await this.chmodAncestors(finalParent);

        const hash = await this.streamToDisk(response, tempPath, finalPath);
        const readOnly = response.headers.get('x-read-only')?.toLowerCase() === 'true';
        this.inputFileHashes.set(originalName, {
          originalId: file.id,
          originalSessionId: file.session_id!,
          hash,
          path: finalPath,
          readOnly: readOnly || undefined,
        });
        /* Defense-in-depth: chmod 444 (read-only for owner+group+other) so
         * sandboxed code that tries to mutate skill files fails at the
         * filesystem layer instead of needing the walker to silently drop
         * the modifications. The sandbox UID (65534) cannot chmod files it
         * doesn't own back to writable, so this is a one-way seal. */
        if (readOnly) {
          try {
            await fsp.chmod(finalPath, 0o444);
          } catch (err) {
            this.log.warn({ file: originalName, err }, 'Failed to chmod read-only input');
          }
        }

        /* Keep the in-memory TFile in sync with the on-disk name so that
         * inputByName lookups in handleSessionFiles match walkDir's
         * path.relative() output. Otherwise a Content-Disposition override
         * would leave file.name pointing at the client-submitted name while
         * the file lives under originalName on disk. */
        if (originalName !== file.name) file.name = originalName;

        this.log.info({ file: originalName, hash: hash.substring(0, 8) }, 'Downloaded file');
        return originalName;
      } catch (error: unknown) {
        /* ValidationError is deterministic — a bad Content-Disposition
         * filename will fail identically on every retry. Abort fast
         * (cleanup + rethrow) instead of burning ~7.5s on exponential
         * backoff and surfacing the error as a generic download failure. */
        if (error instanceof ValidationError) {
          try { await fsp.unlink(tempPath); } catch { /* may not exist */ }
          throw error;
        }
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < maxRetries) {
          const delay = retryDelay * Math.pow(2, attempt - 1);
          this.log.warn({ fileId: file.id, attempt, maxRetries, delay, err: lastError }, 'Download failed, retrying');
          await sleep(delay);
        }
      }
    }

    this.log.error({ fileId: file.id, maxRetries, err: lastError }, 'Failed to download file');
    try { await fsp.unlink(tempPath); } catch { /* may not exist */ }
    return null;
  }

  /**
   * URL for fetching a single object from the file server. Encodes path
   * segments — client-supplied session_id / file.id could otherwise inject
   * `../` or raw `/` and hit unintended endpoints (SSRF-adjacent).
   */
  private buildDownloadUrl(file: TFile): string {
    return `${config.file_server_url}/sessions/${encodeURIComponent(file.session_id!)}/objects/${encodeURIComponent(file.id!)}`;
  }

  /**
   * Streams the response body to `tempPath`, computes its SHA-256 inline,
   * then atomically renames to `finalPath` with sandbox-visible perms.
   * Returns the hex digest.
   */
  private async streamToDisk(
    response: Response,
    tempPath: string,
    finalPath: string,
  ): Promise<string> {
    const body = response.body;
    if (!body) throw new Error('Response body is null');

    const hashStream = crypto.createHash('sha256');
    const hashTransform = new Transform({
      transform(chunk, _enc, cb) { hashStream.update(chunk); cb(null, chunk); },
    });
    const fileStream = fs.createWriteStream(tempPath, { mode: SANDBOX_FILE_MODE });
    const reader = toNodeReadable(body);
    await pipeline(reader, hashTransform, fileStream);
    await fsp.rename(tempPath, finalPath);
    await fsp.chmod(finalPath, SANDBOX_FILE_MODE);
    return hashStream.digest('hex');
  }

  async writeFile(file: TFile): Promise<void> {
    validateFilePath(file.name, this.submissionDir);
    const filePath = path.join(this.submissionDir, file.name);

    const content = Buffer.from(file.content ?? '', (file.encoding as BufferEncoding) ?? 'utf8');
    const parentDir = path.dirname(filePath);
    await fsp.mkdir(parentDir, { recursive: true });
    await this.chmodAncestors(parentDir);
    await fsp.writeFile(filePath, content);
    await fsp.chmod(filePath, SANDBOX_FILE_MODE);

    const hash = crypto.createHash('sha256').update(content).digest('hex');
    this.inputFileHashes.set(file.name, { hash, path: filePath });
  }

  async safeCall(
    script: string,
    args: string[],
    timeout: number,
    _cpuTime: number,
    memoryLimit: number,
    stdin?: string,
  ): Promise<NsJailResult> {
    const command = ['/bin/bash', path.join(this.runtime.pkgdir, script), ...args];

    const filteredExtra = filterExtraEnvVars(this.extra_env_vars);

    const envVars: Record<string, string> = {
      ...filteredExtra,
      OPENBLAS_NUM_THREADS: '1',
      MKL_NUM_THREADS: '1',
      OMP_NUM_THREADS: '1',
      ...this.runtime.env_vars,
      SANDBOX_LANGUAGE: this.runtime.language,
      HOME: '/mnt/data',
    };

    let extraPkgdirs: string[] | undefined;
    if (this.runtime.language === 'bash') {
      const linkTarget: { nodeModulesPath?: string } = {};
      extraPkgdirs = aggregateBashExtras(this.runtime.pkgdir, envVars, undefined, linkTarget);
      ensureNodeModulesSymlink(this.submissionDir, linkTarget.nodeModulesPath);
    }

    return execute({
      command,
      envVars,
      submissionDir: this.submissionDir,
      pkgdir: this.runtime.pkgdir,
      timeout,
      memoryLimit,
      outputMaxSize: this.runtime.output_max_size,
      stdin,
      extraPkgdirs,
    });
  }

  async execute(): Promise<ExecuteResult> {
    this.log.info({ runtime: this.runtime.language, version: this.runtime.version.raw }, 'Executing');

    const codeFiles = this.files.filter(
      f => !isDirkeep(f.name) && (!f.encoding || f.encoding === 'utf8'),
    );
    if (this.runtime.language !== 'file' && codeFiles.length === 0) {
      throw new ValidationError('files must include at least one runnable source file');
    }
    this.entryPointName = codeFiles[0]?.name;
    let compile: NsJailResult | undefined;
    let compileErrored = false;

    if (this.runtime.compiled) {
      this.log.info('Compiling');
      compile = await this.safeCall(
        'compile',
        codeFiles.map(f => f.name),
        this.timeouts.compile,
        this.cpu_times.compile,
        this.memory_limits.compile,
      );
      compileErrored = compile.code !== 0;
    }

    let run: NsJailResult | undefined;
    if (!compileErrored && codeFiles.length > 0) {
      this.log.info('Running');
      run = await this.safeCall(
        'run',
        [codeFiles[0].name, ...this.args],
        this.timeouts.run,
        this.cpu_times.run,
        this.memory_limits.run,
        this.stdin,
      );
    }

    await this.handleSessionFiles();

    return {
      compile,
      run,
      language: this.runtime.language,
      version: this.runtime.version.raw,
      session_id: this.uuid,
      files: this.sessionFiles,
    };
  }

  private async handleSessionFiles(): Promise<void> {
    this.generatedFiles = [];
    this.sessionFiles = [];
    this.inheritedRefs = [];

    const inputByName = new Map<string, TFile>();
    for (const f of this.files) inputByName.set(f.name, f);

    try {
      await this.walkDir(this.submissionDir, 0, inputByName);
    } catch (error) {
      this.log.error({ err: error }, 'Error scanning submission directory');
    }

    /* Generated files get priority in sessionFiles; fill remaining slots up
     * to max_output_files with inherited refs (unchanged downloaded inputs
     * and unchanged inherited .dirkeep markers). This bounds the response
     * at exactly max_output_files while preventing unchanged echoes from
     * crowding out real generated outputs. */
    const remaining = Math.max(0, config.max_output_files - this.sessionFiles.length);
    if (remaining > 0 && this.inheritedRefs.length > 0) {
      this.sessionFiles.push(...this.inheritedRefs.slice(0, remaining));
    }
  }

  /**
   * Classifies a dirent into dir/file/skip, falling back to lstat when the
   * filesystem returns DT_UNKNOWN (seen on some NFS/FUSE/overlay mounts).
   * Symlinks are always skipped.
   */
  private async classifyDirent(
    entry: fs.Dirent,
    fullPath: string,
    relativePath: string,
  ): Promise<'dir' | 'file' | 'skip'> {
    if (entry.isSymbolicLink()) return 'skip';
    let isDir = entry.isDirectory();
    let isRegularFile = entry.isFile();
    if (!isDir && !isRegularFile) {
      try {
        const st = await fsp.lstat(fullPath);
        if (st.isSymbolicLink()) return 'skip';
        isDir = st.isDirectory();
        isRegularFile = st.isFile();
      } catch (err) {
        this.log.debug({ path: relativePath, err }, 'walkDir: failed to lstat entry');
        return 'skip';
      }
    }
    if (isDir) return 'dir';
    if (isRegularFile) return 'file';
    return 'skip';
  }

  /**
   * Resolves the .dirkeep marker for a directory that walkDir determined to
   * be empty. Handles three cases: user-submitted inline .dirkeep (treat as
   * regular inline input), inherited session marker (echo or refresh based on
   * hash), and brand-new marker creation.
   */
  private async handleEmptyDirectory(
    relativePath: string,
    fullPath: string,
    inputByName: Map<string, TFile>,
  ): Promise<{ collected: boolean; truncated: boolean }> {
    const keepPath = path.join(relativePath, DIRKEEP);
    if (!isValidPathShape(keepPath)) return { collected: false, truncated: false };
    const keepFullPath = path.join(fullPath, DIRKEEP);
    const inheritedKeep = inputByName.get(keepPath);

    if (inheritedKeep && !inheritedKeep.id) {
      return this.handleInlineUserDirkeep(keepPath, keepFullPath);
    }
    if (inheritedKeep?.id && inheritedKeep.session_id) {
      return this.handleInheritedDirkeep(keepPath, keepFullPath, inheritedKeep);
    }
    return this.createDirkeepMarker(keepPath, keepFullPath);
  }

  /**
   * User-submitted inline file literally named `.dirkeep`: no id, real
   * content on disk. Always re-emit with a fresh id so the client has a
   * continuation reference (inline inputs have no persistent id). If the
   * file vanished mid-run, fall back to a synthesized marker so the empty
   * directory is still represented.
   */
  private async handleInlineUserDirkeep(
    keepPath: string,
    keepFullPath: string,
  ): Promise<{ collected: boolean; truncated: boolean }> {
    if (await this.inlineKeepVanished(keepPath, keepFullPath)) {
      return this.createDirkeepMarker(keepPath, keepFullPath);
    }
    if (this.generatedFiles.length >= config.max_output_files) {
      return { collected: false, truncated: true };
    }
    const id = nanoid();
    this.sessionFiles.push({ id, name: keepPath, session_id: this.uuid });
    this.generatedFiles.push({ id, name: keepPath, path: keepFullPath });
    return { collected: true, truncated: false };
  }

  /**
   * Detects the edge case where a user-submitted inline .dirkeep was written
   * during prime() but has since disappeared (sandboxed code deleted it).
   * Uses `fsp.access` as a cheap existence probe — the old code streamed
   * the file through SHA-256 and discarded the digest, which read the
   * entire file just to distinguish ENOENT from success.
   */
  private async inlineKeepVanished(
    keepPath: string,
    keepFullPath: string,
  ): Promise<boolean> {
    if (!this.inputFileHashes.has(keepPath)) return false;
    try {
      await fsp.access(keepFullPath);
      return false;
    } catch (err) {
      this.log.debug({ keepPath, err }, 'walkDir: user .dirkeep no longer accessible');
      return true;
    }
  }

  /**
   * Inherited .dirkeep from a prior session: if unchanged, echo via
   * inheritedRefs (no upload); if modified (rare — user wrote to it), emit
   * as a regenerated ref tagged with modified_from.
   */
  private async handleInheritedDirkeep(
    keepPath: string,
    keepFullPath: string,
    inheritedKeep: TFile,
  ): Promise<{ collected: boolean; truncated: boolean }> {
    const keepInfo = this.inputFileHashes.get(keepPath);
    const keepModified = await this.didInheritedKeepChange(keepPath, keepFullPath, keepInfo);

    /* Read-only inputs: see `tryEchoUnchangedInput` for the contract.
     * Modifications to a `read_only` `.dirkeep` are dropped on the floor —
     * we always echo the inherited ref so the caller sees the original
     * marker, never a refreshed/modified one. */
    if (!keepModified || keepInfo?.readOnly === true) return this.echoInheritedKeep(keepPath, inheritedKeep);

    if (this.generatedFiles.length >= config.max_output_files) {
      return { collected: false, truncated: true };
    }
    const refreshedId = nanoid();
    const refreshedRef: FileRef = { id: refreshedId, name: keepPath, session_id: this.uuid };
    if (keepInfo?.originalId && keepInfo.originalSessionId) {
      refreshedRef.modified_from = {
        id: keepInfo.originalId,
        session_id: keepInfo.originalSessionId,
      };
    }
    this.sessionFiles.push(refreshedRef);
    this.generatedFiles.push({ id: refreshedId, name: keepPath, path: keepFullPath });
    return { collected: true, truncated: false };
  }

  /**
   * True when we can prove via hash baseline that the inherited `.dirkeep`
   * file on disk differs from the bytes we downloaded. Returns `false` on
   * hash failure or when we have no baseline — treating the file as
   * unchanged keeps its id stable across continuations.
   */
  private async didInheritedKeepChange(
    keepPath: string,
    keepFullPath: string,
    keepInfo: InputFileInfo | undefined,
  ): Promise<boolean> {
    if (!keepInfo) return false;
    try {
      const currentHash = await this.computeFileHash(keepFullPath);
      return currentHash !== keepInfo.hash;
    } catch (err) {
      this.log.debug({ keepPath, err }, 'walkDir: failed to hash inherited .dirkeep');
      return false;
    }
  }

  private echoInheritedKeep(
    keepPath: string,
    inheritedKeep: TFile,
  ): { collected: boolean; truncated: boolean } {
    if (this.inheritedRefs.length >= config.max_output_files) {
      return { collected: false, truncated: true };
    }
    this.inheritedRefs.push({
      id: inheritedKeep.id!,
      name: keepPath,
      session_id: inheritedKeep.session_id!,
      inherited: true,
      ...(inheritedKeep.entity_id !== undefined
        ? { entity_id: inheritedKeep.entity_id }
        : {}),
    });
    return { collected: true, truncated: false };
  }

  /**
   * Writes a fresh empty .dirkeep marker for a genuinely empty directory.
   * Uses `flag: 'wx'` (O_CREAT|O_EXCL) so the write fails if `keepFullPath`
   * already exists in any form — crucial because a sandboxed program could
   * plant a symlink named `.dirkeep` pointing outside the sandbox; the
   * default `writeFile` follows symlinks and would clobber the target.
   */
  private async createDirkeepMarker(
    keepPath: string,
    keepFullPath: string,
  ): Promise<{ collected: boolean; truncated: boolean }> {
    if (this.generatedFiles.length >= config.max_output_files) {
      return { collected: false, truncated: true };
    }
    try {
      await fsp.writeFile(keepFullPath, '', { flag: 'wx' });
    } catch (err) {
      this.log.debug({ keepPath, err }, 'walkDir: failed to write .dirkeep marker');
      return { collected: false, truncated: false };
    }
    const id = nanoid();
    this.sessionFiles.push({ id, name: keepPath, session_id: this.uuid });
    this.generatedFiles.push({ id, name: keepPath, path: keepFullPath });
    return { collected: true, truncated: false };
  }

  /**
   * Decides whether an unchanged input file can be echoed without a fresh
   * upload. Returns the outcome for three cases or null to fall through to
   * generated-output emission:
   *   - unchanged downloaded input → push inherited ref (or mark truncated
   *     if the inherited-ref cap is reached)
   *   - unchanged inline entry-point source → skip without emit
   *   - anything else → null (caller should treat as generated)
   *
   * Extracted to keep handleRegularFile flat; also safer to echo only when
   * a hash baseline exists, since without one the bytes on disk must have
   * been produced by the current run and reusing the stale id would lie
   * to the caller about content.
   *
   * Read-only inputs are special-cased: when the input was uploaded with
   * `read_only=true` (skill files etc.), we ALWAYS echo as inherited even
   * if `wasModified === true`. The contract from upload time is "do not
   * surface modifications back to the client" — sandboxed-code edits are
   * dropped on the floor (filesystem-level chmod 444 is the primary
   * defense; this is the runtime backstop).
   */
  private tryEchoUnchangedInput(ctx: {
    wasModified: boolean;
    inputFileInfo: InputFileInfo | undefined;
    existingFile: TFile | undefined;
    relativePath: string;
  }): { collected: boolean; truncated: boolean } | null {
    const { wasModified, inputFileInfo, existingFile, relativePath } = ctx;
    const isReadOnly = inputFileInfo?.readOnly === true;
    if (wasModified && !isReadOnly) return null;
    if (!inputFileInfo) return null;
    if (!existingFile) return null;

    if (existingFile.id && existingFile.session_id) {
      if (this.inheritedRefs.length >= config.max_output_files) {
        return { collected: false, truncated: true };
      }
      this.inheritedRefs.push({
        id: existingFile.id,
        name: relativePath,
        session_id: existingFile.session_id,
        inherited: true,
        ...(existingFile.entity_id !== undefined
          ? { entity_id: existingFile.entity_id }
          : {}),
      });
      return { collected: true, truncated: false };
    }

    if (relativePath === this.entryPointName) {
      return { collected: true, truncated: false };
    }

    return null;
  }

  /**
   * Processes a regular (non-directory) dirent: size/extension filtering,
   * hash-based modification detection, and one of three outcomes — echo via
   * inheritedRefs for unchanged downloaded inputs, skip for unchanged
   * entry-point source, or emit as a generated output with a fresh id.
   * `stopLoop` signals the caller to break out of the readdir loop entirely
   * (generatedFiles cap hit).
   */
  private async handleRegularFile(
    entry: fs.Dirent,
    relativePath: string,
    fullPath: string,
    inputByName: Map<string, TFile>,
  ): Promise<{ collected: boolean; truncated: boolean; stopLoop: boolean }> {
    /* Go runtime emits `trim.txt` at the submission root as a build artifact
     * we never want to echo back. Scope to the exact root path so legitimate
     * user outputs like `reports/trim.txt` still get uploaded. */
    if (this.runtime.language === 'go' && relativePath === 'trim.txt') {
      return { collected: false, truncated: false, stopLoop: false };
    }
    /* Allow .dirkeep files through the extension filter so user-submitted
     * markers in non-empty directories are preserved; the empty-directory
     * branch handles the auto-generated case. */
    if (entry.name !== DIRKEEP) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.has(ext)) {
        return { collected: false, truncated: false, stopLoop: false };
      }
    }

    let size: number;
    try {
      /* Use lstat to stay consistent with classifyDirent's symlink filter —
       * following a symlink here would resurrect the exact escape vector
       * that the classification step already rejected. */
      size = (await fsp.lstat(fullPath)).size;
    } catch (err) {
      this.log.debug({ path: relativePath, err }, 'walkDir: unable to stat file');
      return { collected: false, truncated: false, stopLoop: false };
    }
    if (size > this.runtime.max_file_size) {
      return { collected: false, truncated: false, stopLoop: false };
    }

    const inputFileInfo = this.inputFileHashes.get(relativePath);
    const existingFile = inputByName.get(relativePath);
    let wasModified = false;

    if (inputFileInfo) {
      try {
        const currentHash = await this.computeFileHash(fullPath);
        wasModified = currentHash !== inputFileInfo.hash;
        if (wasModified) this.log.info({ file: relativePath }, 'Input file was modified');
      } catch (err) {
        this.log.debug({ path: relativePath, err }, 'walkDir: failed to hash file');
      }
    }

    const echoed = this.tryEchoUnchangedInput({
      wasModified,
      inputFileInfo,
      existingFile,
      relativePath,
    });
    if (echoed) return { ...echoed, stopLoop: false };

    if (this.generatedFiles.length >= config.max_output_files) {
      return { collected: false, truncated: true, stopLoop: true };
    }

    const newId = nanoid();
    const fileData: FileRef = { id: newId, name: relativePath, session_id: this.uuid };
    if (wasModified && inputFileInfo?.originalId && inputFileInfo.originalSessionId) {
      fileData.modified_from = {
        id: inputFileInfo.originalId,
        session_id: inputFileInfo.originalSessionId,
      };
    }
    this.sessionFiles.push(fileData);
    this.generatedFiles.push({ id: newId, name: relativePath, path: fullPath });
    return { collected: true, truncated: false, stopLoop: false };
  }

  /**
   * Recurses into a subdirectory and decides whether to synthesize a
   * `.dirkeep` marker when the subdir turns out to be empty. Flattens what
   * was previously a stack of nested ifs inside walkDir.
   */
  private async walkSubdirectory(
    relativePath: string,
    fullPath: string,
    parentDepth: number,
    inputByName: Map<string, TFile>,
  ): Promise<{ collected: boolean; truncated: boolean }> {
    const childStatus = await this.walkDir(fullPath, parentDepth + 1, inputByName);
    if (childStatus === 'collected') return { collected: true, truncated: false };
    if (childStatus === 'skipped') return { collected: false, truncated: true };
    if (this.isOutputCapFull()) return { collected: false, truncated: true };
    return this.handleEmptyDirectory(relativePath, fullPath, inputByName);
  }

  /**
   * Recursively scans the submission directory for output files. Returns a
   * status distinguishing truly empty directories from scans truncated by
   * depth/output caps, so .dirkeep markers are only written for genuinely
   * empty directories.
   */
  private async walkDir(
    dir: string,
    depth: number,
    inputByName: Map<string, TFile>,
  ): Promise<'collected' | 'empty' | 'skipped'> {
    if (depth >= config.max_nesting_depth) return 'skipped';
    if (this.isOutputCapFull()) return 'skipped';

    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      this.log.debug({ dir, err }, 'walkDir: unable to read directory');
      return 'skipped';
    }

    /** The PTC replay preamble injects a single tool-history fixture file at
     * `<submissionDir>/_ptc_history.json` so user code can read deterministic
     * cached results without going back to the service. It is runtime plumbing
     * and must never echo back as a session output. The previous prefix-form
     * (`_ptc_*`) silently ate any user file starting with `_ptc_`, which is a
     * regression for non-replay workloads — match the exact basename instead.
     * Tempfiles like `_ptc_pending.*` and `_ptc_counter.*` written by the bash
     * preamble live in `/tmp` and never reach the submission dir, so they
     * don't need walkDir-side filtering.
     *
     * NOTE: This MUST stay in sync with `PTC_HISTORY_FILENAME` in
     * `services/codeapi/service/src/ptc-constants.ts`. The two workspaces are
     * separate npm packages so we can't import directly; the filename literal
     * is asserted-equal in `service/scripts/test-ptc-sentinel.ts` to catch
     * accidental drift in CI. */
    const PTC_HISTORY_FILENAME = '_ptc_history.json';
    const isPtcReserved = (name: string): boolean => name === PTC_HISTORY_FILENAME;

    const nonDirkeepCount = entries.reduce(
      (n, e) => (e.name === DIRKEEP || isPtcReserved(e.name) ? n : n + 1),
      0,
    );

    let hasCollectedChild = false;
    let truncated = false;
    /* Hidden directories that we filtered out are still counted in
     * `nonDirkeepCount` (which is computed before classification). Track
     * them so the empty-vs-skipped decision below matches what walkDir
     * actually contributed: a `foo/` whose only entry is a filtered
     * `.cache/` is effectively empty from the user's perspective and
     * needs the `.dirkeep` marker to survive the next prime(), not the
     * `'skipped'` fall-through that suppresses marker creation. */
    let skippedHiddenDirs = 0;

    for (const entry of entries) {
      if (this.isOutputCapFull()) { truncated = true; break; }
      if (isPtcReserved(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(this.submissionDir, fullPath);
      if (!isValidPathShape(relativePath)) continue;

      const kind = await this.classifyDirent(entry, fullPath, relativePath);
      if (kind === 'skip') continue;

      if (kind === 'dir') {
        /* Skip hidden directories (basename starts with `.`) unless the user
         * explicitly primed something under them. Matplotlib, pip, and other
         * runtimes scatter `~/.cache/...` and `~/.config/...` caches inside
         * /mnt/data because the sandbox HOME points there — those are
         * runtime plumbing, not user artifacts, and surfacing them back as
         * "Generated files" pollutes the chip list and the next prime().
         * `.dirkeep` is a file, not a directory, so it's unaffected. */
        if (isHiddenDirectory(entry.name) && !inputsLiveUnder(inputByName, relativePath)) {
          this.log.debug({ path: relativePath }, 'walkDir: skipping hidden directory');
          skippedHiddenDirs++;
          continue;
        }
        const res = await this.walkSubdirectory(relativePath, fullPath, depth, inputByName);
        if (res.collected) hasCollectedChild = true;
        if (res.truncated) truncated = true;
        continue;
      }

      const res = await this.handleRegularFile(entry, relativePath, fullPath, inputByName);
      if (res.collected) hasCollectedChild = true;
      if (res.truncated) truncated = true;
      if (res.stopLoop) break;
    }

    if (hasCollectedChild) return 'collected';
    if (truncated) return 'skipped';
    /* Subtract filtered hidden dirs so a directory whose only contents
     * were runtime-cache pollution is treated as empty (gets a .dirkeep
     * marker) instead of silently disappearing on the next continuation. */
    return nonDirkeepCount - skippedHiddenDirs <= 0 ? 'empty' : 'skipped';
  }

  /**
   * IDs of files this job produced locally and is responsible for shipping
   * to the file server. Used by the v2 handler to distinguish "generated and
   * needs upload" from inherited refs (which already live on the server) so
   * upload failures only prune the at-risk subset.
   */
  getGeneratedFileIds(): string[] {
    return this.generatedFiles.map(f => f.id);
  }

  /**
   * Upload `generatedFiles` to the file server. Returns the set of file IDs
   * that were successfully transferred so callers can strip phantom IDs from
   * the execute() response — a file ID we minted locally but failed to ship
   * is not addressable on the next prime() and would surface as a `404`
   * storm of retries followed by a missing file.
   *
   * Each file is sent as a streaming `PUT /sessions/:session_id/objects/:id`
   * with `fs.createReadStream` piped via `Readable.toWeb`. This is the
   * lightest path the file-server exposes — the bytes are never held in JS
   * memory on the sandbox side, busboy never enters the picture, and minio
   * receives the stream directly. The previous implementation bundled all
   * files into a multipart POST and required reading every byte into a
   * `Blob`, ballooning resident memory under the `max_output_files *
   * max_file_size` cap (default 50 × 10MB = 500MB peak per job).
   *
   * Per-file PUTs run concurrently up to `config.upload_concurrency`; the
   * file-server keys by `(session_id, fileId)` so within-job requests don't
   * contend, but capping the fan-out keeps the open-fd + HTTP-connection
   * footprint sane when several concurrent jobs each try to ship 50 files.
   */
  async uploadGeneratedFiles(): Promise<Set<string>> {
    const uploaded = new Set<string>();
    if (this.generatedFiles.length === 0) return uploaded;

    const results = await mapWithConcurrency(
      this.generatedFiles,
      config.upload_concurrency,
      file => this.uploadOneFile(file),
    );
    for (const id of results) {
      if (id) uploaded.add(id);
    }

    if (uploaded.size < this.generatedFiles.length) {
      this.log.warn(
        { uploaded: uploaded.size, total: this.generatedFiles.length },
        'Some files failed to upload',
      );
    }
    return uploaded;
  }

  /**
   * Streams a single generated file to the file-server and returns its ID
   * on success or `null` on failure. Isolated to keep `uploadGeneratedFiles`
   * focused on aggregation. A separate `AbortController` per request
   * prevents one slow file from holding the rest up past the timeout.
   *
   * Uses `lstat` (not `stat`) to mirror the symlink-rejecting check
   * `walkDir`/`handleRegularFile` apply when the file is first
   * discovered: a malicious or buggy sandbox process could replace a
   * regular file with a symlink between scan and upload (TOCTOU), and
   * `stat` + `createReadStream` would silently follow it. The lstat
   * check here is a second line of defense.
   *
   * Always consumes (or cancels) the response body before returning.
   * Undici's connection pool keeps a socket reserved until the body is
   * fully read; with concurrent uploads, leaking unread bodies starves
   * the pool and stalls subsequent requests.
   */
  private async uploadOneFile(file: GeneratedFile): Promise<string | null> {
    if (!file?.path) return null;

    let size: number;
    try {
      const lstat = await fsp.lstat(file.path);
      if (lstat.isSymbolicLink()) {
        this.log.error({ file: file.name }, 'Refusing to upload a symlink');
        return null;
      }
      if (!lstat.isFile()) {
        this.log.error(
          { file: file.name },
          'Refusing to upload a non-regular file',
        );
        return null;
      }
      size = lstat.size;
    } catch (error) {
      this.log.error({ file: file.name, err: error }, 'Error stat-ing file before upload');
      return null;
    }

    const url = `${config.file_server_url}/sessions/${encodeURIComponent(this.uuid)}/objects/${encodeURIComponent(file.id)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const stream = fs.createReadStream(file.path);

    let response: Response | undefined;
    try {
      response = await fetch(url, {
        method: 'PUT',
        headers: internalServiceHeaders({
          /* file-server URL-decodes this header to recover the canonical
           * filename, so paths with `/` survive transport without colliding
           * with the `___` separators or RFC 5987 quoting rules used
           * elsewhere in the protocol. */
          'X-Original-Filename': encodeURIComponent(file.name),
          /* file-server stores this Content-Type as object metadata and
           * serves it back on download, so it has to reflect the real
           * media type — not a one-size-fits-all `octet-stream`. The
           * previous multipart path inferred this from the per-part
           * extension via FormData; we replicate that here. */
          'Content-Type': mimeTypeFor(file.name),
          'Content-Length': String(size),
        }),
        /* `Readable.toWeb` adapts the Node stream into a WHATWG
         * `ReadableStream` for fetch's body. The `duplex: 'half'` flag is
         * required by undici/Bun whenever the body is a stream. */
        body: Readable.toWeb(stream) as unknown as BodyInit,
        // @ts-expect-error — duplex is part of the fetch spec but missing
        // from lib.dom.d.ts in the version bundled with @types/bun.
        duplex: 'half',
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Upload HTTP error: ${response.status}`);
      }
      this.log.debug({ file: file.name, id: file.id, size }, 'Uploaded file');
      return file.id;
    } catch (error) {
      this.log.error({ file: file.name, err: error }, 'Error uploading file');
      return null;
    } finally {
      clearTimeout(timeout);
      stream.destroy();
      /* Drain or cancel the response body. Undici keeps the socket
       * reserved until the body is consumed; under concurrent uploads,
       * leaving bodies unread exhausts the connection pool and stalls
       * the next batch. `cancel()` is the cheapest path — the file-
       * server's reply is just a small JSON ack we don't need. */
      if (response?.body && !response.bodyUsed) {
        await response.body.cancel().catch(() => {
          /* Cancel can race with the connection closing on its own —
           * either way the socket is released, so swallow the error. */
        });
      }
    }
  }

  async cleanup(): Promise<void> {
    this.log.info('Cleaning up');
    remainingJobSpaces++;
    if (jobQueue.length > 0) {
      jobQueue.shift()!();
    }

    if (this.submissionDir) {
      try {
        await fsp.rm(this.submissionDir, { recursive: true, force: true });
      } catch (error) {
        this.log.error({ submissionDir: this.submissionDir, err: error }, 'Failed to clean up');
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
