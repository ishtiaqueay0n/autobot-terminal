import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { packageManager, osName, rememberOsRelease } from '../src/main/check/packages';
import { CachedRemoteFs, parseKind, parseListing } from '../src/main/complete/remote-fs';
import { HistoryService } from '../src/main/history/service';
import { envForRemote } from '../src/main/kb/exec';
import { launchSpec, type ResolvedProfile } from '../src/main/profiles';
import { RemoteRpc } from '../src/main/rpc';
import type { CommandResult } from '../src/main/session';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/main/settings';
import { buildRemoteCommand, loadRemoteHooks, MAX_COMMAND_LENGTH, minifyHook } from '../src/main/ssh-bootstrap';
import { baseShell, historyKey } from '../src/shared/shell';

const shellDir = join(__dirname, '..', 'resources', 'shell');
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('the command that starts a hooked shell on the remote machine', () => {
  const hooks = loadRemoteHooks(shellDir);
  const command = buildRemoteCommand(hooks);

  it('survives ssh, the user\'s login shell and Windows argument passing', () => {
    // % is expanded by ssh in RemoteCommand, " breaks Windows PowerShell 5.1, ! is csh history, a newline ends the option.
    expect(command).not.toMatch(/[%!"\r\n]/);
    // Exactly one single-quoted script, so nothing can end it early.
    expect(command.match(/'/g)).toHaveLength(2);
    expect(command.startsWith("sh -c '")).toBe(true);
    expect(command.endsWith("'")).toBe(true);
    // OpenSSH before 8.4 (RHEL 8 has 8.0) refuses a RemoteCommand of 4096 characters ("percent_expand: string too long")
    // before it even connects; a Windows command line holds 32 K and ConPTY stalls on long ones.
    expect(MAX_COMMAND_LENGTH).toBeLessThan(4096);
    expect(command.length).toBeLessThan(MAX_COMMAND_LENGTH);
  });

  it('carries the minified hooks for the remote shell and falls back to a plain login shell', () => {
    const decoded = [...command.matchAll(/echo (\S+) \| base64 -d \| gzip -dc/g)].map((m) => gunzipSync(Buffer.from(m[1], 'base64')).toString('utf8'));
    expect(decoded).toEqual([hooks.bash, hooks.zshenv, hooks.zshrc]);
    for (const hook of decoded) {
      expect(hook).not.toMatch(/^\s*#/m); // comments are stripped
      expect(hook).not.toMatch(/\r/);
    }
    expect(hooks.bash).toContain('__autobot_rpc');
    expect(hooks.zshrc).toContain('__autobot_rpc');
    expect(command).toMatch(/exec \$\{SHELL:-sh\} -l'$/);
  });

  it('removes comments, blank lines and indentation, nothing else', () => {
    expect(minifyHook('# a comment\n\nif x; then\n  echo "# not a comment"\nfi\r\n')).toBe('if x; then\necho "# not a comment"\nfi\n');
  });
});

describe('RemoteRpc', () => {
  function setup(canAsk = () => true, timeoutMs = 2000) {
    const sent: string[] = [];
    const state = { released: 0 };
    const rpc = new RemoteRpc((t) => sent.push(t), canAsk, () => state.released++, timeoutMs);
    return { rpc, sent, state };
  }
  afterEach(() => vi.useRealTimers());

  it('types a question with a leading space and holds output back until its prompt', async () => {
    const { rpc, sent, state } = setup();
    const answer = rpc.request('ls', '/etc');
    expect(sent).toEqual([` __autobot_rpc 1 ls ${b64('/etc')}\r`]);
    expect(rpc.busy).toBe(true);
    rpc.reply('1', b64('ok\npasswd'));
    expect(await answer).toBe('ok\npasswd');
    expect(rpc.busy).toBe(true); // the echo and the prompt are still to come
    rpc.prompt();
    expect(rpc.busy).toBe(false);
    expect(state.released).toBe(1);
  });

  it('asks one question at a time', async () => {
    const { rpc, sent } = setup();
    const first = rpc.request('ls', '/a');
    const second = rpc.request('stat', '/b');
    expect(sent).toHaveLength(1);
    rpc.reply('1', b64('ok'));
    rpc.prompt();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain(' 2 stat ');
    rpc.reply('2', b64('d'));
    rpc.prompt();
    expect([await first, await second]).toEqual(['ok', 'd']);
  });

  it('ignores answers to questions nobody asked', () => {
    const { rpc } = setup();
    const answer = rpc.request('ls', '/');
    rpc.reply('99', b64('x'));
    expect(rpc.busy).toBe(true);
    rpc.reply('1', b64('ok'));
    return answer;
  });

  it('gives up on a silent shell, stops asking it, and lets the screen go on', async () => {
    vi.useFakeTimers();
    const { rpc, sent, state } = setup();
    const answer = rpc.request('ls', '/');
    vi.advanceTimersByTime(2000);
    expect(await answer).toBeNull();
    expect(await rpc.request('ls', '/')).toBeNull();
    expect(sent).toHaveLength(1);
    rpc.prompt();
    expect(rpc.busy).toBe(false);
    expect(state.released).toBe(1);
    // A different machine (or the same one later) is asked again.
    rpc.reset();
    void rpc.request('ls', '/');
    expect(sent).toHaveLength(2);
  });

  it('treats a prompt without an answer as a missing helper', async () => {
    const { rpc } = setup();
    const answer = rpc.request('ls', '/');
    rpc.prompt();
    expect(await answer).toBeNull();
    expect(await rpc.request('ls', '/')).toBeNull();
  });

  it('never holds the screen for more than a few seconds', () => {
    vi.useFakeTimers();
    const { rpc, state } = setup();
    void rpc.request('ls', '/');
    vi.advanceTimersByTime(6000);
    expect(rpc.busy).toBe(false);
    expect(state.released).toBe(1);
  });

  it('waits for an idle prompt and drops questions when a command starts', async () => {
    let idle = false;
    const { rpc, sent } = setup(() => idle);
    const waiting = rpc.request('ls', '/');
    expect(sent).toHaveLength(0);
    idle = true;
    rpc.pump();
    expect(sent).toHaveLength(1);
    rpc.reply('1', b64('ok'));
    rpc.prompt();
    expect(await waiting).toBe('ok');

    idle = false;
    const dropped = rpc.request('ls', '/');
    rpc.cancelQueued();
    expect(await dropped).toBeNull();
    expect(sent).toHaveLength(1);
  });
});

describe('what the remote shell reports', () => {
  it('reads folder listings', () => {
    expect(parseListing('ok\nprojects/\nnotes.txt\n.profile')).toEqual([
      { name: 'projects', isDir: true },
      { name: 'notes.txt', isDir: false },
      { name: '.profile', isDir: false },
    ]);
    expect(parseListing('ok')).toEqual([]);
    expect(parseListing('no')).toBeNull();
  });

  it('reads path kinds', () => {
    expect([parseKind('d'), parseKind('f\n'), parseKind('-'), parseKind('?')]).toEqual(['dir', 'file', 'missing', 'unknown']);
  });

  it('asks once per folder, until a command may have changed the disk', async () => {
    const ask = vi.fn(async (op: string, arg: string) => (op === 'ls' ? `ok\n${arg}-file` : 'd'));
    const fs = new CachedRemoteFs(ask);
    await fs.list('/a');
    await fs.list('/a');
    await fs.kind('/a');
    await fs.kind('/a');
    expect(ask).toHaveBeenCalledTimes(2);
    fs.clear();
    await fs.list('/a');
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it('does not remember "could not ask"', async () => {
    let answer: string | null = null;
    const fs = new CachedRemoteFs(async () => answer);
    expect(await fs.list('/a')).toBeNull();
    expect(await fs.kind('/a')).toBe('unknown');
    answer = 'ok\nx';
    expect(await fs.list('/a')).toEqual([{ name: 'x', isDir: false }]);
  });
});

describe('what is known about the other machine', () => {
  it('knows its package manager and name only from what its shell reported', () => {
    const env = envForRemote({ host: 'alice@box-1' });
    expect(env).toEqual({ id: 'ssh:alice@box-1', kind: 'ssh' });
    expect(packageManager(env)).toBeNull();
    expect(osName(env)).toBe('Linux');
    rememberOsRelease(env, 'PRETTY_NAME="Rocky Linux 9.4 (Blue Onyx)"\nNAME="Rocky Linux"\nID="rocky"\nID_LIKE="rhel centos fedora"\n');
    expect(packageManager(env)).toBe('dnf');
    expect(osName(env)).toBe('Rocky Linux 9.4 (Blue Onyx)');
  });
});

describe('history of commands run on another machine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'autobot-remote-history-'));

  const result = (command: string, remote?: CommandResult['remote']): CommandResult => ({
    command,
    cwd: '/home/alice',
    exitCode: 0,
    startedAt: Date.now(),
    durationMs: 5,
    output: '',
    ...(remote ? { remote } : {}),
  });

  it('files them under that machine, apart from the local ones', () => {
    const service = HistoryService.open(join(dir, 'history.db'), () => DEFAULT_SETTINGS);
    const remote = { host: 'alice@prod-db', shell: 'bash' as const };
    service.startSession(1, 'powershell', { id: 'windows', kind: 'windows' });
    service.recordFinished(1, 'powershell', result('Get-ChildItem'));
    service.recordFinished(1, 'powershell', result('systemctl status nginx', remote));
    service.recordFinished(1, 'powershell', result('systemctl restart nginx', remote));

    expect(service.recent('powershell')).toEqual(['Get-ChildItem']);
    expect(service.recent(historyKey('powershell', remote))).toEqual(['systemctl restart nginx', 'systemctl status nginx']);
    expect(service.recent('bash')).toEqual([]);
    // Ghost text on the other machine offers its own history only.
    expect(service.suggest(1, 'bash@alice@prod-db', 'systemctl re', '/home/alice')).toBe('systemctl restart nginx');
    expect(service.suggest(1, 'powershell', 'systemctl re', null)).toBeNull();
    expect(service.suggest(1, 'bash@alice@other-box', 'systemctl re', null)).toBeNull();
    service.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps shell and machine apart in the key', () => {
    expect(historyKey('powershell')).toBe('powershell');
    expect(historyKey('powershell', { host: 'alice@box', shell: 'zsh' })).toBe('zsh@alice@box');
    expect(baseShell('zsh@alice@box')).toBe('zsh');
    expect(baseShell('powershell')).toBe('powershell');
  });
});

describe('settings and launch', () => {
  it('asks about ssh by default and takes only the three choices', () => {
    expect(DEFAULT_SETTINGS.sshIntegration).toBe('ask');
    expect(normalizeSettings({ sshIntegration: 'on' }).sshIntegration).toBe('on');
    expect(normalizeSettings({ sshIntegration: 'off' }).sshIntegration).toBe('off');
    expect(normalizeSettings({ sshIntegration: 'sometimes' }).sshIntegration).toBe('ask');
  });

  const ssh = { mode: 'on' as const, commandFile: 'C:\\Users\\me\\AppData\\Roaming\\Autobot\\ssh-remote-command.txt' };

  it('gives bash, zsh and PowerShell tabs the ssh variables, and cmd none', () => {
    const profile = (kind: ResolvedProfile['kind']): ResolvedProfile => ({
      id: kind,
      name: kind,
      kind,
      pathStyle: kind === 'bash' || kind === 'zsh' ? 'posix' : 'windows',
      executable: 'x',
    });
    for (const kind of ['bash', 'zsh', 'powershell'] as const) {
      const spec = launchSpec(profile(kind), shellDir, ssh);
      expect(spec.env.AUTOBOT_SSH).toBe('on');
      expect(spec.env.AUTOBOT_SSH_CMDFILE).toBe(ssh.commandFile);
    }
    expect(launchSpec(profile('cmd'), shellDir, ssh).env.AUTOBOT_SSH).toBeUndefined();
    expect(launchSpec(profile('bash'), shellDir).env.AUTOBOT_SSH).toBeUndefined();
  });

  it('passes them into a WSL distro, translating the file path', () => {
    const wsl: ResolvedProfile = { id: 'wsl:Ubuntu', name: 'Ubuntu (WSL)', kind: 'bash', pathStyle: 'wsl', wslDistro: 'Ubuntu', executable: 'wsl.exe' };
    const env = launchSpec(wsl, shellDir, ssh).env;
    expect(env.WSLENV!.split(':')).toEqual(expect.arrayContaining(['AUTOBOT_SSH/u', 'AUTOBOT_SSH_CMDFILE/p', 'TERM_PROGRAM/u']));
  });
});
