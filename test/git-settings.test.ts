import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findGitBranch } from '../src/main/git';
import { DEFAULT_SETTINGS, normalizeSettings, SettingsStore } from '../src/main/settings';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'autobot-test-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('findGitBranch', () => {
  it('reads the branch from .git/HEAD in a parent folder', () => {
    const root = tempDir();
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/feature/login\n');
    mkdirSync(join(root, 'src', 'deep'), { recursive: true });
    expect(findGitBranch(join(root, 'src', 'deep'))).toBe('feature/login');
  });

  it('shows a short hash for a detached HEAD', () => {
    const root = tempDir();
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n');
    expect(findGitBranch(root)).toBe('0123456');
  });

  it('follows a gitdir file (worktrees, submodules)', () => {
    const root = tempDir();
    const real = join(root, 'real-git');
    mkdirSync(real);
    writeFileSync(join(real, 'HEAD'), 'ref: refs/heads/wt\n');
    const wt = join(root, 'wt');
    mkdirSync(wt);
    writeFileSync(join(wt, '.git'), 'gitdir: ../real-git\n');
    expect(findGitBranch(wt)).toBe('wt');
  });

  it('returns null outside a repository', () => {
    expect(findGitBranch(tempDir())).toBeNull();
  });
});

describe('settings', () => {
  it('fills defaults and drops invalid values', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ fontSize: 200, theme: 'purple', scrollback: 500.7, defaultProfile: 'pwsh' })).toEqual({
      ...DEFAULT_SETTINGS,
      scrollback: 500,
      defaultProfile: 'pwsh',
    });
  });

  it('creates the settings file with defaults on first run', () => {
    const dir = join(tempDir(), 'nested', 'autobot-terminal');
    const store = new SettingsStore(dir);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(new SettingsStore(dir).get()).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps defaults when the file is not valid JSON', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'settings.json'), '{ broken');
    expect(new SettingsStore(dir).get()).toEqual(DEFAULT_SETTINGS);
  });

  it('validates the AI settings', () => {
    const s = normalizeSettings({
      llmProvider: 'openai',
      llmModel: 'claude-sonnet-5',
      ollamaUrl: 'file:///etc/passwd',
      ollamaModel: 'qwen2.5:7b',
      llmDailyLimit: -3,
      llmPanel: true,
    });
    expect(s.llmProvider).toBe('anthropic');
    expect(s.llmModel).toBe('claude-sonnet-5');
    expect(s.ollamaUrl).toBe(DEFAULT_SETTINGS.ollamaUrl);
    expect(s.ollamaModel).toBe('qwen2.5:7b');
    expect(s.llmDailyLimit).toBe(DEFAULT_SETTINGS.llmDailyLimit);
    expect(s.llmPanel).toBe(true);
  });

  it('updates single fields and keeps the rest of the file', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ fontSize: 16, myOwnNote: 'keep me' }));
    const store = new SettingsStore(dir);
    const seen: number[] = [];
    store.watch((s) => seen.push(s.llmDailyLimit));
    const next = store.update({ llmProvider: 'off', llmDailyLimit: 5 });
    store.dispose();
    expect(next).toMatchObject({ fontSize: 16, llmProvider: 'off', llmDailyLimit: 5 });
    expect(seen).toEqual([5]);
    const raw = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    expect(raw).toEqual({ fontSize: 16, myOwnNote: 'keep me', llmProvider: 'off', llmDailyLimit: 5 });
  });
});
