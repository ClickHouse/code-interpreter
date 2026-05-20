import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, test } from 'bun:test';
import { extractPendingFromStdout, type LCTool } from './preamble';
import { generateBashReplayPostamble, generateBashReplayPreamble } from './preamble-bash';

interface BashRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal?: string;
}

interface BashRunOptions {
  history?: Record<string, unknown>;
  timeoutMs?: number;
}

const executionId = 'exec_bash_unit';
const tools: LCTool[] = [
  {
    name: 'get_weather',
    description: 'Get weather for a city.',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  },
  {
    name: 'calculate',
    description: 'Evaluate an expression.',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string' } },
      required: ['expression'],
    },
  },
];

function assemble(userCode: string): string {
  return [
    generateBashReplayPreamble({ executionId, tools }),
    userCode,
    generateBashReplayPostamble(),
  ].join('\n');
}

function runBash(script: string, options: number | BashRunOptions = {}): BashRunResult {
  const timeoutMs = typeof options === 'number' ? options : options.timeoutMs ?? 3000;
  const history = typeof options === 'number' ? {} : options.history ?? {};
  const dir = mkdtempSync(join(tmpdir(), 'ptc-bash-unit-'));
  const file = join(dir, 'main.sh');
  const historyPath = join(dir, 'history.json');
  writeFileSync(file, script, { mode: 0o755 });
  writeFileSync(historyPath, JSON.stringify(history));
  try {
    const stdout = execFileSync('bash', [file], {
      env: { ...process.env, PTC_HISTORY_PATH: historyPath },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      status?: number;
      signal?: string;
    };
    return {
      stdout: e.stdout ? String(e.stdout) : '',
      stderr: e.stderr ? String(e.stderr) : '',
      exitCode: e.status ?? 1,
      signal: e.signal,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function pendingNames(stdout: string): string[] {
  const parsed = extractPendingFromStdout(stdout, executionId);
  return (parsed.pending ?? []).map(call => call.tool_name).sort();
}

describe('generateBashReplayPreamble - command substitution pending emission', () => {
  test('emits a command-substitution tool call before later user code while another job is running', () => {
    const run = runBash(assemble(`
sleep 0.2 &
result=$(get_weather '{"city":"Madrid"}')
echo "AFTER: $result"
wait
`));

    const parsed = extractPendingFromStdout(run.stdout, executionId);
    expect(run.signal).not.toBe('SIGTERM');
    expect(run.exitCode).toBe(0);
    expect(parsed.pending).toHaveLength(1);
    expect(parsed.pending?.[0]?.tool_name).toBe('get_weather');
    expect(parsed.pending?.[0]?.input).toEqual({ city: 'Madrid' });
    expect(parsed.stdout).not.toContain('AFTER');
  });

  test('batches background and command-substitution tool calls before command-substitution side effects', () => {
    const run = runBash(assemble(`
get_weather '{"city":"Oslo"}' &
result=$(calculate '{"expression":"2+3"}')
echo "SIDE_EFFECT: $result"
wait
`), 1500);

    const parsed = extractPendingFromStdout(run.stdout, executionId);
    expect(run.signal).not.toBe('SIGTERM');
    expect(run.exitCode).toBe(0);
    expect(pendingNames(run.stdout)).toEqual(['calculate', 'get_weather']);
    expect(parsed.pending).toHaveLength(2);
    expect(parsed.stdout).not.toContain('SIDE_EFFECT');
  });

  test('waits for background compound commands that invoke tools later', () => {
    const run = runBash(assemble(`
(sleep 0.2; get_weather '{"city":"Paris"}') &
echo "AFTER LAUNCH"
`), 1500);

    const parsed = extractPendingFromStdout(run.stdout, executionId);
    expect(run.signal).not.toBe('SIGTERM');
    expect(run.exitCode).toBe(0);
    expect(parsed.pending).toHaveLength(1);
    expect(parsed.pending?.[0]?.tool_name).toBe('get_weather');
    expect(parsed.pending?.[0]?.input).toEqual({ city: 'Paris' });
    expect(parsed.stdout).toContain('AFTER LAUNCH');
  });

  test('does not wait for unrelated background commands with tool names as arguments', () => {
    const run = runBash(assemble(`
bash -c 'sleep 2' get_weather &
echo "DONE"
`), 700);

    const parsed = extractPendingFromStdout(run.stdout, executionId);
    expect(run.signal).not.toBe('SIGTERM');
    expect(run.exitCode).toBe(0);
    expect(parsed.pending).toBeNull();
    expect(parsed.stdout).toContain('DONE');
  });

  test('does not treat arithmetic expansion as command substitution while batching background tools', () => {
    const run = runBash(assemble(`
get_weather '{"city":"Oslo"}' &
sleep 0.1
x=$((1+1))
calculate '{"expression":"2+3"}' &
wait
echo "DONE $x"
`), 1500);

    const parsed = extractPendingFromStdout(run.stdout, executionId);
    expect(run.signal).not.toBe('SIGTERM');
    expect(run.exitCode).toBe(0);
    expect(pendingNames(run.stdout)).toEqual(['calculate', 'get_weather']);
    expect(parsed.pending).toHaveLength(2);
    expect(parsed.stdout).not.toContain('DONE');
  });

  test('handles backtick command substitution without waiting for unrelated background jobs', () => {
    const run = runBash(assemble(`
sleep 5 &
result=\`get_weather '{"city":"Porto"}'\`
echo "AFTER: $result"
wait
`), 1500);

    const parsed = extractPendingFromStdout(run.stdout, executionId);
    expect(run.signal).not.toBe('SIGTERM');
    expect(run.exitCode).toBe(0);
    expect(parsed.pending).toHaveLength(1);
    expect(parsed.pending?.[0]?.tool_name).toBe('get_weather');
    expect(parsed.pending?.[0]?.input).toEqual({ city: 'Porto' });
    expect(parsed.stdout).not.toContain('AFTER');
  });

  test('replays parallel calls with identical signatures after call-site line numbers shift', () => {
    const userCode = `
for _ptc_i in 1 2; do
  get_weather '{"city":"Paris"}' &
done
wait
echo "DONE"
`;
    const firstRun = runBash(assemble(userCode));
    const firstParsed = extractPendingFromStdout(firstRun.stdout, executionId);
    expect(firstRun.exitCode).toBe(0);
    expect(firstParsed.pending).toHaveLength(2);

    const history = Object.fromEntries(
      firstParsed.pending!.map((call, index) => {
        expect(call.input_hash).toBeTruthy();
        expect(call.call_site).toBeTruthy();
        return [
          call.call_id,
          {
            result: { slot: index === 0 ? 'first' : 'second' },
            tool_name: call.tool_name,
            input_hash: call.input_hash,
            call_site: `${call.call_site}:old-preamble-offset`,
            received_at: index + 1,
          },
        ];
      }),
    );
    const replayRun = runBash(assemble(userCode), { history });
    const replayParsed = extractPendingFromStdout(replayRun.stdout, executionId);
    expect(replayRun.exitCode).toBe(0);
    expect(replayParsed.pending).toBeNull();
    expect(replayParsed.stdout).toContain('"slot":"first"');
    expect(replayParsed.stdout).toContain('"slot":"second"');
    expect(replayParsed.stdout).toContain('DONE');
  });

  test('replays identical signature matches in numeric call-id order', () => {
    const history = {
      call_1000: {
        result: { slot: 'thousand' },
        tool_name: 'get_weather',
        input: { city: 'Paris' },
        received_at: 1000,
      },
      call_999: {
        result: { slot: 'nine-nine-nine' },
        tool_name: 'get_weather',
        input: { city: 'Paris' },
        received_at: 999,
      },
    };

    const run = runBash(assemble(`
get_weather '{"city":"Paris"}'
printf '\\n'
get_weather '{"city":"Paris"}'
printf '\\nDONE\\n'
`), { history });
    const parsed = extractPendingFromStdout(run.stdout, executionId);

    expect(run.exitCode).toBe(0);
    expect(parsed.pending).toBeNull();
    expect(parsed.stdout.indexOf('"slot":"nine-nine-nine"')).toBeLessThan(
      parsed.stdout.indexOf('"slot":"thousand"'),
    );
    expect(parsed.stdout).toContain('DONE');
  });

  test('replays matching nonnumeric history keys without crashing counter parsing', () => {
    const history = {
      legacy_match: {
        result: { slot: 'legacy' },
        tool_name: 'get_weather',
        input: { city: 'Paris' },
        received_at: 1,
      },
    };

    const run = runBash(assemble(`
get_weather '{"city":"Paris"}'
printf '\\n'
calculate '{"expression":"2+3"}'
printf '\\nDONE\\n'
`), { history });
    const parsed = extractPendingFromStdout(run.stdout, executionId);

    expect(run.signal).not.toBe('SIGTERM');
    expect(run.exitCode).toBe(0);
    expect(parsed.stdout).toContain('"slot":"legacy"');
    expect(parsed.stdout).not.toContain('DONE');
    expect(parsed.pending).toHaveLength(1);
    expect(parsed.pending?.[0]?.call_id).toBe('call_001');
    expect(parsed.pending?.[0]?.tool_name).toBe('calculate');
  });

  test('skips stale numeric fallback entries after a nonnumeric signature match', () => {
    const history = {
      legacy_match: {
        result: { slot: 'legacy' },
        tool_name: 'get_weather',
        input: { city: 'Paris' },
        received_at: 1,
      },
      call_001: {
        result: { slot: 'stale' },
        tool_name: 'calculate',
        input: { expression: '9+9' },
        received_at: 2,
      },
    };

    const run = runBash(assemble(`
get_weather '{"city":"Paris"}'
printf '\\n'
calculate '{"expression":"2+3"}'
printf '\\nDONE\\n'
`), { history });
    const parsed = extractPendingFromStdout(run.stdout, executionId);

    expect(run.exitCode).toBe(0);
    expect(parsed.stdout).toContain('"slot":"legacy"');
    expect(parsed.stdout).not.toContain('"slot":"stale"');
    expect(parsed.stdout).not.toContain('DONE');
    expect(parsed.pending).toHaveLength(1);
    expect(parsed.pending?.[0]?.call_id).toBe('call_002');
    expect(parsed.pending?.[0]?.tool_name).toBe('calculate');
  });

  test('skips stale numeric fallback entries after a high numeric signature match', () => {
    const history = {
      call_010: {
        result: { slot: 'matched' },
        tool_name: 'get_weather',
        input: { city: 'Paris' },
        received_at: 10,
      },
      call_011: {
        result: { slot: 'stale' },
        tool_name: 'calculate',
        input: { expression: '9+9' },
        received_at: 11,
      },
    };

    const run = runBash(assemble(`
get_weather '{"city":"Paris"}'
printf '\\n'
calculate '{"expression":"2+3"}'
printf '\\nDONE\\n'
`), { history });
    const parsed = extractPendingFromStdout(run.stdout, executionId);

    expect(run.exitCode).toBe(0);
    expect(parsed.stdout).toContain('"slot":"matched"');
    expect(parsed.stdout).not.toContain('"slot":"stale"');
    expect(parsed.stdout).not.toContain('DONE');
    expect(parsed.pending).toHaveLength(1);
    expect(parsed.pending?.[0]?.call_id).toBe('call_012');
    expect(parsed.pending?.[0]?.tool_name).toBe('calculate');
  });
});
