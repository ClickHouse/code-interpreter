import { describe, expect, test } from 'bun:test';
import * as semver from 'semver';
import { Job } from './job';
import type { Runtime } from './runtime';
import { sandboxJobUidPool, type SandboxJobIdentity } from './workspace-isolation';

interface CleanupInternals {
  jobIdentity?: SandboxJobIdentity;
}

function makeRuntime(): Runtime {
  return {
    language: 'bash',
    version: new semver.SemVer('5.2.0'),
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

function makeJob(): Job {
  return new Job({
    session_id: 'cleanup-test',
    runtime: makeRuntime(),
    files: [],
    args: [],
    stdin: '',
    timeouts: { compile: 5000, run: 5000 },
    cpu_times: { compile: 5000, run: 5000 },
    memory_limits: { compile: 100_000_000, run: 100_000_000 },
  });
}

function asCleanupInternals(job: Job): CleanupInternals {
  return job as unknown as CleanupInternals;
}

describe('Job cleanup', () => {
  test('releases a UID slot when prime fails before a workspace lease is created', async () => {
    const availableBefore = sandboxJobUidPool.availableCount();
    const activeBefore = sandboxJobUidPool.activeCount();
    const identity = sandboxJobUidPool.acquire();
    expect(identity).not.toBeNull();
    expect(sandboxJobUidPool.availableCount()).toBe(availableBefore - 1);
    expect(sandboxJobUidPool.activeCount()).toBe(activeBefore + 1);

    const job = makeJob();
    asCleanupInternals(job).jobIdentity = identity!;
    await job.cleanup();

    expect(sandboxJobUidPool.availableCount()).toBe(availableBefore);
    expect(sandboxJobUidPool.activeCount()).toBe(activeBefore);
  });
});
