import { spawn } from 'child_process';
import { logger } from './logger';

export type WarmupOutcome = 'skipped' | 'completed' | 'failed' | 'timed_out';

/**
 * Bounded warmup command run once at sandbox-API startup, OUTSIDE any job
 * sandbox and before the HTTP listener becomes ready.
 *
 * Purpose: pre-fault large read-mostly assets into the VM's page cache before
 * the first real job needs them. MicroVM rootfs reads are lazy and slow on
 * first touch, so a heavyweight import (e.g. chdb's ~400MB shared object) can
 * take 30-120s cold but milliseconds warm — a boot-time
 * `SANDBOX_WARMUP_COMMAND="/pkgs/python/3.14.4/bin/python3 -c 'import chdb'"`
 * moves that cost into the boot window instead of racing the user's first job.
 *
 * Failures stay best-effort (logged, then startup continues), but completion is
 * awaited and bounded. This is important for Lambda MicroVM images: snapshotting
 * a still-running detached warmup would clone that process into every VM and
 * would not guarantee warm state before the endpoint became reachable.
 */
export async function startWarmupCommand(
  command = process.env.SANDBOX_WARMUP_COMMAND,
  timeoutMs = Number(process.env.SANDBOX_WARMUP_TIMEOUT_MS) || 180_000,
): Promise<WarmupOutcome> {
  if (command == null || command.trim() === '') {
    return 'skipped';
  }
  const boundedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.floor(timeoutMs)
    : 180_000;
  const startedAt = Date.now();
  return new Promise<WarmupOutcome>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: WarmupOutcome, code?: number | null, err?: unknown): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const details = { command, code, elapsedMs: Date.now() - startedAt, err };
      if (outcome === 'completed') logger.info(details, 'Sandbox warmup command finished');
      else logger.warn(details, `Sandbox warmup command ${outcome.replace('_', ' ')}`);
      resolve(outcome);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('bash', ['-c', command], {
        detached: true,
        stdio: 'ignore',
      });
    } catch (err) {
      finish('failed', undefined, err);
      return;
    }
    child.once('exit', code => finish(code === 0 ? 'completed' : 'failed', code));
    child.once('error', err => finish('failed', undefined, err));
    timer = setTimeout(() => {
      try {
        if (child.pid != null && process.platform !== 'win32') {
          process.kill(-child.pid, 'SIGKILL');
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        child.kill('SIGKILL');
      }
      finish('timed_out');
    }, boundedTimeoutMs);
    logger.info({ command, timeoutMs: boundedTimeoutMs }, 'Sandbox warmup command started');
  });
}
