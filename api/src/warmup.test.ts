import { describe, expect, test } from 'bun:test';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { startWarmupCommand } from './warmup';

async function waitForFile(filePath: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

describe('startWarmupCommand', () => {
  test('runs the command detached in the background', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'warmup-'));
    const marker = path.join(tmp, 'warmed');
    try {
      startWarmupCommand(`touch '${marker}'`);
      expect(await waitForFile(marker)).toBe(true);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  test('is a no-op when the command is unset or blank', () => {
    startWarmupCommand(undefined);
    startWarmupCommand('');
    startWarmupCommand('   ');
  });

  test('a failing command never throws', async () => {
    startWarmupCommand('/nonexistent-warmup-binary --flag');
    startWarmupCommand('exit 7');
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
});
