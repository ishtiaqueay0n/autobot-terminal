import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Checker } from '../src/main/check/checker';
import { suggestFix } from '../src/main/check/fixes';
import { CompletionEngine, type CompletionSession } from '../src/main/complete/engine';
import { Helpers } from '../src/main/complete/helpers';
import { quoteForShell } from '../src/main/complete/paths';
import { HistoryStore } from '../src/main/history/store';
import { parseZshHistory } from '../src/main/history/importers';
import { BundledKb } from '../src/main/kb/bundled';
import { CMD_BUILTIN_NAMES, cmdBuiltin } from '../src/main/kb/cmd-builtins';
import type { EnvRef } from '../src/main/kb/exec';
import { Knowledge } from '../src/main/kb/knowledge';
import { KnowledgeStore } from '../src/main/kb/store';
import { CmdEchoFilter } from '../src/shared/cmd-echo';
import { CMD_HOOK_SUFFIX } from '../src/shared/submit';
import type { CompletionReason } from '../src/shared/types';

const root = mkdtempSync(join(tmpdir(), 'autobot-cmd-'));
const work = join(root, 'work');
const env: EnvRef = { id: 'windows', kind: 'windows' };
let store: KnowledgeStore;
let history: HistoryStore;
let engine: CompletionEngine;
let checker: Checker;

beforeAll(() => {
  const kbDir = join(root, 'kb');
  mkdirSync(kbDir, { recursive: true });
  writeFileSync(join(kbDir, 'index.json'), JSON.stringify({ version: 1, generatedAt: '', fig: {} }));
  mkdirSync(work);
  writeFileSync(join(work, 'notes.txt'), '');
  store = new KnowledgeStore(join(root, 'knowledge.db'));
  history = new HistoryStore(join(root, 'history.db'));
  // PowerShell learned `dir` as an alias of Get-ChildItem in the same environment: cmd must not see it.
  store.put('windows', 'dir', '', 'powershell', { names: ['dir'], options: [{ names: ['-Recurse'] }, { names: ['-Force'] }, { names: ['-Path'] }] }, null);
  const knowledge = new Knowledge(new BundledKb(kbDir), store);
  engine = new CompletionEngine({ knowledge, helpers: new Helpers(() => false), history: () => history });
  checker = new Checker({ source: (e, shell) => engine.source(e, shell), knowledge, history: () => history });
});

afterAll(() => {
  store.close();
  history.close();
  rmSync(root, { recursive: true, force: true });
});

const session = (over: Partial<CompletionSession> = {}): CompletionSession => ({
  shell: 'cmd',
  env,
  cwd: work,
  home: root,
  commands: () => [...CMD_BUILTIN_NAMES, 'git', 'ipconfig'],
  variables: () => [],
  ...over,
});
const labels = async (line: string, reason: CompletionReason = 'auto') =>
  (await engine.complete(session(), line, line.length, reason))?.items.map((i) => i.label) ?? null;

describe('cmd.exe built-in commands', () => {
  it('know their names, aliases and options', () => {
    expect(cmdBuiltin('DIR')?.options?.map((o) => o.names[0])).toContain('/s');
    expect(cmdBuiltin('chdir')).toBe(cmdBuiltin('cd'));
    expect(CMD_BUILTIN_NAMES).toEqual(expect.arrayContaining(['dir', 'copy', 'del', 'rd', 'md', 'set', 'echo', 'cls']));
    expect(cmdBuiltin('git')).toBeNull();
  });
});

describe('cmd.exe completion', () => {
  it('completes command names with descriptions, ahead of nothing else', async () => {
    const res = await engine.complete(session(), 'di', 2, 'auto');
    expect(res?.items.map((i) => i.label)).toContain('dir');
    expect(res?.items.find((i) => i.label === 'dir')?.description).toMatch(/List the files/);
  });

  it('offers a built-in command’s /options, not the PowerShell alias’s -parameters', async () => {
    const opts = await labels('dir /');
    expect(opts).toEqual(expect.arrayContaining(['/s', '/b', '/a', '/o']));
    expect(opts).not.toContain('-Recurse');
  });

  it('matches options without regard to case and understands /a:value', async () => {
    expect(await labels('DIR /S')).toContain('/s');
    // After /s was used it is not offered again; /b still is.
    const after = await labels('dir /s /');
    expect(after).not.toContain('/s');
    expect(after).toContain('/b');
    expect(await labels('dir /a:d /')).toContain('/b');
  });

  it('completes %VARIABLES%', async () => {
    const vars = await labels('echo %ERR');
    expect(vars).toContain('%ERRORLEVEL%');
    const path = await labels('echo %PATH');
    expect(path).toContain('%PATH%');
    expect((await engine.complete(session(), 'echo %ERR', 9, 'auto'))?.items[0].suffix).toBe('');
  });

  it('completes paths with backslashes and quotes names with spaces in double quotes', async () => {
    writeFileSync(join(work, 'my file.txt'), '');
    const res = await engine.complete(session(), 'type my', 7, 'tab');
    expect(res?.items.map((i) => i.insert)).toContain('"my file.txt"');
    expect(quoteForShell('C:\\Program Files\\x', 'cmd', '', true)).toBe('"C:\\Program Files\\x');
    expect(quoteForShell('C:\\plain', 'cmd', '', false)).toBe('C:\\plain');
    expect(quoteForShell('a b', 'cmd', '"', false)).toBe('"a b"');
  });
});

describe('cmd.exe checks', () => {
  const messages = async (text: string) =>
    (await checker.check({ shell: 'cmd', env, cwd: work, home: root, commands: () => [...CMD_BUILTIN_NAMES, 'ipconfig'] }, text, text.length, true)).map((d) => d.message);

  it('flags an unknown command with the closest built-in', async () => {
    expect(await messages('dri /s')).toEqual(["'dri' is not a command. Did you mean 'dir'?"]);
  });

  it.runIf(process.platform === 'win32')('accepts built-ins and programs, in any case, and drive changes and %variables%', async () => {
    for (const ok of ['DIR /s /b', 'ipconfig /all', 'd:', '%windir%\\notepad.exe', 'cd /d C:\\', 'echo hi & dir']) expect(await messages(ok), ok).toEqual([]);
  });

  it('flags an unknown /option of a command whose options are all known', async () => {
    expect((await messages('dir /z'))[0]).toMatch(/\/z/);
  });

  it.runIf(process.platform === 'win32')('does not flag cd /d <folder> options or an existing folder', async () => {
    expect(await messages(`cd /d "${work}"`)).toEqual([]);
  });

  it('warns about destruction before it runs', async () => {
    const diags = await checker.check({ shell: 'cmd', env, cwd: work, home: root, commands: () => CMD_BUILTIN_NAMES }, 'rd /s /q C:\\', 12, true);
    expect(diags.some((d) => d.code === 'danger' && d.severity === 'error')).toBe(true);
  });
});

describe('fixes for zsh and cmd.exe errors', () => {
  const base = { exitCode: 1, shell: 'cmd' as const, windows: true, pm: 'winget' as const, knownTool: () => false };
  it('cmd: "is not recognized" suggests the closest command', () => {
    const fix = suggestFix({
      ...base,
      command: 'dri /b',
      exitCode: 9009,
      output: "'dri' is not recognized as an internal or external command,\r\noperable program or batch file.",
      closestCommand: (w) => (w === 'dri' ? 'dir' : null),
    });
    expect(fix?.command).toBe('dir /b');
  });

  it('zsh: "command not found: name" suggests the closest command', () => {
    const fix = suggestFix({
      exitCode: 127,
      shell: 'zsh',
      windows: false,
      pm: 'apt',
      knownTool: () => false,
      command: 'gti status',
      output: 'zsh: command not found: gti',
      closestCommand: (w) => (w === 'gti' ? 'git' : null),
    });
    expect(fix?.command).toBe('git status');
  });

  it('cmd: access denied and busy ports use cmd.exe wording and tools', () => {
    const denied = suggestFix({ ...base, command: 'sc stop x', output: 'Access is denied.', closestCommand: () => null });
    expect(denied?.detail).toMatch(/elevated Command Prompt/);
    const port = suggestFix({ ...base, command: 'node s.js', output: 'Error: listen EADDRINUSE: address already in use :::3000', closestCommand: () => null });
    expect(port?.command).toBe('netstat -ano | findstr :3000');
  });
});

describe('cmd.exe echo filter', () => {
  it('blanks the hook out of the echoed line, keeping its width', () => {
    const f = new CmdEchoFilter();
    expect(f.push(`dir /b${CMD_HOOK_SUFFIX}\r\n`)).toBe(`dir /b${' '.repeat(CMD_HOOK_SUFFIX.length)}\r\n`);
  });

  it('copes with the text arriving in pieces', () => {
    const f = new CmdEchoFilter();
    const out = [f.push('echo hi &%__'), f.push('AB%'), f.push('\r\nhi\r\n')].join('');
    expect(out).toBe(`echo hi${' '.repeat(CMD_HOOK_SUFFIX.length)}\r\nhi\r\n`);
    expect(f.flush()).toBe('');
  });

  it('passes ordinary text, including a lone & and %, straight through', () => {
    const f = new CmdEchoFilter();
    expect(f.push('a & b %PATH% 100%')).toBe('a & b %PATH% 100%');
    // A held-back tail (it could be the start of the hook) is released with the next chunk if it was not.
    expect(f.push('echo &%')).toBe('echo');
    expect(f.push('PATH%')).toBe(' &%PATH%');
  });
});

describe('zsh history file', () => {
  it('reads extended entries, plain entries and multi-line commands', () => {
    const text = [': 1700000000:0;ls -la', ': 1700000001:2;echo one \\', 'two', 'plain command', ': 1700000002:0;git status', ''].join('\n');
    expect(parseZshHistory(text)).toEqual(['ls -la', 'echo one \ntwo', 'plain command', 'git status']);
  });

  it('decodes zsh’s escaping of non-ASCII bytes', () => {
    // "é" is C3 A9 in UTF-8; zsh stores a byte >= 0x83 as 0x83 followed by the byte xor 0x20.
    const bytes = Buffer.from([...Buffer.from(': 1:0;echo ', 'latin1'), 0x83, 0xc3 ^ 0x20, 0x83, 0xa9 ^ 0x20, 0x0a]);
    expect(parseZshHistory(bytes.toString('latin1'))).toEqual(['echo é']);
  });
});
