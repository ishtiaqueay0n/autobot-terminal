import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bashSource, importSource, parseBashHistory, parsePsReadLineHistory, psReadLineSource } from '../src/main/history/importers';
import { HistoryStore, scoreCandidate, type FinishedCommand } from '../src/main/history/store';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 3, 12);

let dir: string;
let store: HistoryStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'autobot-history-'));
  store = new HistoryStore(join(dir, 'history.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

let clock = NOW - 30 * DAY;
function run(command: string, extra: Partial<FinishedCommand> = {}): number | null {
  clock += 1000;
  return store.record({
    shell: 'bash',
    command,
    cwd: '/home/me',
    exitCode: 0,
    startedAt: clock,
    durationMs: 5,
    previousId: null,
    ...extra,
  });
}
const suggest = (prefix: string, extra: Partial<Parameters<HistoryStore['suggest']>[0]> = {}) =>
  store.suggest({ shell: 'bash', prefix, cwd: '/home/me', previousId: null, now: NOW, ...extra });

describe('HistoryStore.record', () => {
  it('skips empty commands and commands starting with a space', () => {
    expect(run('')).toBeNull();
    expect(run('   ')).toBeNull();
    expect(run(' secret-thing')).toBeNull();
    expect(store.recent('bash')).toEqual([]);
  });

  it('aggregates repeated commands and returns a stable id', () => {
    const a = run('git status');
    const b = run('git status');
    expect(a).toBe(b);
    expect(store.recent('bash')).toEqual(['git status']);
  });

  it('stores redacted text and never suggests it', () => {
    run('export API_TOKEN=abc123');
    expect(store.recent('bash')).toEqual([]);
    expect(suggest('export')).toBeNull();
  });
});

describe('HistoryStore.suggest', () => {
  it('completes a prefix, never the exact text', () => {
    run('git status');
    expect(suggest('git s')).toBe('git status');
    expect(suggest('git status')).toBeNull();
    expect(suggest('docker')).toBeNull();
  });

  it('excludes commands whose last run failed', () => {
    run('make deploy', { exitCode: 2 });
    expect(suggest('make')).toBeNull();
    run('make deploy', { exitCode: 0 });
    expect(suggest('make')).toBe('make deploy');
  });

  it('prefers commands run in the same folder', () => {
    for (let i = 0; i < 5; i++) run('npm run build', { cwd: '/srv/api' });
    run('npm run test', { cwd: '/srv/web' });
    expect(suggest('npm run', { cwd: '/srv/web' })).toBe('npm run test');
    expect(suggest('npm run', { cwd: '/srv/api' })).toBe('npm run build');
  });

  it('prefers frequent and recent commands elsewhere', () => {
    for (let i = 0; i < 6; i++) run('kubectl get pods', { cwd: '/a' });
    run('kubectl get nodes', { cwd: '/b' });
    expect(suggest('kubectl get', { cwd: '/c' })).toBe('kubectl get pods');
  });

  it('matches PowerShell case-insensitively and returns the stored spelling', () => {
    store.record({ shell: 'powershell', command: 'Get-ChildItem -Force', cwd: 'C:\\', exitCode: 0, startedAt: NOW, durationMs: 1, previousId: null });
    expect(store.suggest({ shell: 'powershell', prefix: 'get-ch', cwd: null, previousId: null })).toBe('Get-ChildItem -Force');
    expect(suggest('Get')).toBeNull(); // bash history is separate
  });

  it('does not offer multi-line commands as ghost text', () => {
    run('for i in 1 2; do\n  echo $i\ndone');
    expect(suggest('for')).toBeNull();
    expect(store.recent('bash')).toEqual(['for i in 1 2; do\n  echo $i\ndone']);
  });

  it('suggests the usual next command on an empty line after two observations', () => {
    const add = run('git add -A')!;
    run('git commit -m wip', { previousId: add });
    expect(suggest('', { previousId: add })).toBeNull();
    run('git commit -m wip', { previousId: add });
    expect(suggest('', { previousId: add })).toBe('git commit -m wip');
    expect(suggest('', { previousId: null })).toBeNull();
  });
});

describe('scoreCandidate', () => {
  it('ranks any same-folder use above popularity elsewhere, then frequency and recency', () => {
    const sameFolder = scoreCandidate({ run_count: 1, last_used: NOW - 30 * DAY }, 1, NOW);
    const popular = scoreCandidate({ run_count: 500, last_used: NOW }, 0, NOW);
    expect(sameFolder).toBeGreaterThan(popular);
    expect(scoreCandidate({ run_count: 20, last_used: NOW }, 0, NOW)).toBeGreaterThan(
      scoreCandidate({ run_count: 2, last_used: NOW }, 0, NOW),
    );
    expect(scoreCandidate({ run_count: 1, last_used: NOW }, 0, NOW)).toBeGreaterThan(
      scoreCandidate({ run_count: 1, last_used: NOW - 60 * DAY }, 0, NOW),
    );
  });
});

describe('importers', () => {
  it('parses PSReadLine multi-line entries', () => {
    expect(parsePsReadLineHistory('Get-Date\r\nif ($x) {`\r\n  "y"`\r\n}\r\n\r\ncd ..\r\n')).toEqual([
      'Get-Date',
      'if ($x) {\n  "y"\n}',
      'cd ..',
    ]);
  });

  it('parses bash history and skips timestamp lines', () => {
    expect(parseBashHistory('#1700000000\nls -la\n\n#1700000001\ngit log\n')).toEqual(['ls -la', 'git log']);
  });

  it('imports a file once, keeps file order as recency, and learns sequences', async () => {
    const file = join(dir, 'bash_history');
    writeFileSync(file, 'cd app\nnpm test\ncd app\nnpm test\nexport GH_TOKEN=x\nls\n');
    utimesSync(file, NOW / 1000, NOW / 1000);
    const source = bashSource(file);
    expect(await importSource(store, source)).toBe(6);
    expect(await importSource(store, source)).toBe(0);
    expect(store.recent('bash')).toEqual(['ls', 'npm test', 'cd app']);
    expect(store.suggest({ shell: 'bash', prefix: 'cd', cwd: null, previousId: null })).toBe('cd app');
    // "cd app" was followed by "npm test" twice in the file.
    const cdApp = run('cd app');
    expect(suggest('', { previousId: cdApp })).toBe('npm test');
  });

  it('ignores missing files', async () => {
    expect(await importSource(store, bashSource(join(dir, 'nope')))).toBe(0);
    expect(psReadLineSource('')).toBeNull();
  });
});
