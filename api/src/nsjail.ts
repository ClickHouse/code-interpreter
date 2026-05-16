import * as fs from 'fs';
import * as path from 'path';
import { nanoid } from 'nanoid';
import { config } from './config';
import { logger } from './logger';
import { defaultNsJailSetupGate, type NsJailSetupGate } from './nsjail-setup-gate';
import { nsjailSetupGateWatchdogFires } from './metrics';
import { SANDBOX_INSIDE_GID, SANDBOX_INSIDE_UID, type SandboxJobIdentity } from './workspace-isolation';

export interface NsJailResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
  output: string;
  memory: number | null;
  message: string | null;
  status: string | null;
  cpu_time: number | null;
  wall_time: number | null;
}

const SIGNALS: Record<number, string> = {
  1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 4: 'SIGILL',
  5: 'SIGTRAP', 6: 'SIGABRT', 7: 'SIGBUS', 8: 'SIGFPE',
  9: 'SIGKILL', 10: 'SIGUSR1', 11: 'SIGSEGV', 12: 'SIGUSR2',
  13: 'SIGPIPE', 14: 'SIGALRM', 15: 'SIGTERM', 24: 'SIGXCPU',
  25: 'SIGXFSZ', 31: 'SIGSYS',
};

const TIME_LIMIT_RE = /time limit/i;
const OOM_RE = /cgroup.*oom|out of memory|mem_max/i;
const SIGNAL_RE = /exited with.*signal.*?(\d+)/;

/* New-mount-API syscall numbers are shared between x86_64 and arm64 (Linux
 * 5.2 onwards). Defining them explicitly avoids relying on the bundled Kafel
 * symbol table knowing the names — NsJail pins an older Kafel snapshot. */
const sharedSyscallDefines = [
  '#define io_uring_setup 425',
  '#define io_uring_enter 426',
  '#define io_uring_register 427',
  '#define clone3 435',
  '#define open_tree 428',
  '#define move_mount 429',
  '#define fsopen 430',
  '#define fsmount 432',
  '#define fspick 433',
  /* pidfd_* are Linux 5.1+/5.3+ — newer than Kafel's bundled symbol
   * table on the pinned NsJail snapshot, so define numerically. Same
   * number on x86_64 and arm64. */
  '#define pidfd_send_signal 424',
  '#define pidfd_open 434',
];

const syscallDefines = process.arch === 'arm64'
  ? [
      ...sharedSyscallDefines,
      '#define umount2 39',
      '#define seccomp 277',
      '#define setns 268',
      '#define syslog 116',
      '#define settimeofday 170',
      '#define adjtimex 171',
      '#define clock_adjtime 266',
      /* ioperm, iopl, modify_ldt are x86-only; lookup_dcookie was deprecated
       * upstream and is not present on arm64 in recent kernels. */
    ]
  : [
      ...sharedSyscallDefines,
      '#define umount2 166',
      '#define seccomp 317',
      '#define kexec_file_load 320',
      '#define setns 308',
      '#define syslog 103',
      '#define settimeofday 164',
      '#define adjtimex 159',
      '#define clock_adjtime 305',
      '#define ioperm 173',
      '#define iopl 172',
      '#define modify_ldt 154',
      '#define lookup_dcookie 212',
    ];

const kexecSyscalls = process.arch === 'arm64'
  ? '    kexec_load, bpf, perf_event_open,'
  : '    kexec_load, kexec_file_load, bpf, perf_event_open,';

/* x86-only syscalls that must not appear in the arm64 policy or Kafel will
 * fail to parse (the symbol/define is absent). lookup_dcookie was deprecated
 * upstream and removed in recent kernels; keeping it on x86_64 is defense-
 * in-depth, dropped on arm64 where the syscall slot is unused. */
const archSpecificLowPrioritySyscalls = process.arch === 'arm64'
  ? ''
  : '    ioperm, iopl, modify_ldt, lookup_dcookie,';

const SECCOMP_POLICY = [
  ...syscallDefines,
  '#define AF_INET 2',
  '#define AF_INET6 10',
  '#define AF_NETLINK 16',
  '#define AF_KEY 15',
  '#define AF_RXRPC 33',
  '#define AF_ALG 38',
  '#define AF_VSOCK 40',
  '#define CLONE_NAMESPACE_FLAGS 0x7e020000',
  '#define KVM_IOCTL_MAGIC 0xAE00',
  'POLICY sandbox {',
  '  KILL {',
  '    ptrace, memfd_create, personality, userfaultfd,',
  kexecSyscalls,
  '    add_key, request_key, keyctl,',
  '    mount, umount2, pivot_root,',
  /* New mount API (Linux 5.2+) — orthogonal to mount(2) and not covered by
   * the line above. open_tree+move_mount can replicate a bind-mount; fsopen/
   * fsmount/fspick form the new filesystem-context flow. Block all five. */
  '    move_mount, open_tree, fsopen, fsmount, fspick,',
  '    swapon, swapoff, reboot,',
  '    init_module, finit_module, delete_module,',
  /* setns joins an existing namespace via fd. Unshare is already blocked
   * above; setns closes the other side of that surface. */
  '    unshare, setns, seccomp,',
  '    process_vm_readv, process_vm_writev,',
  '    acct, quotactl,',
  /* Defense-in-depth batch (kernel returns EPERM/ENOSYS without caps, but
   * an explicit KILL surfaces the intent and protects against future kernel
   * config drift). settimeofday/adjtimex/clock_adjtime: clock manipulation.
   * syslog: kernel ring buffer. ioperm/iopl/modify_ldt: x86 ring-0-adjacent
   * surfaces. lookup_dcookie: profiling, deprecated upstream. */
  '    settimeofday, adjtimex, clock_adjtime, syslog,',
  archSpecificLowPrioritySyscalls,
  '    ioctl(fd, request) { (request & 0xFF00) == KVM_IOCTL_MAGIC }',
  '  },',
  '  ERRNO(38) {',
  '    clone3',
  '  },',
  '  ERRNO(1) {',
  '    io_uring_setup, io_uring_enter, io_uring_register, sched_setaffinity, vmsplice,',
  '    clone(flags) { (flags & CLONE_NAMESPACE_FLAGS) != 0 },',
  /* Block signals to PID 1 of the sandbox PID namespace (the NsJail
   * monitor). With clone_newpid the user can't reach other tenants — but
   * killing their own ns's PID 1 still races NsJail's cleanup ordering and
   * the supervisor shouldn't be reachable from inside the sandbox. Also
   * blocks process-group (pid==0) and "everything signalable" (pid==-1)
   * forms which would catch the monitor in their fan-out. ERRNO(1) (EPERM)
   * matches the kernel's standard "you may not signal init" behavior so
   * runtimes that probe with kill(pid, 0) get a familiar error instead
   * of a SIGSYS-killed process. */
  '    kill(pid) { pid == 0 || pid == 1 || pid == 0xFFFFFFFF },',
  '    tkill(tid) { tid == 1 },',
  '    tgkill(tgid, tid) { tgid == 1 || tid == 1 },',
  '    rt_sigqueueinfo(pid) { pid == 0 || pid == 1 || pid == 0xFFFFFFFF },',
  '    rt_tgsigqueueinfo(tgid, tid) { tgid == 1 || tid == 1 },',
  /* pidfd_open(pid==1) would hand out a pidfd to the monitor; block at
   * acquisition. pidfd_send_signal targets a pidfd (not a numeric pid)
   * so we can't filter by destination — but a pidfd to PID 1 can also be
   * obtained via openat("/proc/1", O_RDONLY) since Linux 5.4, so refuse
   * the syscall outright. Neither call is used by Python/Node/Bun
   * runtimes the sandbox supports. */
  '    pidfd_open(pid) { pid == 1 },',
  '    pidfd_send_signal,',
  /* AF_VSOCK reaches the host hypervisor on KVM-based runners (the runner
   * launcher uses krun -> libkrun; the guest sees virtio-vsock). Audit
   * showed a VSOCK socket() succeeded and connect() hung instead of
   * returning ENETUNREACH — that surface should not be reachable from
   * sandboxed code. */
  '    socket(domain) { domain == AF_INET || domain == AF_INET6 || domain == AF_NETLINK || domain == AF_KEY || domain == AF_RXRPC || domain == AF_ALG || domain == AF_VSOCK }',
  '  }',
  '}',
  'USE sandbox DEFAULT ALLOW',
].filter(line => line !== '').join('\n');

export { SIGNALS };

/* Base sandbox.cfg cached at module load. Per-job runs append a dynamic
 * /mnt/data mount block (see renderJobConfigOverlay) so the bind can carry
 * noexec/nosuid/nodev — flags NsJail's CLI -B form does not accept. */
let cachedBaseConfig: string | null = null;
function readBaseConfig(): string {
  if (cachedBaseConfig === null) {
    cachedBaseConfig = fs.readFileSync(config.nsjail_config, 'utf8');
  }
  return cachedBaseConfig;
}

/* Render a `mount {}` block that binds `submissionDir` at /mnt/data with
 * noexec/nosuid/nodev. The destination is fixed; the source path is the
 * per-job workspace. Path comes from createSandboxWorkspace and lives
 * under a known prefix (no user-controlled bytes), but we still escape
 * embedded backslashes and double-quotes defensively in case future
 * callers pass arbitrary paths in. The cfg syntax is C-like so only those
 * two characters need escaping inside a string literal. */
export function renderJobConfigOverlay(submissionDir: string): string {
  const escaped = submissionDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return [
    '',
    '# Per-job submission workspace bind. Dynamic because the source path',
    '# rotates every execution. noexec/nosuid/nodev block the audit pattern',
    '# of `chmod +x /mnt/data/x.sh && /mnt/data/x.sh` — neither user code',
    '# nor any helper can run a binary from the writable scratch dir.',
    'mount {',
    `    src: "${escaped}"`,
    '    dst: "/mnt/data"',
    '    is_bind: true',
    '    rw: true',
    '    noexec: true',
    '    nosuid: true',
    '    nodev: true',
    '}',
    '',
  ].join('\n');
}

interface ExecuteOptions {
  command: string[];
  envVars: Record<string, string>;
  submissionDir: string;
  pkgdir: string;
  timeout: number;
  memoryLimit: number;
  outputMaxSize: number;
  stdin?: string;
  extraPkgdirs?: string[];
  identity: SandboxJobIdentity;
}

export async function execute(opts: ExecuteOptions, setupGate: NsJailSetupGate = defaultNsJailSetupGate): Promise<NsJailResult> {
  const { command, envVars, submissionDir, pkgdir, timeout, memoryLimit, outputMaxSize, stdin, extraPkgdirs, identity } = opts;
  const logId = nanoid();
  const logPath = `/tmp/nsjail-${logId}.log`;
  const cfgPath = `/tmp/nsjail-${logId}.cfg`;

  fs.writeFileSync(cfgPath, readBaseConfig() + renderJobConfigOverlay(submissionDir), { mode: 0o600 });

  const nsjailArgs = buildArgs({
    logPath,
    cfgPath,
    pkgdir,
    timeout,
    memoryLimit,
    envVars,
    command,
    extraPkgdirs,
    identity,
  });

  const startTime = Date.now();
  const hasStdin = stdin !== undefined && stdin.length > 0;

  /* NsJail's mount-setup phase races on the host-shared `/tmp/nsjail.0.root`
   * directory when multiple jails launch concurrently in the same pod (root
   * runner -> orig_uid=0 in NsJail's per-uid setup dir name). The gate
   * serializes only spawn() -> "Executing" log marker, then releases so the
   * inner job runs in parallel with siblings. */
  let proc: ReturnType<typeof Bun.spawn>;
  let markerSeen = false;
  let pollError: NodeJS.ErrnoException | undefined;
  try {
    ({ value: proc, markerSeen, pollError } = await setupGate.runSetup(logPath, () =>
      Bun.spawn([config.nsjail_path, ...nsjailArgs], {
        stdin: hasStdin ? 'pipe' : 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    ));
  } catch (err) {
    try { fs.unlinkSync(logPath); } catch { /* ignore */ }
    try { fs.unlinkSync(cfgPath); } catch { /* ignore */ }
    throw new Error(`Failed to spawn nsjail: ${(err as Error).message}`);
  }
  if (!markerSeen) {
    /* The watchdog fired before NsJail logged its post-mount marker. The
     * child may still finish successfully — but if multiple jobs trip the
     * watchdog in a row we're back to overlapping setups, so the operator
     * needs to see this. `pollError`, when present, is the last reason the
     * log was unreadable (EACCES on a chmod race, EISDIR if the path got
     * replaced, EIO, ...) which is far more diagnostic than a bare timeout. */
    logger.warn(
      { logId, pollError: pollError && { code: pollError.code, message: pollError.message } },
      'nsjail setup gate watchdog fired before "Executing" marker',
    );
    nsjailSetupGateWatchdogFires.inc();
  }

  if (hasStdin) {
    const stdinSink = proc.stdin as import('bun').FileSink;
    stdinSink.write(stdin!);
    stdinSink.end();
  }

  let stdout = '';
  let stderr = '';
  let output = '';
  let killed = false;
  let killMessage: string | null = null;
  let killStatus: string | null = null;

  async function drainStream(
    stream: ReadableStream<Uint8Array>,
    target: 'stdout' | 'stderr',
  ): Promise<void> {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });

        if (target === 'stdout') {
          if (stdout.length + chunk.length > outputMaxSize) {
            const remaining = outputMaxSize - stdout.length;
            if (remaining > 0) {
              stdout += chunk.slice(0, remaining);
              output += chunk.slice(0, remaining);
            }
            if (!killed) {
              killMessage = 'stdout length exceeded';
              killStatus = 'OL';
              killed = true;
              proc.kill('SIGKILL');
            }
            continue;
          }
          stdout += chunk;
          output += chunk;
        } else {
          if (stderr.length + chunk.length > outputMaxSize) {
            const remaining = outputMaxSize - stderr.length;
            if (remaining > 0) {
              stderr += chunk.slice(0, remaining);
              output += chunk.slice(0, remaining);
            }
            if (!killed) {
              killMessage = 'stderr length exceeded';
              killStatus = 'EL';
              killed = true;
              proc.kill('SIGKILL');
            }
            continue;
          }
          stderr += chunk;
          output += chunk;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  await Promise.all([
    drainStream(proc.stdout as ReadableStream<Uint8Array>, 'stdout'),
    drainStream(proc.stderr as ReadableStream<Uint8Array>, 'stderr'),
  ]);

  const exitCode = await proc.exited;
  const wallTime = Date.now() - startTime;

  // Log memory metrics after each execution to track potential leaks.
  // Reads from /proc/self/cgroup to find the actual cgroup path, then reads
  // memory.current and memory.stat from that cgroup.
  // Distinguishes real usage (anon) from reclaimable kernel page cache (file).
  try {
    const cgroupLine = fs.readFileSync('/proc/self/cgroup', 'utf8').trim();
    // cgroup v2 format: "0::<path>"
    const cgroupPath = cgroupLine.split('\n').find(l => l.startsWith('0::'))?.split('::')[1] ?? '/';
    const cgroupFsPath = `/sys/fs/cgroup${cgroupPath}`;

    const memoryCurrent = fs.readFileSync(`${cgroupFsPath}/memory.current`, 'utf8').trim();
    const memoryStat = fs.readFileSync(`${cgroupFsPath}/memory.stat`, 'utf8');
    const parseStatValue = (key: string): number => {
      const match = memoryStat.match(new RegExp(`^${key}\\s+(\\d+)`, 'm'));
      return match ? parseInt(match[1], 10) : 0;
    };
    logger.info({
      memoryMb: Math.round(parseInt(memoryCurrent, 10) / 1048576),
      anonMb: Math.round(parseStatValue('anon') / 1048576),
      fileCacheMb: Math.round(parseStatValue('file') / 1048576),
      shmemMb: Math.round(parseStatValue('shmem') / 1048576),
    }, 'Post-execution memory');
  } catch { /* cgroup files may not be accessible in all environments */ }

  let logMessage: string | null = null;
  let logStatus: string | null = null;
  let signal: string | null = null;

  try {
    if (fs.existsSync(logPath)) {
      const logContent = fs.readFileSync(logPath, 'utf8');

      if (exitCode === 255) {
        logger.error({ logContent }, 'nsjail exit 255');
      }

      for (const line of logContent.split('\n')) {
        if (TIME_LIMIT_RE.test(line)) {
          logMessage = 'Time limit exceeded';
          logStatus = 'TO';
        }
        if (OOM_RE.test(line)) {
          logMessage = 'Out of memory';
          logStatus = 'SG';
        }
        const sigMatch = line.match(SIGNAL_RE);
        if (sigMatch) {
          const sigNum = parseInt(sigMatch[1], 10);
          signal = SIGNALS[sigNum] ?? `SIG${sigNum}`;
        }
      }
    } else if (exitCode === 255) {
      logger.error({ logPath }, 'nsjail exit 255 - no log file found');
    }
  } catch { /* log file may not exist */ } finally {
    try { fs.unlinkSync(logPath); } catch { /* ignore */ }
    try { fs.unlinkSync(cfgPath); } catch { /* ignore */ }
  }

  let code: number | null = exitCode;
  if (code !== null && code > 128 && !signal) {
    signal = SIGNALS[code - 128] ?? null;
  }

  const finalMessage = killMessage ?? logMessage;
  const finalStatus = killStatus ?? logStatus;

  if (finalStatus && ['TO', 'OL', 'EL'].includes(finalStatus)) {
    signal = 'SIGKILL';
  }

  return {
    stdout,
    stderr,
    code,
    signal,
    output,
    memory: null,
    message: finalMessage,
    status: finalStatus,
    cpu_time: null,
    wall_time: wallTime,
  };
}

interface BuildArgsOptions {
  logPath: string;
  /* Path to the rendered per-job NsJail config (base sandbox.cfg + the
   * dynamic /mnt/data mount block from renderJobConfigOverlay). Optional
   * for tests that don't materialize a per-job file; defaults to the base
   * config, in which case /mnt/data won't be mounted. */
  cfgPath?: string;
  pkgdir: string;
  timeout: number;
  memoryLimit: number;
  envVars: Record<string, string>;
  command: string[];
  extraPkgdirs?: string[];
  identity: SandboxJobIdentity;
}

export function buildArgs(opts: BuildArgsOptions): string[] {
  const { logPath, cfgPath, pkgdir, timeout, memoryLimit, envVars, command, extraPkgdirs, identity } = opts;

  const timeoutSecs = Math.max(1, Math.ceil(timeout / 1000));

  const args: string[] = [
    '--config', cfgPath ?? config.nsjail_config,
    '--log', logPath,
    '--seccomp_string', SECCOMP_POLICY,
    '--user', `${SANDBOX_INSIDE_UID}:${identity.uid}:1`,
    '--group', `${SANDBOX_INSIDE_GID}:${identity.gid}:1`,
    '-s', '/usr/bin:/bin',
    '-s', '/usr/lib:/lib',
    '-s', '/usr/lib64:/lib64',
    '-R', `${pkgdir}:${pkgdir}`,
  ];

  if (config.use_cgroupv2) {
    args.push('--use_cgroupv2');
  }

  if (extraPkgdirs) {
    const packagesRoot = config.packages_directory;
    for (const dir of extraPkgdirs) {
      const relativeToPackages = path.relative(packagesRoot, dir);
      if (
        !path.isAbsolute(dir) ||
        relativeToPackages.startsWith('..') ||
        path.isAbsolute(relativeToPackages) ||
        dir.includes(':')
      ) {
        continue;
      }
      args.push('-R', `${dir}:${dir}`);
    }
  }

  args.push(
    '--time_limit', String(timeoutSecs),
    '--rlimit_as', String(config.rlimit_as),
    '--rlimit_fsize', String(config.rlimit_fsize),
    '--rlimit_nofile', String(config.max_open_files),
    '--rlimit_nproc', String(config.max_process_count),
    '--rlimit_core', '0',
    '--rlimit_cpu', String(timeoutSecs),
    '--rlimit_stack', 'soft',
    '--rlimit_memlock', '0',
  );

  if (config.use_cgroupv2 && memoryLimit > 0) {
    args.push('--cgroup_mem_max', String(memoryLimit));
  }

  if (config.allowed_local_network_port > 0) {
    const socketPath = '/tmp/tcs.sock';
    args.push('-B', `${socketPath}:${socketPath}`);
  }

  for (const [key, value] of Object.entries(envVars)) {
    args.push('-E', `${key}=${value}`);
  }

  /* TOOL_CALL_SOCKET is intentionally NOT exported: the path is fixed at
   * /tmp/tcs.sock and the runtime preamble references it as a literal.
   * Skipping the env entry shrinks the surface user code can introspect
   * (`os.environ`) and keeps the socket discoverable only by code that
   * already knows where to look. The /tmp/tcs.sock bind-mount above is
   * what actually makes the path connectable. */

  args.push('--');
  args.push('/usr/local/bin/spec-guard', ...command);

  return args;
}
