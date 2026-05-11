import * as fs from 'fs';
import * as path from 'path';
import { nanoid } from 'nanoid';
import { config } from './config';
import { logger } from './logger';

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

const syscallDefines = process.arch === 'arm64'
  ? [
      '#define io_uring_setup 425',
      '#define io_uring_enter 426',
      '#define io_uring_register 427',
      '#define clone3 435',
      '#define umount2 39',
      '#define seccomp 277',
    ]
  : [
      '#define io_uring_setup 425',
      '#define io_uring_enter 426',
      '#define io_uring_register 427',
      '#define clone3 435',
      '#define umount2 166',
      '#define seccomp 317',
      '#define kexec_file_load 320',
    ];

const kexecSyscalls = process.arch === 'arm64'
  ? '    kexec_load, bpf, perf_event_open,'
  : '    kexec_load, kexec_file_load, bpf, perf_event_open,';

const SECCOMP_POLICY = [
  ...syscallDefines,
  '#define AF_INET 2',
  '#define AF_INET6 10',
  '#define AF_NETLINK 16',
  '#define AF_KEY 15',
  '#define AF_RXRPC 33',
  '#define AF_ALG 38',
  '#define CLONE_NAMESPACE_FLAGS 0x7e020000',
  '#define KVM_IOCTL_MAGIC 0xAE00',
  'POLICY sandbox {',
  '  KILL {',
  '    ptrace, memfd_create, personality, userfaultfd,',
  kexecSyscalls,
  '    add_key, request_key, keyctl,',
  '    mount, umount2, pivot_root,',
  '    swapon, swapoff, reboot,',
  '    init_module, finit_module, delete_module,',
  '    unshare, seccomp,',
  '    process_vm_readv, process_vm_writev,',
  '    acct, quotactl,',
  '    ioctl(fd, request) { (request & 0xFF00) == KVM_IOCTL_MAGIC }',
  '  },',
  '  ERRNO(38) {',
  '    clone3',
  '  },',
  '  ERRNO(1) {',
  '    io_uring_setup, io_uring_enter, io_uring_register, sched_setaffinity, vmsplice,',
  '    clone(flags) { (flags & CLONE_NAMESPACE_FLAGS) != 0 },',
  '    socket(domain) { domain == AF_INET || domain == AF_INET6 || domain == AF_NETLINK || domain == AF_KEY || domain == AF_RXRPC || domain == AF_ALG }',
  '  }',
  '}',
  'USE sandbox DEFAULT ALLOW',
].join('\n');

export { SIGNALS };

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
}

export async function execute(opts: ExecuteOptions): Promise<NsJailResult> {
  const { command, envVars, submissionDir, pkgdir, timeout, memoryLimit, outputMaxSize, stdin, extraPkgdirs } = opts;
  const logId = nanoid();
  const logPath = `/tmp/nsjail-${logId}.log`;

  const nsjailArgs = buildArgs({
    logPath,
    submissionDir,
    pkgdir,
    timeout,
    memoryLimit,
    envVars,
    command,
    extraPkgdirs,
  });

  const startTime = Date.now();
  const hasStdin = stdin !== undefined && stdin.length > 0;

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([config.nsjail_path, ...nsjailArgs], {
      stdin: hasStdin ? 'pipe' : 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (err) {
    try { fs.unlinkSync(logPath); } catch { /* ignore */ }
    throw new Error(`Failed to spawn nsjail: ${(err as Error).message}`);
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
  submissionDir: string;
  pkgdir: string;
  timeout: number;
  memoryLimit: number;
  envVars: Record<string, string>;
  command: string[];
  extraPkgdirs?: string[];
}

function buildArgs(opts: BuildArgsOptions): string[] {
  const { logPath, submissionDir, pkgdir, timeout, memoryLimit, envVars, command, extraPkgdirs } = opts;

  const timeoutSecs = Math.max(1, Math.ceil(timeout / 1000));

  const args: string[] = [
    '--config', config.nsjail_config,
    '--log', logPath,
    '--seccomp_string', SECCOMP_POLICY,
    '-s', '/usr/bin:/bin',
    '-s', '/usr/lib:/lib',
    '-s', '/usr/lib64:/lib64',
    '-B', `${submissionDir}:/mnt/data`,
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

  if (config.allowed_local_network_port > 0) {
    args.push('-E', 'TOOL_CALL_SOCKET=/tmp/tcs.sock');
  }

  args.push('--');
  args.push('/usr/local/bin/spec-guard', ...command);

  return args;
}
