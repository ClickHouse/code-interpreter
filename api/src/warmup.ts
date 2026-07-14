import { spawn } from 'child_process';
import { logger } from './logger';

/**
 * Fire-and-forget warmup command run once at sandbox-API startup, OUTSIDE any
 * job sandbox, so it survives across jobs and never holds a session lock.
 *
 * Purpose: pre-fault large read-mostly assets into the VM's page cache before
 * the first real job needs them. MicroVM rootfs reads are lazy and slow on
 * first touch, so a heavyweight import (e.g. chdb's ~400MB shared object) can
 * take 30-120s cold but milliseconds warm — a boot-time
 * `SANDBOX_WARMUP_COMMAND="python3 -c 'import chdb'"` moves that cost into
 * the boot window instead of the user's first tool call.
 *
 * Deliberately best-effort: failures are logged and ignored, output is
 * discarded, and the child is detached + unref'd so it can never block
 * startup, readiness, or shutdown.
 */
export function startWarmupCommand(command = process.env.SANDBOX_WARMUP_COMMAND): void {
  if (command == null || command.trim() === '') {
    return;
  }
  try {
    const startedAt = Date.now();
    const child = spawn('bash', ['-c', command], {
      detached: true,
      stdio: 'ignore',
    });
    child.once('exit', (code) => {
      logger.info(
        { code, elapsedMs: Date.now() - startedAt },
        'Sandbox warmup command finished',
      );
    });
    child.once('error', (err) => {
      logger.warn({ err }, 'Sandbox warmup command failed to spawn');
    });
    child.unref();
    logger.info({ command }, 'Sandbox warmup command started');
  } catch (err) {
    logger.warn({ err }, 'Sandbox warmup command failed to start');
  }
}
