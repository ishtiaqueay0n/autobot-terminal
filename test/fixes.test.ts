import { describe, expect, it } from 'vitest';
import { suggestFix, replaceWord, type FailureContext } from '../src/main/check/fixes';
import { installCommand, packageManagerFromOsRelease } from '../src/main/check/packages';
import { stripAnsi } from '../src/shared/ansi';

function fix(command: string, output: string, over: Partial<FailureContext> = {}) {
  return suggestFix({
    command,
    exitCode: 1,
    output,
    shell: 'bash',
    windows: false,
    pm: 'apt',
    closestCommand: (w) => (w === 'kubctl' ? 'kubectl' : w === 'dcoker' ? 'docker' : null),
    knownTool: (n) => ['htop', 'jq', 'tree'].includes(n),
    ...over,
  });
}

describe('suggestFix', () => {
  it('fixes typos in the command name', () => {
    expect(fix('kubctl get pods', 'bash: kubctl: command not found', { exitCode: 127 })).toEqual({
      title: "'kubctl' is not a command. Did you mean 'kubectl'?",
      command: 'kubectl get pods',
    });
    expect(
      fix('dcoker ps', "dcoker : The term 'dcoker' is not recognized as the name of a cmdlet, function, script file, or operable program.", {
        shell: 'powershell',
        windows: true,
        pm: 'winget',
      })?.command,
    ).toBe('docker ps');
  });

  it('suggests installing missing tools with the right package manager and name', () => {
    expect(fix('dig example.com', 'bash: dig: command not found', { exitCode: 127 })?.command).toBe('sudo apt install dnsutils');
    expect(fix('dig example.com', 'bash: dig: command not found', { exitCode: 127, pm: 'dnf' })?.command).toBe('sudo dnf install bind-utils');
    expect(fix('htop', "Command 'htop' not found, but can be installed with:", { exitCode: 127 })?.command).toBe('sudo apt install htop');
    // Ubuntu's own command-not-found names the package: use exactly that.
    const cnf = "Command 'yq' not found, but can be installed with:\nsudo snap install yq  # version 4.44\nsudo apt  install yq  # version 4.30\n";
    expect(fix('yq .', cnf, { exitCode: 127 })?.command).toBe('sudo snap install yq');
    // A random word is not something to install.
    expect(fix('nonexistcmd123', 'bash: nonexistcmd123: command not found', { exitCode: 127 })).toEqual({ title: "'nonexistcmd123' is not a command here." });
    const win = fix('jq .', "jq : The term 'jq' is not recognized as the name of a cmdlet", { windows: true, pm: 'winget', shell: 'powershell' });
    expect(win?.command).toBe('winget install --id jqlang.jq -e');
    expect(fix('foo', "The term 'foo' is not recognized as a name of a cmdlet", { windows: true, pm: 'winget' })?.command).toBeUndefined();
  });

  it('uses git’s own suggestions', () => {
    const out = "git: 'stauts' is not a git command. See 'git --help'.\n\nThe most similar command is\n\tstatus\n";
    expect(fix('git stauts -sb', out)?.command).toBe('git status -sb');
    const upstream = 'fatal: The current branch feature/x has no upstream branch.\nTo push the current branch and set the remote as upstream, use\n\n    git push --set-upstream origin feature/x\n';
    expect(fix('git push', upstream)?.command).toBe('git push --set-upstream origin feature/x');
    expect(fix('git push', ' ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs')?.command).toBe('git pull --rebase');
  });

  it('adds sudo for permission errors, but not twice, and explains on Windows', () => {
    expect(fix('apt install jq', 'E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)')?.command).toBe('sudo apt install jq');
    expect(fix('sudo cat /root/x', 'cat: /root/x: Permission denied')).toBeNull();
    expect(fix('docker ps', 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock')?.command).toBe('sudo usermod -aG docker $USER');
    const win = fix('Remove-Item C:\\Windows\\x', 'Access to the path C:\\Windows\\x is denied.', { windows: true, shell: 'powershell' });
    expect(win?.title).toBe('This needs administrator rights.');
    expect(win?.command).toBeUndefined();
  });

  it('handles language package errors, busy ports, execution policy and DNS', () => {
    expect(fix('python app.py', "ModuleNotFoundError: No module named 'yaml'")?.command).toBe('python3 -m pip install pyyaml');
    expect(fix('node app.js', "Error: Cannot find module 'express'\nRequire stack:")?.command).toBe('npm install express');
    expect(fix('node app.js', "Error: Cannot find module './lib/x'")).toBeNull();
    expect(fix('npm start', 'Error: listen EADDRINUSE: address already in use :::3000')?.command).toBe("sudo ss -ltnp 'sport = :3000'");
    expect(fix('.\\build.ps1', 'File C:\\x\\build.ps1 cannot be loaded because running scripts is disabled on this system.', { windows: true })?.command).toBe(
      'Set-ExecutionPolicy -Scope CurrentUser RemoteSigned',
    );
    expect(fix('curl https://nope.invalid', 'curl: (6) Could not resolve host: nope.invalid')?.title).toContain("couldn't be resolved");
    expect(fix('pip install x', 'error: externally-managed-environment')?.command).toContain('python3 -m venv .venv');
  });

  it('stays quiet for success, Ctrl+C and unknown errors', () => {
    expect(fix('ls', 'whatever', { exitCode: 0 })).toBeNull();
    expect(fix('sleep 10', '^C', { exitCode: 130 })).toBeNull();
    expect(fix('make', 'make: *** [all] Error 2')).toBeNull();
  });
});

describe('helpers', () => {
  it('replaces whole words only', () => {
    expect(replaceWord('kubctl get kubctl-x', 'kubctl', 'kubectl')).toBe('kubectl get kubctl-x');
    expect(replaceWord('sudo dcoker ps', 'dcoker', 'docker')).toBe('sudo docker ps');
  });

  it('detects the package manager from os-release', () => {
    expect(packageManagerFromOsRelease('NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\n')).toBe('apt');
    expect(packageManagerFromOsRelease('NAME="Red Hat Enterprise Linux"\nID="rhel"\nID_LIKE="fedora"\n')).toBe('dnf');
    expect(packageManagerFromOsRelease('ID="rocky"\nID_LIKE="rhel centos fedora"\n')).toBe('dnf');
    expect(packageManagerFromOsRelease('ID=alpine\n')).toBeNull();
    expect(installCommand('nmcli', 'dnf')).toBe('sudo dnf install NetworkManager');
  });

  it('strips terminal escapes and progress-bar rewrites', () => {
    expect(stripAnsi('\x1b[31merror\x1b[0m: x\r\n\x1b]0;title\x07ok')).toBe('error: x\nok');
    expect(stripAnsi('10%\r50%\r100% done\n')).toBe('100% done\n');
  });
});
