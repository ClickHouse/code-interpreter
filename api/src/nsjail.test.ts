import { describe, expect, test } from 'bun:test';
import { buildArgs } from './nsjail';

function valueAfter(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function seccompPolicy(): string {
  const args = buildArgs({
    logPath: '/tmp/nsjail-test.log',
    submissionDir: '/tmp/sandbox/ws_test',
    pkgdir: '/pkgs/python/3.14.4',
    timeout: 1000,
    memoryLimit: -1,
    envVars: {},
    command: ['/bin/bash', '/pkgs/python/3.14.4/run', 'main.py'],
    identity: { slot: 0, uid: 65534, gid: 65534, perJobUid: false },
  });
  const policy = valueAfter(args, '--seccomp_string');
  if (!policy) throw new Error('seccomp policy not present in nsjail args');
  return policy;
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

describe('NsJail seccomp policy', () => {
  /* These tests are regression coverage for the seccomp-hardening audit
   * (see PR description). They check the rendered Kafel source, not the
   * BPF program — that's enough to catch accidental removal of a rule, and
   * the actual BPF behavior is exercised end-to-end by the runner image. */

  test('KILLs setns to close the namespace-join surface that unshare already covers', () => {
    /* `\b` ensures we don't accidentally pick up substrings like
     * `setnsxxx`; the comma OR closing-brace bound matches Kafel syntax. */
    expect(seccompPolicy()).toMatch(/\bsetns\b[,\s]/);
  });

  test('KILLs the new mount API family (Linux 5.2+)', () => {
    const policy = seccompPolicy();
    for (const name of ['move_mount', 'open_tree', 'fsopen', 'fsmount', 'fspick']) {
      expect(policy).toMatch(new RegExp(`\\b${name}\\b[,\\s]`));
    }
  });

  test('defines explicit syscall numbers for the new mount API (avoids Kafel symbol drift)', () => {
    const policy = seccompPolicy();
    expect(policy).toContain('#define open_tree 428');
    expect(policy).toContain('#define move_mount 429');
    expect(policy).toContain('#define fsopen 430');
    expect(policy).toContain('#define fsmount 432');
    expect(policy).toContain('#define fspick 433');
  });

  test('rejects AF_VSOCK in the socket(domain) filter', () => {
    const policy = seccompPolicy();
    expect(policy).toContain('#define AF_VSOCK 40');
    /* Same line that already denies AF_INET / AF_NETLINK / AF_ALG must
     * extend to AF_VSOCK. Anchor on `socket(domain)` so we are sure we
     * are looking at the right rule, not a stray mention. */
    const socketRule = policy.split('\n').find(line => line.includes('socket(domain)'));
    expect(socketRule).toBeDefined();
    expect(socketRule).toContain('AF_VSOCK');
  });

  test('KILLs the defense-in-depth batch from the audit', () => {
    const policy = seccompPolicy();
    for (const name of ['settimeofday', 'adjtimex', 'clock_adjtime', 'syslog']) {
      expect(policy).toMatch(new RegExp(`\\b${name}\\b[,\\s]`));
    }
  });

  test('x86-only syscalls are gated on architecture', () => {
    const policy = seccompPolicy();
    const x86Only = ['ioperm', 'iopl', 'modify_ldt', 'lookup_dcookie'];
    if (process.arch === 'arm64') {
      /* arm64 must NOT mention these — Kafel will fail to parse a symbol
       * that has no #define and no entry in its syscall table for the
       * current architecture. */
      for (const name of x86Only) {
        expect(policy).not.toMatch(new RegExp(`\\b${name}\\b`));
      }
    } else {
      for (const name of x86Only) {
        expect(policy).toMatch(new RegExp(`\\b${name}\\b[,\\s]`));
      }
    }
  });

  test('preserves the previously-blocked surface (regression guard)', () => {
    const policy = seccompPolicy();
    /* If a future edit accidentally drops one of these, this test will
     * catch it before the policy ships. Not exhaustive — just the entries
     * that have been audit-critical historically. */
    for (const name of [
      'ptrace', 'memfd_create', 'userfaultfd',
      'mount', 'umount2', 'pivot_root',
      'init_module', 'finit_module', 'delete_module',
      'unshare', 'seccomp',
      'process_vm_readv', 'process_vm_writev',
      'add_key', 'request_key', 'keyctl',
      'swapon', 'swapoff', 'reboot',
    ]) {
      expect(policy).toMatch(new RegExp(`\\b${name}\\b[,\\s]`));
    }
  });

  test('does not emit a blank Kafel line on arm64 (filter strips empty arch slot)', () => {
    /* archSpecificLowPrioritySyscalls is '' on arm64; if we forget to
     * filter empty entries out of the joined policy, Kafel parses a blank
     * line and rejects it. */
    const policy = seccompPolicy();
    expect(policy.split('\n').every(line => line.length > 0)).toBe(true);
  });
});
