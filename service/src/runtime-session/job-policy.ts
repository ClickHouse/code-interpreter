import type { RuntimeSessionExemption } from '../types';

export const PROGRAMMATIC_RUNTIME_SESSION_EXEMPTION: RuntimeSessionExemption = 'programmatic';

/**
 * Resolve the session identity a worker is allowed to pass to its backend.
 * Programmatic/replay jobs intentionally remain stateless until PTC can be
 * bound to a warm session safely; the explicit queue marker makes that
 * exception distinguishable from an ordinary `/exec` producer bug.
 */
export function resolveRuntimeSessionIdForJob(args: {
  mode: 'stateless' | 'affinity' | 'strict';
  runtimeSessionId?: string;
  runtimeSessionExemption?: RuntimeSessionExemption;
  isSynthetic: boolean;
}): string | undefined {
  if (
    args.isSynthetic
    || args.runtimeSessionExemption === PROGRAMMATIC_RUNTIME_SESSION_EXEMPTION
  ) {
    return undefined;
  }
  if (args.mode === 'strict' && !args.runtimeSessionId) {
    throw new Error('strict runtime session mode requires a runtimeSessionId on the job');
  }
  return args.runtimeSessionId;
}
