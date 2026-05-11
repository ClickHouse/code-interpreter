import { describe, expect, test } from 'bun:test';
import { buildArgs } from './nsjail';

function valueAfter(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

describe('NsJail args', () => {
  test('passes dynamic per-job UID/GID mappings', () => {
    const args = buildArgs({
      logPath: '/tmp/nsjail-test.log',
      submissionDir: '/tmp/sandbox/ws_test',
      pkgdir: '/pkgs/python/3.14.4',
      timeout: 1000,
      memoryLimit: -1,
      envVars: {},
      command: ['/bin/bash', '/pkgs/python/3.14.4/run', 'main.py'],
      identity: {
        slot: 2,
        uid: 200002,
        gid: 300002,
        perJobUid: true,
      },
    });

    expect(valueAfter(args, '--user')).toBe('65534:200002:1');
    expect(valueAfter(args, '--group')).toBe('65534:300002:1');
    expect(args).toContain('-B');
    expect(args).toContain('/tmp/sandbox/ws_test:/mnt/data');
  });
});
