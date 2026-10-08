import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { detectProfiles, type ResolvedProfile } from '../src/main/profiles';
import { writeRemoteCommandFile } from '../src/main/ssh-bootstrap';
import { Harness, live, shellDir } from './helpers/session-harness';
import { hasShell, pathOn, usable } from './helpers/shells';

/**
 * The remote half of the SSH integration, run on one machine: the shell is started the way the ssh wrapper
 * starts it on the other side (the same command, through `sh -c`), so the hooks, the markers and the questions
 * Autobot asks are all real; only the network is missing. A bash profile is needed (native, or a WSL distro).
 * With AUTOBOT_TEST_SSH set (ssh arguments, e.g. "-p 2222 -i key user@localhost") it also logs in for real.
 */

const profiles = await detectProfiles();
// AUTOBOT_TEST_DISTRO picks the WSL distro to run in (to test zsh in a distro that has it).
const bash = profiles.find((p) => p.kind === 'bash' && (!process.env.AUTOBOT_TEST_DISTRO || p.wslDistro === process.env.AUTOBOT_TEST_DISTRO));
const tmp = mkdtempSync(join(tmpdir(), 'autobot-ssh-'));
afterEach(() => {
  while (live.length) live.pop()!.kill();
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Starts the remote shell like ssh does with the wrapper's RemoteCommand, and waits for its first prompt. */
async function connect(h: Harness, remoteShell: string): Promise<void> {
  const file = join(tmp, `command-${remoteShell}.txt`);
  writeRemoteCommandFile(shellDir, file);
  const shellPath = pathOn(h.profile, file);
  const line = `SHELL=$(command -v ${remoteShell}) sh -c "$(cat '${shellPath}')"`;
  const result = await h.run(line);
  expect(result.prompt.remote).toMatchObject({ shell: remoteShell });
  // The command that started the session is still running underneath: not finished, not recorded yet.
  expect(result.result).toBeUndefined();
}

const props = (h: Harness, key: string): string[] =>
  h.events.filter((e) => e.type === 'property' && e.key === key).map((e) => (e.type === 'property' ? e.value : ''));

describe.runIf(usable(bash))('a remote bash (hooked the way the ssh wrapper does it)', () => {
  it('names the machine, reports what it has and answers questions without a trace on screen', async () => {
    const h = new Harness(bash!);
    await h.waitFor(() => h.prompts.length >= 1, 60000);
    await connect(h, 'bash');
    const prompt = h.prompts[h.prompts.length - 1];
    expect(prompt.remote!.host).toMatch(/^\S+@\S+$/);
    expect(prompt.gitBranch).toBeNull();

    const names = Buffer.from(props(h, 'RemoteCommands')[0], 'base64').toString().split('\n');
    expect(names).toContain('ls');
    expect(names).toContain('cd');
    expect(Buffer.from(props(h, 'RemoteVariables')[0], 'base64').toString().split('\n')).toContain('HOME');
    expect(props(h, 'RemoteShell')[0]).toMatch(/^bash \d/);
    expect(props(h, 'RemoteHome')[0]).toMatch(/^\//);
    expect(Buffer.from(props(h, 'RemoteOs')[0], 'base64').toString()).toMatch(/^(NAME|PRETTY_NAME|ID)=/m);

    // Questions: nothing of the exchange (the echoed line, the prompt) reaches the screen.
    const start = h.events.length;
    const home = props(h, 'RemoteHome')[0];
    const listing = await h.session.askRemote('ls', '/etc');
    expect(listing).toMatch(/^ok\n/);
    expect(listing!.split('\n')).toContain('passwd');
    expect(listing!.split('\n')).toContain('skel/'); // folders end in /
    expect(await h.session.askRemote('ls', '/definitely/not/here')).toBe('no');
    expect(await h.session.askRemote('stat', '/etc/passwd')).toBe('f');
    expect(await h.session.askRemote('stat', '/etc')).toBe('d');
    expect(await h.session.askRemote('stat', '/definitely/not/here')).toBe('-');
    expect(await h.session.askRemote('ls', home)).toMatch(/^ok\n/);
    await new Promise((r) => setTimeout(r, 300));
    const shown = h.output(start);
    expect(shown).not.toContain('__autobot_rpc');
    expect(shown).not.toContain('Q;');
    expect(h.prompts.length).toBe(1 + 1); // the local one and the remote one; the questions' prompts were held back
    expect(h.events.slice(start).some((e) => e.type === 'commandStart')).toBe(false);

    // A command typed while a question is still open runs after it, in order.
    const before = h.prompts.length;
    const asking = h.session.askRemote('ls', '/etc');
    h.session.submit('echo typed-during-question', true);
    expect(await asking).toMatch(/^ok\n/);
    await h.waitFor(() => h.prompts.length > before);
    expect(h.output(start)).toContain('typed-during-question');
    expect(h.results[h.results.length - 1]).toMatchObject({ command: 'echo typed-during-question', exitCode: 0 });
    expect(h.results[h.results.length - 1].remote).toEqual(prompt.remote);

    // A failure on the remote side is a failure of that command, on that machine.
    const failed = await h.run('(exit 3)');
    expect(failed.prompt.exitCode).toBe(3);
    expect(failed.result).toMatchObject({ command: '(exit 3)', exitCode: 3, remote: prompt.remote });

    // Leaving: back to this machine's prompt, and the ssh command itself finishes (once, as a local command).
    const resultsBefore = h.results.length;
    const back = await h.run('exit');
    expect(back.prompt.remote).toBeUndefined();
    expect(h.results.length).toBe(resultsBefore + 1);
    expect(h.results[h.results.length - 1].command).toContain('sh -c');
    expect(h.results[h.results.length - 1].remote).toBeUndefined();
    // Nothing is asked of a machine that is no longer there.
    expect(await h.session.askRemote('ls', '/')).toBeNull();
  }, 120000);

  it('stops asking a shell that does not answer, and keeps working', async () => {
    const h = new Harness(bash!);
    await h.waitFor(() => h.prompts.length >= 1, 60000);
    await connect(h, 'bash');
    await h.run('unset -f __autobot_rpc');
    const start = h.events.length;
    expect(await h.session.askRemote('ls', '/etc')).toBeNull();
    expect(await h.session.askRemote('stat', '/etc')).toBeNull();
    expect((await h.run('echo still-works')).output).toContain('still-works');
    expect(h.output(start)).not.toContain('__autobot_rpc');
  }, 120000);

  it('does not lose this machine\'s prompt when the connection ends during a question', async () => {
    const h = new Harness(bash!);
    await h.waitFor(() => h.prompts.length >= 1, 60000);
    await connect(h, 'bash');
    // A helper that ends the remote shell stands in for a connection that drops while a question is open.
    await h.run('__autobot_rpc() { exit 0; }');
    const before = h.prompts.length;
    expect(await h.session.askRemote('ls', '/etc')).toBeNull();
    await h.waitFor(() => h.prompts.length > before);
    expect(h.prompts[h.prompts.length - 1].remote).toBeUndefined();
    // Back on this machine, and still usable.
    expect((await h.run('echo back-home')).output).toContain('back-home');
    expect(h.results.some((r) => r.command.includes('sh -c') && r.remote === undefined)).toBe(true);
  }, 120000);

  it('does not ask while a command is running', async () => {
    const h = new Harness(bash!);
    await h.waitFor(() => h.prompts.length >= 1, 60000);
    await connect(h, 'bash');
    const before = h.prompts.length;
    h.session.submit('sleep 1; echo slept', true);
    expect(await h.session.askRemote('ls', '/etc')).toBeNull();
    await h.waitFor(() => h.prompts.length > before);
    expect(h.output()).toContain('slept');
  }, 120000);
});

describe.runIf(usable(bash))('the answer to the ssh wrapper\'s question', () => {
  it('counts only when it carries the tab\'s secret, not when some program prints it', async () => {
    const file = join(tmp, 'choice-command.txt');
    writeRemoteCommandFile(shellDir, file);
    const h = new Harness(bash!, { mode: 'ask', commandFile: file });
    await h.waitFor(() => h.prompts.length >= 1, 60000);
    // Text printed by any program (a file, a remote machine) must not be able to change the setting.
    await h.run("printf '\\033]7777;P;SshChoice=on:forged\\007'");
    await h.run("printf '\\033]7777;P;SshChoice=on\\007'");
    expect(h.events.some((e) => e.type === 'property' && e.key === 'SshChoice')).toBe(false);
    // The tab's own secret is in its environment, which is where the wrapper reads it from.
    const withToken = await h.run('printf "\\033]7777;P;SshChoice=off:$AUTOBOT_SSH_TOKEN\\007"');
    expect(withToken.prompt).toBeDefined();
    expect(h.events).toContainEqual({ type: 'property', key: 'SshChoice', value: 'off' });
  }, 120000);
});

describe.runIf(usable(bash) && hasShell(bash!, 'zsh'))('a remote zsh', () => {
  it('reports the same things as bash does', async () => {
    const h = new Harness(bash!);
    await h.waitFor(() => h.prompts.length >= 1, 60000);
    await connect(h, 'zsh');
    const prompt = h.prompts[h.prompts.length - 1];
    expect(prompt.remote).toMatchObject({ shell: 'zsh' });
    expect(props(h, 'RemoteShell')[0]).toMatch(/^zsh \d/);
    const names = Buffer.from(props(h, 'RemoteCommands')[0], 'base64').toString().split('\n');
    expect(names).toContain('ls');
    expect(names).not.toContain('_git');

    expect(await h.session.askRemote('ls', '/etc')).toMatch(/^ok\n/);
    expect(await h.session.askRemote('stat', '/etc/passwd')).toBe('f');
    expect(h.output()).not.toContain('__autobot_rpc');

    const failed = await h.run('(exit 4)');
    expect(failed.prompt.exitCode).toBe(4);
    expect(failed.result).toMatchObject({ command: '(exit 4)', exitCode: 4, remote: prompt.remote });
    expect((await h.run('exit')).prompt.remote).toBeUndefined();
  }, 120000);
});

// ------------------------------------------------------------------------------- a real ssh server

const sshArgs = process.env.AUTOBOT_TEST_SSH;
/** zsh on this machine (a native Linux profile starts its executable, so a bash profile cannot stand in for zsh). */
function zshPath(): string {
  return execFileSync('sh', ['-c', 'command -v zsh'], { encoding: 'utf8' }).trim();
}

// The local shell: PowerShell where there is one, else bash. AUTOBOT_TEST_LOCAL=bash or zsh forces that shell in
// the bash profile's machine (e.g. a WSL distro).
const local =
  process.env.AUTOBOT_TEST_LOCAL === 'bash'
    ? bash
    : process.env.AUTOBOT_TEST_LOCAL === 'zsh' && bash
      ? ({ ...bash, id: `${bash.id}:zsh`, kind: 'zsh', executable: bash.pathStyle === 'wsl' ? bash.executable : zshPath() } as ResolvedProfile)
      : (profiles.find((p) => p.id === 'powershell' || p.id === 'pwsh') ?? profiles.find((p) => p.kind === 'bash' || p.kind === 'zsh'));

describe.runIf(sshArgs && usable(local))('the ssh wrapper against a real server', () => {
  const start = (mode: 'on' | 'ask' | 'off') => {
    const file = join(tmp, 'ssh-command.txt');
    writeRemoteCommandFile(shellDir, file);
    return new Harness(local!, { mode, commandFile: file });
  };

  it('logs in with the helper loaded and comes back', async () => {
    const h = start('on');
    await h.waitFor(() => h.prompts.length >= 1, 60000);
    const login = await h.run(`ssh ${sshArgs}`);
    expect(login.prompt.remote!.host).toMatch(/@/);
    expect(await h.session.askRemote('ls', '/')).toMatch(/^ok\n/);
    expect((await h.run('echo over-there')).output).toContain('over-there');
    const back = await h.run('exit');
    expect(back.prompt.remote).toBeUndefined();
  }, 120000);

  it('leaves a command given on the ssh line alone', async () => {
    const h = start('on');
    await h.waitFor(() => h.prompts.length >= 1, 60000);
    const run = await h.run(`ssh ${sshArgs} echo plain-ssh-output`);
    expect(run.output).toContain('plain-ssh-output');
    expect(run.prompt.remote).toBeUndefined();
    expect(run.result).toMatchObject({ exitCode: 0 });
  }, 120000);

  it.runIf(process.env.AUTOBOT_TEST_SSH_GIT)('leaves the git account alone: it would refuse the helper', async () => {
    const h = start('on');
    await h.waitFor(() => h.prompts.length >= 1, 60000);
    h.session.submit(`ssh ${process.env.AUTOBOT_TEST_SSH_GIT}`, true);
    await new Promise((r) => setTimeout(r, 6000));
    // A plain login shell: no hook over there, so no remote prompt and no reports.
    expect(h.prompts.length).toBe(1);
    expect(h.events.some((e) => e.type === 'property' && e.key.startsWith('Remote'))).toBe(false);
    h.session.write('exit\r');
    await h.waitFor(() => h.prompts.length >= 2);
  }, 120000);

  it('does nothing special when turned off', async () => {
    const h = start('off');
    await h.waitFor(() => h.prompts.length >= 1, 60000);
    h.session.submit(`ssh ${sshArgs}`, true);
    await new Promise((r) => setTimeout(r, 6000));
    expect(h.prompts.length).toBe(1); // no remote prompt: the plain login shell has no hook
    expect(h.events.some((e) => e.type === 'property' && e.key.startsWith('Remote'))).toBe(false);
    h.session.write('exit\r');
    await h.waitFor(() => h.prompts.length >= 2);
  }, 120000);

  it('asks first and remembers "always"', async () => {
    const h = start('ask');
    await h.waitFor(() => h.prompts.length >= 1, 60000);
    h.session.submit(`ssh ${sshArgs}`, true);
    await h.waitFor(() => h.output().includes('not this time'), 30000);
    h.session.write('a\r');
    await h.waitFor(() => h.prompts.some((p) => p.remote), 30000);
    expect(h.events).toContainEqual({ type: 'property', key: 'SshChoice', value: 'on' });
    await h.run('exit');
    // The tab now has the answer: the next login goes straight in.
    const again = await h.run(`ssh ${sshArgs}`);
    expect(again.prompt.remote).toBeDefined();
    expect(h.output()).not.toMatch(/not this time[\s\S]*not this time/);
    await h.run('exit');
  }, 180000);
});
