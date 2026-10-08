import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { detectProfiles, type ResolvedProfile } from '../src/main/profiles';
import { Harness, live } from './helpers/session-harness';

/**
 * Runs real shells with the Autobot hook through node-pty and checks the marker protocol end to end.
 * Profiles that are not installed on this machine are skipped.
 */

const profiles = await detectProfiles();
afterEach(() => {
  while (live.length) live.pop()!.kill();
});

const powershell = profiles.find((p) => p.id === 'powershell' || p.id === 'pwsh');
const bash = profiles.find((p) => p.kind === 'bash');
const wslUsable =
  bash?.pathStyle !== 'wsl' ||
  (() => {
    try {
      execFileSync('wsl.exe', ['-d', bash.wslDistro!, '-e', 'true'], { timeout: 60000 });
      return true;
    } catch {
      return false;
    }
  })();

describe.runIf(powershell)('PowerShell hook', () => {
  it('reports prompts, exit codes, cwd, properties and handles multi-line input', async () => {
    const h = new Harness(powershell!);
    await h.waitFor(() => h.prompts.length >= 1);
    expect(h.events.some((e) => e.type === 'property' && e.key === 'Home')).toBe(true);
    // Aliases and functions from the session, for command completion.
    expect(await h.commandNames()).toContain('gci');

    expect((await h.run('Get-Item C:\\definitely-not-here-xyz')).prompt.exitCode).toBe(1);
    const native = await h.run('cmd /c exit 3');
    expect(native.prompt.exitCode).toBe(3);
    expect(native.result).toMatchObject({ command: 'cmd /c exit 3', exitCode: 3, cwd: h.prompts[0].cwd });
    expect(native.result!.durationMs).toBeGreaterThanOrEqual(0);
    expect((await h.run('Write-Output ok')).prompt.exitCode).toBe(0);

    const cd = await h.run('Set-Location $env:SystemRoot');
    expect(cd.prompt.cwd.toLowerCase()).toBe((process.env.SystemRoot ?? 'C:\\Windows').toLowerCase());

    // One block across three lines: the closing empty line ends the >> continuation.
    const block = await h.run('if ($true) {\n  "inside-block"\n}');
    expect(block.output).toContain('inside-block');

    // Output without a trailing newline still leaves the next command on a fresh line
    // (the 5.1 host adds the newline itself; the hook's % marker covers hosts that do not).
    const partial = await h.run('Write-Host -NoNewline partial-out');
    expect(partial.output).toMatch(/partial-out[^\n]*\n/);
  });
});

describe.runIf(bash && wslUsable)('bash hook', () => {
  it('reports prompts, exit codes, cwd, command start and handles multi-line input', async () => {
    const h = new Harness(bash!);
    await h.waitFor(() => h.prompts.length >= 1, 60000);
    expect(h.events.some((e) => e.type === 'property' && e.key === 'Home')).toBe(true);
    // compgen -c output (written in the background), for command completion.
    const names = await h.commandNames();
    expect(names).toContain('ls');
    expect(names).toContain('cd');

    expect((await h.run('false')).prompt.exitCode).toBe(1);
    const sub = await h.run('(exit 7)');
    expect(sub.prompt.exitCode).toBe(7);
    expect(sub.result).toMatchObject({ command: '(exit 7)', exitCode: 7 });
    const ok = await h.run('true');
    expect(ok.prompt.exitCode).toBe(0);
    expect(h.events.some((e) => e.type === 'commandStart')).toBe(true);

    expect((await h.run('cd /tmp')).prompt.cwd).toBe('/tmp');
    // The next command reports the folder it started in.
    expect((await h.run('true')).result).toMatchObject({ command: 'true', cwd: '/tmp', exitCode: 0 });

    const loop = await h.run('for i in 1 2; do\n  echo "n$i"\ndone');
    expect(loop.output).toContain('n1');
    expect(loop.output).toContain('n2');

    // Output without a newline is marked with a dim %. Distros add their own prompt hooks before ours (the
    // window-title sequence from RHEL's and Fedora's /etc/bashrc), so allow OSC sequences in between.
    const partial = await h.run('printf partial-out');
    expect(partial.output).toMatch(/partial-out(?:\x1b\][^\x07]*\x07)*\x1b\[2;7m%/);
  });
});

// ------------------------------------------------------------------------------------------------ zsh

/** A zsh profile: the native one, or a WSL distro that has zsh (WSL profiles list it only once known). */
function findZsh(): ResolvedProfile | undefined {
  const native = profiles.find((p) => p.kind === 'zsh');
  if (native) return native;
  // AUTOBOT_TEST_DISTRO picks the WSL distro (Ubuntu's /etc/zsh/zshrc runs compinit, RHEL's does not).
  const only = process.env.AUTOBOT_TEST_DISTRO;
  for (const p of profiles.filter((q) => q.pathStyle === 'wsl' && (!only || q.wslDistro === only))) {
    try {
      execFileSync('wsl.exe', ['-d', p.wslDistro!, '-e', 'sh', '-c', 'command -v zsh'], { timeout: 60000, stdio: 'pipe' });
      return { ...p, id: `${p.id}:zsh`, name: `${p.name}, zsh`, kind: 'zsh' };
    } catch {
      // No zsh in this distro.
    }
  }
  return undefined;
}
const zsh = findZsh();

describe.runIf(zsh)('zsh hook', () => {
  it('reports prompts, exit codes, cwd, command start and handles multi-line input', async () => {
    const h = new Harness(zsh!);
    await h.waitFor(() => h.prompts.length >= 1, 60000);
    expect(h.events.some((e) => e.type === 'property' && e.key === 'Home')).toBe(true);
    expect(h.events.find((e) => e.type === 'property' && e.key === 'Shell')).toMatchObject({ value: expect.stringMatching(/^zsh \d/) });
    // The background listing of commands, aliases, functions and builtins, for command completion.
    const names = await h.commandNames();
    expect(names).toContain('ls');
    expect(names).toContain('cd');
    expect(names).not.toContain('_git');

    expect((await h.run('false')).prompt.exitCode).toBe(1);
    const sub = await h.run('(exit 7)');
    expect(sub.prompt.exitCode).toBe(7);
    expect(sub.result).toMatchObject({ command: '(exit 7)', exitCode: 7 });
    expect((await h.run('true')).prompt.exitCode).toBe(0);
    expect(h.events.some((e) => e.type === 'commandStart')).toBe(true);

    expect((await h.run('cd /tmp')).prompt.cwd).toBe('/tmp');
    expect((await h.run('true')).result).toMatchObject({ command: 'true', cwd: '/tmp', exitCode: 0 });

    const loop = await h.run('for i in 1 2; do\n  echo "n$i"\ndone');
    expect(loop.output).toContain('n1');
    expect(loop.output).toContain('n2');

    // zsh marks output without a newline itself and moves to a fresh line.
    const partial = await h.run('printf partial-out');
    expect(partial.output).toContain('partial-out');
    expect((await h.run('echo after-partial')).output).toContain('after-partial');
  });
});

// -------------------------------------------------------------------------------------------- cmd.exe

const cmd = profiles.find((p) => p.kind === 'cmd');

describe.runIf(cmd)('cmd.exe hook', () => {
  it('reports prompts, exit codes and cwd, and keeps the hook out of the output', async () => {
    const h = new Harness(cmd!);
    await h.waitFor(() => h.prompts.length >= 1, 30000);
    expect(h.events.some((e) => e.type === 'property' && e.key === 'Home')).toBe(true);
    expect(h.events.find((e) => e.type === 'property' && e.key === 'Shell')).toMatchObject({ value: expect.stringMatching(/^cmd \d/) });

    const hello = await h.run('echo hello-cmd');
    expect(hello.prompt.exitCode).toBe(0);
    expect(hello.output).toContain('hello-cmd');
    // The exit-code hook appended to the line is blanked out of the echo.
    expect(hello.output).not.toContain('__AB');
    expect(hello.output).not.toContain('&%');
    expect(hello.result).toMatchObject({ command: 'echo hello-cmd', exitCode: 0 });

    expect((await h.run('dir C:\definitely-not-here-xyz')).prompt.exitCode).toBe(1);
    const native = await h.run('cmd /c exit 7');
    expect(native.prompt.exitCode).toBe(7);
    expect(native.result).toMatchObject({ command: 'cmd /c exit 7', exitCode: 7 });
    expect((await h.run("'nonexistent-command-xyz' ")).prompt.exitCode).toBe(9009);
    expect((await h.run('echo back-to-zero')).prompt.exitCode).toBe(0);

    const cd = await h.run('cd /d %SystemRoot%');
    expect(cd.prompt.cwd.toLowerCase()).toBe((process.env.SystemRoot ?? 'C:\Windows').toLowerCase());
    // The next command reports the folder it started in.
    expect((await h.run('echo again')).result?.cwd?.toLowerCase()).toBe((process.env.SystemRoot ?? 'C:\Windows').toLowerCase());

    // Independent lines run as one command with one prompt; a block goes in as continuation lines.
    const lines = await h.run('echo line-a\necho line-b');
    expect(lines.output).toContain('line-a');
    expect(lines.output).toContain('line-b');
    const block = await h.run('if 1==1 (\n  echo inside-block\n)');
    expect(block.output).toContain('inside-block');
    expect(block.prompt.exitCode).toBe(0);
  });
});
