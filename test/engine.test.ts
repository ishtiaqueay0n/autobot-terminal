import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CompletionEngine, type CompletionSession } from '../src/main/complete/engine';
import { Helpers } from '../src/main/complete/helpers';
import { baseShell } from '../src/shared/shell';
import { HistoryStore } from '../src/main/history/store';
import { BundledKb } from '../src/main/kb/bundled';
import { Knowledge } from '../src/main/kb/knowledge';
import { KnowledgeStore } from '../src/main/kb/store';
import type { EnvRef } from '../src/main/kb/exec';
import type { KbSpec } from '../src/shared/kb-types';
import type { CompletionReason, ShellKind } from '../src/shared/types';

const root = mkdtempSync(join(tmpdir(), 'autobot-engine-'));
const kbDir = join(root, 'kb');
const work = join(root, 'work');
const SEP = process.platform === 'win32' ? '\\' : '/';
const env: EnvRef = { id: process.platform === 'win32' ? 'windows' : 'linux', kind: process.platform === 'win32' ? 'windows' : 'linux' };

const git: KbSpec = {
  names: ['git'],
  description: 'Distributed version control',
  subcommands: [
    { names: ['checkout'], description: 'Switch branches', args: [{ name: 'branch', helpers: ['git.branches'], templates: ['filepaths'] }] },
    { names: ['cherry-pick'], description: 'Apply commits' },
    { names: ['commit'], options: [{ names: ['-m', '--message'], args: [{ name: 'msg' }] }, { names: ['--amend'], description: 'Amend' }] },
    { names: ['push'], options: [{ names: ['--force'], dangerous: true }] },
  ],
  options: [{ names: ['-C'], args: [{ name: 'path', templates: ['folders'] }] }],
};
const kubectl: KbSpec = {
  names: ['kubectl'],
  options: [{ names: ['-n', '--namespace'], persistent: true, args: [{ name: 'ns' }] }],
  subcommands: [
    {
      names: ['get'],
      options: [{ names: ['-o', '--output'], separator: undefined, args: [{ name: 'format', suggestions: [{ name: 'json' }, { name: 'yaml' }, { name: 'wide' }] }] }],
      args: [{ name: 'type', suggestions: [{ name: 'pods' }, { name: 'services' }] }],
    },
  ],
};

let store: KnowledgeStore;
let history: HistoryStore;
let engine: CompletionEngine;

beforeAll(() => {
  mkdirSync(join(kbDir, 'fig'), { recursive: true });
  writeFileSync(join(kbDir, 'fig', 'git.json.gz'), gzipSync(JSON.stringify(git)));
  writeFileSync(join(kbDir, 'fig', 'kubectl.json.gz'), gzipSync(JSON.stringify(kubectl)));
  writeFileSync(
    join(kbDir, 'index.json'),
    JSON.stringify({
      version: 1,
      generatedAt: '',
      fig: { git: { file: 'fig/git.json.gz', description: git.description }, kubectl: { file: 'fig/kubectl.json.gz' } },
    }),
  );
  writeFileSync(
    join(kbDir, 'tldr.json.gz'),
    gzipSync(JSON.stringify({ git: { common: { description: 'VCS', examples: [{ text: 'Show status', command: 'git status' }] } } })),
  );

  // A working folder with a git repo (two branches) and some files.
  mkdirSync(join(work, '.git', 'refs', 'heads', 'feature'), { recursive: true });
  writeFileSync(join(work, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(work, '.git', 'refs', 'heads', 'main'), '0'.repeat(40));
  writeFileSync(join(work, '.git', 'refs', 'heads', 'feature', 'login'), '0'.repeat(40));
  mkdirSync(join(work, 'src'));
  writeFileSync(join(work, 'README.md'), '');
  writeFileSync(join(work, 'my notes.txt'), '');

  store = new KnowledgeStore(join(root, 'knowledge.db'));
  history = new HistoryStore(join(root, 'history.db'));
  const knowledge = new Knowledge(new BundledKb(kbDir), store);
  engine = new CompletionEngine({ knowledge, helpers: new Helpers(() => false), history: () => history });
});

afterAll(() => {
  store.close();
  history.close();
  rmSync(root, { recursive: true, force: true });
});

function session(shell: ShellKind = 'bash', over: Partial<CompletionSession> = {}): CompletionSession {
  return {
    shell,
    env,
    cwd: work,
    home: root,
    commands: () => ['git', 'gitk', 'grep', 'kubectl'],
    variables: () => ['HOME', 'HISTSIZE', 'PATH'],
    ...over,
  };
}

async function complete(line: string, reason: CompletionReason = 'auto', s = session()) {
  return engine.complete(s, line, line.length, reason);
}
const labels = async (line: string, reason: CompletionReason = 'auto', s = session()) =>
  (await complete(line, reason, s))?.items.map((i) => i.label) ?? null;

describe('CompletionEngine', () => {
  it('completes command names, documented ones first', async () => {
    expect(await labels('gi')).toEqual(['git', 'gitk']);
    expect(await labels('')).toBeNull(); // no dropdown on an empty line
  });

  it('completes subcommands and options from the spec', async () => {
    expect(await labels('git ch')).toEqual(['checkout', 'cherry-pick']);
    expect(await labels('git commit --')).toEqual(['--message', '--amend']);
    expect(await labels('git commit -m')).toEqual(['-m']);
    const push = await complete('git push --f');
    expect(push?.items[0]).toMatchObject({ label: '--force', dangerous: true, suffix: ' ' });
  });

  it('completes option values, including --opt=value', async () => {
    expect(await labels('kubectl get pods -o ')).toEqual(['json', 'yaml', 'wide']);
    const eq = await complete('kubectl get pods --output=y');
    expect(eq).toMatchObject({ from: 'kubectl get pods --output='.length, items: [{ label: 'yaml', insert: 'yaml' }] });
  });

  it('ranks your own values first and offers values the spec does not know', async () => {
    for (let i = 0; i < 2; i++) {
      history.record(
        { shell: 'bash', command: 'kubectl -n prod-api get pods -o wide', cwd: null, exitCode: 0, startedAt: Date.now(), durationMs: 1, previousId: null },
        (shell, line) => engine.analyze(env, baseShell(shell), line),
      );
    }
    const ns = await complete('kubectl -n ');
    expect(ns?.items[0]).toMatchObject({ label: 'prod-api', detail: 'yours' });
    expect((await labels('kubectl get pods -o '))?.[0]).toBe('wide');
  });

  it('uses helpers: git branches read from the repository', async () => {
    const items = (await complete('git checkout '))!.items;
    expect(items.slice(0, 2).map((i) => i.label)).toEqual(['feature/login', 'main']);
    // The arg also accepts paths, so files follow the branches.
    expect(items.map((i) => i.label)).toContain(`src${SEP}`);
  });

  it('completes paths with escaping, and only on Tab for unknown tools', async () => {
    expect(await labels('cat ')).toBeNull();
    const tab = await complete('cat my', 'tab');
    expect(tab?.items[0]).toMatchObject({ label: 'my notes.txt', insert: 'my\\ notes.txt', kind: 'file' });
    expect(await labels('git -C ', 'auto')).toEqual([`src${SEP}`]);
    expect((await complete('cat "my', 'tab'))?.items[0].insert).toBe('"my notes.txt"');
  });

  it('completes variables', async () => {
    expect(await labels('echo $HIS')).toEqual(['$HISTSIZE']);
  });

  it('matches PowerShell parameters case-insensitively, using learned cmdlet specs', async () => {
    store.put(env.id, 'get-childitem', '', 'powershell', { names: ['Get-ChildItem'], options: [{ names: ['-Recurse', '-s'] }, { names: ['-Path'], args: [{ name: 'p' }] }] }, null);
    const ps = session('powershell', { commands: () => ['Get-ChildItem', 'Get-Content'] });
    expect(await labels('get-ch', 'auto', ps)).toEqual(['Get-ChildItem']);
    expect(await labels('Get-ChildItem -rec', 'auto', ps)).toEqual(['-Recurse']);
  });

  it('adds tool info, tldr examples and your history in the panel', async () => {
    history.record({ shell: 'bash', command: 'git status -sb', cwd: null, exitCode: 0, startedAt: Date.now(), durationMs: 1, previousId: null });
    const panel = await complete('git ', 'panel');
    expect(panel?.tool).toMatchObject({ name: 'git', description: 'Distributed version control', source: 'bundled' });
    expect(panel?.examples).toEqual([{ text: 'Show status', command: 'git status' }]);
    expect(panel?.history).toEqual(['git status -sb']);
    expect(panel?.items.map((i) => i.label)).toEqual(['checkout', 'cherry-pick', 'commit', 'push']);
  });

  it('marks options confirmed by the installed tool as verified', async () => {
    store.put(env.id, 'git', '', 'help', { names: ['git'], options: [{ names: ['-C'], args: [{ name: 'path' }] }, { names: ['--no-pager'] }] }, '2.45');
    // Cached merges are dropped when something is learned (the learner calls invalidate).
    (engine as unknown as { deps: { knowledge: Knowledge } }).deps.knowledge.invalidate(env.id, 'git');
    const items = (await complete('git -'))!.items;
    expect(items.find((i) => i.label === '-C')?.detail).toBe('verified');
    expect(items.map((i) => i.label)).toContain('--no-pager');
  });
});

describe('a shell on another machine (ssh)', () => {
  const remoteEnv: EnvRef = { id: 'ssh:alice@prod-db', kind: 'ssh' };
  const disk: Record<string, { name: string; isDir: boolean }[]> = {
    '/home/alice': [
      { name: 'projects', isDir: true },
      { name: 'prod notes.txt', isDir: false },
      { name: '.profile', isDir: false },
    ],
    '/home/alice/projects': [{ name: 'alpha', isDir: true }],
  };
  const asked: string[] = [];
  const remoteFs = {
    list: async (dir: string) => {
      asked.push(dir);
      return disk[dir.replace(/\/$/, '')] ?? null;
    },
    kind: async () => 'unknown' as const,
  };
  const remote = (over: Partial<CompletionSession> = {}) =>
    session('bash', { env: remoteEnv, cwd: '/home/alice', home: '/home/alice', remoteFs, commands: () => ['git', 'cat', 'ls'], ...over });

  it('completes paths from the other machine, not from this one', async () => {
    asked.length = 0;
    const res = await complete('cat proj', 'tab', remote());
    expect(res?.items.map((i) => i.label)).toEqual(['projects/']);
    expect(asked).toEqual(['/home/alice']);
    const nested = await complete('cat ~/projects/', 'tab', remote());
    expect(nested?.items.map((i) => ({ label: i.label, insert: i.insert }))).toEqual([{ label: 'alpha/', insert: '~/projects/alpha/' }]);
    // Names are escaped for the remote shell the same way.
    expect((await complete('cat prod', 'tab', remote()))?.items.map((i) => i.insert)).toEqual(['prod\\ notes.txt']);
    // Hidden entries only when asked for.
    expect((await complete('cat .', 'tab', remote()))?.items.map((i) => i.label)).toEqual(['.profile']);
  });

  it('gives nothing when the other machine cannot be asked', async () => {
    const none = remote({ remoteFs: { list: async () => null, kind: async () => 'unknown' } });
    expect((await complete('cat pro', 'tab', none))?.items ?? []).toEqual([]);
  });

  it("does not run this machine's helpers (git branches) for the other machine", async () => {
    asked.length = 0;
    const res = await complete('git checkout ', 'tab', remote({ cwd: work }));
    const labels = res?.items.map((i) => i.label) ?? [];
    expect(labels).not.toContain('main');
    expect(labels).not.toContain('feature/login');
    // It looked at the other machine's disk (the same path there), never at this one's.
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((d) => d === work)).toBe(true);
  });
});
