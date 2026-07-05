import { createHash } from 'crypto';

export const RUNTIME_SESSION_HINT_MAX_LENGTH = 128;
const RUNTIME_SESSION_HINT_PATTERN = /^[A-Za-z0-9._:-]+$/;
const DEFAULT_HINT = 'default';

export class RuntimeSessionHintError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeSessionHintError';
  }
}

/** Normalizes the client-supplied hint: absent/empty ⇒ undefined, malformed ⇒ 400. */
export function validateRuntimeSessionHint(hint: unknown): string | undefined {
  if (hint == null) return undefined;
  if (typeof hint !== 'string') {
    throw new RuntimeSessionHintError('runtime_session_hint must be a string');
  }
  if (hint.length === 0) return undefined;
  if (hint.length > RUNTIME_SESSION_HINT_MAX_LENGTH) {
    throw new RuntimeSessionHintError(
      `runtime_session_hint must be at most ${RUNTIME_SESSION_HINT_MAX_LENGTH} characters`,
    );
  }
  if (!RUNTIME_SESSION_HINT_PATTERN.test(hint)) {
    throw new RuntimeSessionHintError(
      'runtime_session_hint may only contain letters, digits, ".", "_", ":", and "-"',
    );
  }
  return hint;
}

/**
 * Server-derived runtime session identity. The namespace and user come from
 * `getExecutionIdentity(req)` — never the client — so a hint can never
 * collide across tenants or users. The hint only partitions sessions within
 * one (tenant, user) scope.
 */
export function deriveRuntimeSessionId(args: {
  storageNamespace: string;
  canonicalUserId: string;
  hint?: string;
}): string {
  const material = `${args.storageNamespace}\u0000${args.canonicalUserId}\u0000${args.hint ?? DEFAULT_HINT}`;
  return `rt_${createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 40)}`;
}

/** Router-side gate: stateless mode never derives a runtime session. */
export function resolveRuntimeSessionIdForRequest(args: {
  mode: 'stateless' | 'affinity' | 'strict';
  storageNamespace: string;
  canonicalUserId: string;
  hint?: string;
}): string | undefined {
  if (args.mode === 'stateless') return undefined;
  return deriveRuntimeSessionId(args);
}
