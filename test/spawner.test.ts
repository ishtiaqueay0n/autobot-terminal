import { describe, expect, it } from 'vitest';
import { spawnCollect } from '../src/main/kb/spawner';

const node = process.execPath;
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
const job = (args: string[], extra: { input?: string; timeoutMs?: number; maxBytes?: number } = {}) =>
  spawnCollect({ command: node, args, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, timeoutMs: 10_000, maxBytes: 1_000_000, ...extra });

describe('spawnCollect', () => {
  it('collects stdout, stderr and the exit code', async () => {
    const r = await job(['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)']);
    expect(r).toEqual({ stdout: 'out', stderr: 'err', code: 3, timedOut: false });
  });

  it('feeds input on stdin', async () => {
    const r = await job(['-e', 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => process.stdout.write(s.toUpperCase()))'], {
      input: 'hello',
    });
    expect(r.stdout).toBe('HELLO');
  });

  it('kills programs that run too long', async () => {
    const r = await job(['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
  });

  it('runs jobs in parallel and resolves each with its own result', async () => {
    const results = await Promise.all([1, 2, 3].map((n) => job(['-e', `process.stdout.write("${n}")`])));
    expect(results.map((r) => r.stdout)).toEqual(['1', '2', '3']);
  });

  it('reports a missing program without throwing', async () => {
    const r = await spawnCollect({ command: 'autobot-no-such-program', args: [], env, timeoutMs: 5000, maxBytes: 1000 });
    expect(r.code).toBeNull();
  });
});
