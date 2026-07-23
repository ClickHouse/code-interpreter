import { describe, expect, test } from 'bun:test';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { startWarmupCommand } from './warmup';

describe('startWarmupCommand', () => {
  test('waits for the command before reporting warmup complete', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'warmup-'));
    const marker = path.join(tmp, 'warmed');
    try {
      expect(await startWarmupCommand(`touch '${marker}'`, 5_000)).toBe('completed');
      expect(await fsp.readFile(marker, 'utf8')).toBe('');
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  test('is a no-op when the command is unset or blank', async () => {
    expect(await startWarmupCommand(undefined)).toBe('skipped');
    expect(await startWarmupCommand('')).toBe('skipped');
    expect(await startWarmupCommand('   ')).toBe('skipped');
  });

  test('a failing command is surfaced without throwing', async () => {
    expect(await startWarmupCommand('/nonexistent-warmup-binary --flag')).toBe('failed');
    expect(await startWarmupCommand('exit 7')).toBe('failed');
  });

  test('terminates a warmup that exceeds its startup budget', async () => {
    const started = Date.now();
    expect(await startWarmupCommand('sleep 10', 30)).toBe('timed_out');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
