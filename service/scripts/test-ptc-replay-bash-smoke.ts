/* eslint-disable no-console */
/**
 * Smoke test for the bash replay preamble. Compiles the preamble + user code,
 * writes it to a temp file, runs with bash directly, and verifies:
 *   (a) first run (empty history) emits the PTC sentinel block with pending
 *   (b) re-run with populated history completes and prints captured result
 *   (c) cached error entries cause non-zero exit with stderr message
 *   (d) zero tool calls completes cleanly without a sentinel
 *
 * No nsjail/docker required. Run: `npx ts-node scripts/test-ptc-replay-bash-smoke.ts`
 */
import { execFileSync } from 'child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  extractPendingFromStdout,
  type LCTool,
} from '../src/preamble';
import { generateBashReplayPreamble, generateBashReplayPostamble } from '../src/preamble-bash';

let passed = 0;
let failed = 0;
const assert = (cond: unknown, msg: string) => {
  if (cond) { passed++; console.log(`  ok  ${msg}`); }
  else { failed++; console.log(`  FAIL ${msg}`); }
};

interface RunResult { stdout: string; stderr: string; exitCode: number }

function runBash(script: string, history: Record<string, unknown>): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'ptc-bash-smoke-'));
  const file = join(dir, 'main.sh');
  const historyPath = join(dir, 'history.json');
  writeFileSync(file, script, { mode: 0o755 });
  writeFileSync(historyPath, JSON.stringify(history));
  try {
    const out = execFileSync('bash', [file], {
      env: { ...process.env, PTC_HISTORY_PATH: historyPath },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    return { stdout: out, stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    return {
      stdout: e.stdout ? String(e.stdout) : '',
      stderr: e.stderr ? String(e.stderr) : '',
      exitCode: e.status ?? 1,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const tools: LCTool[] = [
  {
    name: 'get_weather',
    description: 'Get weather for a city.',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
  {
    name: 'calculate',
    description: 'Evaluate an expression.',
    parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] },
  },
];

const BASH_SMOKE_EXEC_ID = 'exec_bash_test';
const preamble = generateBashReplayPreamble({ executionId: BASH_SMOKE_EXEC_ID, tools });
const postamble = generateBashReplayPostamble();
/** Mirror the real `buildBashPayload` assembly (preamble + user code + postamble)
 * so smoke tests exercise the same subshell-wrapped layout as production. */
const assemble = (user: string): string => preamble + user + '\n' + postamble;
const extractPending = (s: string) => extractPendingFromStdout(s, BASH_SMOKE_EXEC_ID);

console.log('bash replay preamble:');

{
  const user = `
result=$(get_weather '{"city":"Paris"}')
echo "Result: $result"
`;
  const r = runBash(assemble(user), {});
  const p = extractPending(r.stdout);
  assert(r.exitCode === 0, 'single: exit 0');
  assert(p.pending !== null && p.pending.length === 1, 'single: one pending call');
  assert(
    Boolean(p.pending?.[0]?.tool_name === 'get_weather'),
    'single: tool_name is get_weather',
  );
  assert(
    Boolean((p.pending?.[0]?.input as { city?: string } | undefined)?.city === 'Paris'),
    'single: input.city is Paris',
  );
  assert(p.pending?.[0]?.call_id === 'call_001', 'single: call_id is call_001');
}

{
  const user = `
result=$(get_weather '{"city":"Paris"}')
echo "Got: $result"
count=$(calculate '{"expression":"1+1"}')
echo "Count: $count"
`;

  const r1 = runBash(assemble(user), {});
  const p1 = extractPending(r1.stdout);
  assert(Boolean(p1.pending?.[0]?.call_id === 'call_001'), 'seq: first pending is call_001');

  const history1 = { call_001: { result: { temperature: 68, city: 'Paris' } } };
  const r2 = runBash(assemble(user), history1);
  const p2 = extractPending(r2.stdout);
  assert(Boolean(p2.pending?.[0]?.call_id === 'call_002'), 'seq: second pending is call_002');
  assert(
    Boolean(p2.pending?.[0]?.tool_name === 'calculate'),
    'seq: second pending is calculate',
  );
  assert(
    p2.stdout.includes('Got: {"temperature":68,"city":"Paris"}'),
    'seq: cached result appears in stdout',
  );

  const history2 = {
    ...history1,
    call_002: { result: 2 },
  };
  const r3 = runBash(assemble(user), history2);
  const p3 = extractPending(r3.stdout);
  assert(p3.pending === null, 'seq: third run has no pending');
  assert(p3.stdout.includes('Count: 2'), 'seq: second cached result appears');
}

{
  const user = `
result=$(get_weather '{"city":"Nowhere"}')
echo "UNREACHABLE: $result"
`;
  const history = { call_001: { is_error: true, error_message: 'city not found' } };
  const r = runBash(assemble(user), history);
  assert(r.exitCode === 1, 'error: exit 1');
  assert(r.stderr.includes('city not found'), 'error: stderr contains message');
  assert(!r.stdout.includes('UNREACHABLE'), 'error: aborted before next line');
}

{
  const user = `
echo "hello world"
`;
  const r = runBash(assemble(user), {});
  const p = extractPending(r.stdout);
  assert(r.exitCode === 0, 'no_calls: exit 0');
  assert(p.pending === null, 'no_calls: no pending');
  assert(p.stdout.includes('hello world'), 'no_calls: user output preserved');
}

{
  const user = `
get_weather '{"city":"Tokyo"}'
echo "AFTER"
`;
  const r = runBash(assemble(user), {});
  const p = extractPending(r.stdout);
  assert(p.pending !== null && p.pending.length === 1, 'bare: pending emitted');
  assert(
    Boolean((p.pending?.[0]?.input as { city?: string } | undefined)?.city === 'Tokyo'),
    'bare: correct input',
  );
  assert(!r.stdout.includes('AFTER'), 'bare: aborts after first tool call');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
