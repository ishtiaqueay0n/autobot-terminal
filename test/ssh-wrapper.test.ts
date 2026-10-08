import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { detectProfiles } from '../src/main/profiles';
import { loadRemoteHooks } from '../src/main/ssh-bootstrap';
import { hasShell, pathOn, runScript, usable } from './helpers/shells';

/**
 * The shell side of the ssh wrapper, run in real shells: which ssh command lines count as a plain interactive
 * login (everything else must reach the real ssh untouched), and that every hook that travels to the remote
 * machine is valid for the shell that will read it. Needs a bash machine (this one, or a WSL distro).
 */

const shellDir = join(__dirname, '..', 'resources', 'shell');
const profiles = await detectProfiles();
// AUTOBOT_TEST_DISTRO picks the WSL distro to run in (to test zsh in a distro that has it).
const distro = process.env.AUTOBOT_TEST_DISTRO;
const machine = profiles.find((p) => p.kind === 'bash' && (!distro || p.wslDistro === distro) && usable(p));
const tmp = mkdtempSync(join(tmpdir(), 'autobot-wrapper-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** [expected: is a plain login, the ssh arguments]. */
const CASES: [boolean, string][] = [
  [true, 'host'],
  [true, 'user@host'],
  [true, '-p 2222 host'],
  [true, '-p2222 host'],
  [true, '-oPort=22 host'],
  [true, '-vvv -tt host'],
  [true, '-4A -i key.pem -o StrictHostKeyChecking=no user@host'],
  [true, '-L 8080:localhost:80 host'],
  [true, '-J jump -l bob host'],
  [true, '-- host'],
  [false, 'host ls'],
  [false, "host 'ls -la'"],
  [false, '-p 22 host uptime'],
  [false, '-q -p 22 -- host cmd'],
  [false, '-N host'],
  [false, '-fNL 1:2:3 host'],
  [false, '-T host'],
  [false, '-O check host'],
  [false, '-W h:22 host'],
  [false, '-G host'],
  [false, '-V'],
  [false, '-s host sftp'],
  [false, ''],
  [false, '-p'],
];

describe.runIf(machine)('the ssh wrapper\'s idea of a plain login', () => {
  for (const shell of ['bash', 'zsh', 'sh']) {
    it.runIf(machine && hasShell(machine, shell))(`is the same in ${shell}`, () => {
      const wrapper = pathOn(machine!, join(shellDir, 'ssh.sh'));
      const script = [
        `. '${wrapper}'`,
        ...CASES.map(([, args], i) => `__autobot_ssh_login ${args} && echo "${i} yes" || echo "${i} no"`),
      ].join('\n');
      const got = runScript(machine!, shell, script)
        .trim()
        .split(/\r?\n/)
        .map((l) => l.split(' ')[1] === 'yes');
      expect(got).toEqual(CASES.map(([expected]) => expected));
    });
  }
});

describe.runIf(machine)('the hooks that travel to the remote machine', () => {
  const hooks = loadRemoteHooks(shellDir);

  it('are valid bash and zsh', () => {
    const bashFile = join(tmp, 'remote-bash.sh');
    const zshenv = join(tmp, 'remote-zshenv');
    const zshrc = join(tmp, 'remote-zshrc');
    writeFileSync(bashFile, hooks.bash);
    writeFileSync(zshenv, hooks.zshenv);
    writeFileSync(zshrc, hooks.zshrc);
    // `-n` reads the file without running anything.
    runScript(machine!, 'bash', `bash -n '${pathOn(machine!, bashFile)}'`);
    if (hasShell(machine!, 'zsh')) {
      runScript(machine!, 'zsh', `zsh -n '${pathOn(machine!, zshenv)}' && zsh -n '${pathOn(machine!, zshrc)}'`);
    }
    // And the wrapper itself, in every shell that sources it.
    runScript(machine!, 'bash', `bash -n '${pathOn(machine!, join(shellDir, 'ssh.sh'))}'`);
  });
});
