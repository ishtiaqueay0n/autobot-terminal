import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Checker, gitAliases, type CheckSession } from '../src/main/check/checker';
import { CompletionEngine } from '../src/main/complete/engine';
import { Helpers } from '../src/main/complete/helpers';
import { HistoryStore } from '../src/main/history/store';
import { BundledKb } from '../src/main/kb/bundled';
import type { EnvRef } from '../src/main/kb/exec';
import { Knowledge } from '../src/main/kb/knowledge';
import { KnowledgeStore } from '../src/main/kb/store';
import type { KbSpec } from '../src/shared/kb-types';
import type { ShellKind } from '../src/shared/types';

const root = mkdtempSync(join(tmpdir(), 'autobot-check-'));
const work = join(root, 'work');
const home = join(root, 'home');
const env: EnvRef = process.platform === 'win32' ? { id: 'windows', kind: 'windows' } : { id: 'linux', kind: 'linux' };

const specs: Record<string, KbSpec> = {
  git: {
    names: ['git'],
    subcommands: [{ names: ['status'] }, { names: ['stash'] }, { names: ['commit'], options: [{ names: ['-m'], args: [{ name: 'msg' }] }] }],
  },
  kubectl: {
    names: ['kubectl'],
    options: [{ names: ['-n', '--namespace'], persistent: true, args: [{ name: 'ns' }] }],
    subcommands: [{ names: ['get'], options: [{ names: ['-o', '--output'], args: [{ name: 'fmt' }] }], args: [{ name: 'type' }] }],
  },
  ls: {
    names: ['ls'],
    options: [{ names: ['-l'] }, { names: ['-a', '--all'] }, { names: ['--color'] }, { names: ['-w', '--width'], args: [{ name: 'cols' }] }],
    args: [{ name: 'path', variadic: true, templates: ['filepaths'] }],
  },
  cat: { names: ['cat'], args: [{ name: 'file', variadic: true, templates: ['filepaths'] }] },
  sort: { names: ['sort'] },
};

let store: KnowledgeStore;
let history: HistoryStore;
let knowledge: Knowledge;
let checker: Checker;

beforeAll(() => {
  const kbDir = join(root, 'kb');
  mkdirSync(join(kbDir, 'fig'), { recursive: true });
  const index: Record<string, { file: string }> = {};
  for (const [name, spec] of Object.entries(specs)) {
    writeFileSync(join(kbDir, 'fig', `${name}.json.gz`), gzipSync(JSON.stringify(spec)));
    index[name] = { file: `fig/${name}.json.gz` };
  }
  writeFileSync(join(kbDir, 'index.json'), JSON.stringify({ version: 1, generatedAt: '', fig: index }));
  mkdirSync(join(work, 'src'), { recursive: true });
  writeFileSync(join(work, 'notes.txt'), 'x');
  mkdirSync(home);
  writeFileSync(join(home, '.gitconfig'), '[user]\n  name = me\n[alias]\n  co = checkout\n  st = status -sb\n');

  store = new KnowledgeStore(join(root, 'knowledge.db'));
  history = new HistoryStore(join(root, 'history.db'));
  knowledge = new Knowledge(new BundledKb(kbDir), store);
  // ls is "verified" on this machine: its --help was learned.
  store.put(env.id, 'ls', '', 'help', { names: ['ls'], options: [{ names: ['-l'] }, { names: ['-a', '--all'] }, { names: ['--color'] }, { names: ['-w', '--width'], args: [{ name: 'cols' }] }] }, '9.4');
  const engine = new CompletionEngine({ knowledge, helpers: new Helpers(() => false), history: () => history });
  checker = new Checker({ source: (e, shell) => engine.source(e, shell), knowledge, history: () => history });
});

afterAll(() => {
  store.close();
  history.close();
  rmSync(root, { recursive: true, force: true });
});

function session(shell: ShellKind = 'bash', over: Partial<CheckSession> = {}): CheckSession {
  return {
    shell,
    env,
    cwd: work,
    home,
    commands: () => ['git', 'kubectl', 'ls', 'cat', 'sort', 'echo', 'cd', 'rm', 'docker', 'git-lfs'],
    ...over,
  };
}

/** Diagnostics for a line being submitted (all words finished), as "code:severity:text". */
async function check(line: string, s = session(), cursor = line.length, submit = true) {
  const diags = await checker.check(s, line, cursor, submit);
  return diags.map((d) => `${d.code}:${d.severity}:${line.slice(d.from, d.to)}`);
}

describe('Checker', () => {
  it('flags unknown commands with a suggestion and a fix', async () => {
    const [d] = await checker.check(session(), 'kubctl get pods', 15, true);
    expect(d).toMatchObject({ code: 'unknown-command', severity: 'error', from: 0, to: 6, fix: { insert: 'kubectl' } });
    expect(d.message).toContain("Did you mean 'kubectl'?");
    expect(await check('git status && dcoker ps')).toEqual(['unknown-command:error:dcoker']);
  });

  it('waits for the command list and skips words still being typed', async () => {
    expect(await check('kubctl', session('bash', { commands: () => null }))).toEqual([]);
    expect(await check('kubctl', session(), 6, false)).toEqual([]);
    expect(await check('kubctl ', session(), 7, false)).toEqual(['unknown-command:error:kubctl']);
  });

  it('accepts commands that ran successfully before (aliases defined later)', async () => {
    history.record({ shell: 'bash', command: 'myalias --x', cwd: null, exitCode: 0, startedAt: Date.now(), durationMs: 1, previousId: null });
    expect(await check('myalias')).toEqual([]);
  });

  it('marks unknown options red when the installed tool confirmed its options, yellow otherwise', async () => {
    const [ls] = await checker.check(session(), 'ls --colr', 9, true);
    expect(ls).toMatchObject({ code: 'unknown-option', severity: 'error', fix: { insert: '--color' } });
    expect(await check('kubectl get pods --outptu yaml')).toEqual(['unknown-option:warning:--outptu']);
  });

  it('accepts combined short flags, attached values and option values', async () => {
    expect(await check('ls -la')).toEqual([]);
    expect(await check('ls -w80 -l')).toEqual([]);
    expect(await check('ls --width=80')).toEqual([]);
    expect(await check('kubectl -n prod get pods -o yaml')).toEqual([]);
  });

  it('flags an option value that is missing before the next option', async () => {
    expect(await check('kubectl -n -o yaml get pods')).toContain('missing-value:error:-n');
  });

  it('flags unknown subcommands but accepts git aliases and plugins', async () => {
    const [d] = await checker.check(session(), 'git stauts', 10, true);
    expect(d).toMatchObject({ code: 'unknown-subcommand', severity: 'warning', fix: { insert: 'status' } });
    expect(await check('git co main')).toEqual([]);
    expect(await check('git lfs pull')).toEqual([]);
  });

  it('checks paths', async () => {
    expect(await check('cat notes.txt src')).toEqual([]);
    expect(await check('cat nope.txt')).toEqual(['missing-path:warning:nope.txt']);
    expect(await check('cd nowhere')).toEqual(['missing-path:error:nowhere']);
    expect(await check('cd notes.txt')).toEqual(['missing-path:error:notes.txt']);
    expect(await check('cd ~')).toEqual([]);
    expect(await check('sort < nope.csv')).toEqual(['missing-path:error:nope.csv']);
    expect(await check('echo hi > new.txt')).toEqual([]);
    expect(await check('cat *.txt $HOME/x')).toEqual([]);
  });

  it('reports syntax errors and dangerous commands', async () => {
    expect(await check('ls | | sort')).toEqual(['syntax:error:|']);
    expect(await check('rm -rf /')).toEqual(['danger:error:rm -rf /']);
    expect(await check('git push --force')).toContain('danger:warning:git push --force');
  });

  it('checks PowerShell parameters case-insensitively, with exact metadata', async () => {
    store.put(env.id, 'get-childitem', '', 'powershell', { names: ['Get-ChildItem'], options: [{ names: ['-Path'], args: [{ name: 'p' }] }, { names: ['-Recurse'] }, { names: ['-Force'] }] }, null);
    knowledge.invalidate(env.id, 'get-childitem');
    const ps = session('powershell', { commands: () => ['Get-ChildItem', 'Get-Content'] });
    expect(await check('get-childitem -recurse -rec -path:src', ps)).toEqual([]);
    expect(await check('Get-ChildItem -Recrse', ps)).toEqual(['unknown-option:error:-Recrse']);
    expect(await check('Get-ChildItm', ps)).toEqual(['unknown-command:error:Get-ChildItm']);
    expect(await check('foreach ($x in 1..3) { $x }', ps)).toEqual([]);
  });
});

describe('gitAliases', () => {
  it('reads alias names from a git config', () => {
    expect(gitAliases('[core]\n\tbare = false\n[alias]\n\tco = checkout\n\tlg = log --oneline\n[user]\n\tname = x\n')).toEqual(['co', 'lg']);
  });
});

describe('Checker on a shell on another machine (ssh)', () => {
  const remoteEnv: EnvRef = { id: 'ssh:alice@prod-db', kind: 'ssh' };
  const known: Record<string, 'dir' | 'file'> = { '/home/alice': 'dir', '/home/alice/notes.txt': 'file', '/etc': 'dir' };
  const remote = (over: Partial<CheckSession> = {}): CheckSession => ({
    shell: 'bash',
    env: remoteEnv,
    cwd: '/home/alice',
    home: '/home/alice',
    commands: () => ['cat', 'cd', 'git', 'ls'],
    remoteFs: { list: async () => null, kind: async (p) => known[p] ?? 'missing' },
    ...over,
  });

  it('checks paths on the other machine', async () => {
    expect(await check('cat notes.txt', remote())).toEqual([]);
    expect(await check('cat nope.txt', remote())).toEqual(['missing-path:warning:nope.txt']);
    expect(await check('cd /etc', remote())).toEqual([]);
    expect(await check('cd ~/nowhere', remote())).toEqual(['missing-path:error:~/nowhere']);
    expect(await check('cd notes.txt', remote())).toEqual(['missing-path:error:notes.txt']);
  });

  it('says nothing about a path it cannot look up', async () => {
    const blind = remote({ remoteFs: { list: async () => null, kind: async () => 'unknown' } });
    expect(await check('cat nope.txt', blind)).toEqual([]);
    expect(await check('cd nowhere', remote({ remoteFs: undefined }))).toEqual([]);
  });

  it("does not read this machine's git config for the other machine's aliases", async () => {
    // "co" is an alias in the local home's .gitconfig; over there it is just an unknown subcommand.
    expect(await check('git co', remote({ home }))).not.toEqual(await check('git co', session()));
  });
});
