import type { TFile } from './job';
import {
  EXECUTION_MANIFEST_HEADER,
  ExecutionManifestError,
  type ExecutionManifestClaims,
  type ExecutionManifestInputFile,
  verifyExecutionManifest,
} from './execution-manifest';

interface ExecuteRequestBody {
  session_id?: string;
  files?: TFile[];
}

interface PayloadFileRef {
  id: string;
  session_id?: string | null;
  name?: string;
}

function isPayloadFileRef(file: unknown): file is PayloadFileRef {
  return (
    file != null &&
    typeof file === 'object' &&
    typeof (file as Record<string, unknown>).id === 'string' &&
    (file as Record<string, unknown>).id !== ''
  );
}

function fileKey(file: ExecutionManifestInputFile): string {
  return `${file.session_id}\0${file.id}\0${file.name}`;
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function collectExecuteRequestInputFiles(body: ExecuteRequestBody): ExecutionManifestInputFile[] {
  const files = Array.isArray(body.files) ? body.files : [];
  return files
    .map((file, index) => {
      if (!isPayloadFileRef(file)) return null;
      const sessionId = typeof file.session_id === 'string' ? file.session_id : body.session_id;
      if (!sessionId) {
        throw new ExecutionManifestError('scope_mismatch', 'Execution manifest input file scope does not match request');
      }
      return {
        id: file.id,
        session_id: sessionId,
        name: typeof file.name === 'string' && file.name ? file.name : `file${index}.code`,
      };
    })
    .filter((file): file is ExecutionManifestInputFile => file != null)
    .sort((a, b) => (
      a.session_id.localeCompare(b.session_id) ||
      a.id.localeCompare(b.id) ||
      a.name.localeCompare(b.name)
    ));
}

export function assertManifestMatchesExecuteRequest(
  manifest: ExecutionManifestClaims,
  body: ExecuteRequestBody,
): void {
  if (!body.session_id || manifest.output_session_id !== body.session_id) {
    throw new ExecutionManifestError('scope_mismatch', 'Execution manifest output session does not match request');
  }

  const requestFiles = collectExecuteRequestInputFiles(body);
  const manifestFiles = [...manifest.input_files].sort((a, b) => (
    a.session_id.localeCompare(b.session_id) ||
    a.id.localeCompare(b.id) ||
    a.name.localeCompare(b.name)
  ));
  if (requestFiles.length !== manifestFiles.length) {
    throw new ExecutionManifestError('scope_mismatch', 'Execution manifest input file scope does not match request');
  }

  const requestFileKeys = requestFiles.map(fileKey);
  const manifestFileKeys = manifestFiles.map(fileKey);
  if (!stringArraysEqual(requestFileKeys, manifestFileKeys)) {
    throw new ExecutionManifestError('scope_mismatch', 'Execution manifest input file scope does not match request');
  }

  const expectedReadSessions = Array.from(new Set(requestFiles.map(file => file.session_id))).sort();
  const manifestReadSessions = [...manifest.read_sessions].sort();
  if (!stringArraysEqual(expectedReadSessions, manifestReadSessions)) {
    throw new ExecutionManifestError('scope_mismatch', 'Execution manifest read sessions do not match request');
  }
}

export function verifyExecuteRequestManifest(args: {
  headerValue: string | undefined;
  secret: string;
  body: ExecuteRequestBody;
  nowSeconds?: number;
}): ExecutionManifestClaims {
  if (!args.headerValue) {
    throw new ExecutionManifestError('missing_header', `${EXECUTION_MANIFEST_HEADER} is required`);
  }
  const manifest = verifyExecutionManifest(args.headerValue, args.secret, {
    nowSeconds: args.nowSeconds,
  });
  assertManifestMatchesExecuteRequest(manifest, args.body);
  return manifest;
}
