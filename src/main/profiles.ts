import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, release } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { toWslPath } from '../shared/paths';
import type { ShellProfile, SshIntegration } from '../shared/types';

export interface ResolvedProfile extends ShellProfile {
  executable: string;
}

/** How the tab's ssh wrapper behaves (resources/shell/ssh.sh). */
export interface SshLaunch {
  mode: SshIntegration;
  /** Secret of this tab: the wrapper adds it to its answer, so text printed by some program cannot change the setting. */
  token?: string;
  /** The file holding the command that starts a hooked shell on the remote machine (see ssh-bootstrap.ts). */
  commandFile: string;
}

export interface LaunchSpec {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/** Shells found by checking the filesystem only; fast enough to run at startup. */
export function detectLocalProfiles(platform: NodeJS.Platform = process.platform): ResolvedProfile[] {
  if (platform !== 'win32') {
    const found: ResolvedProfile[] = [];
    const bash = findOnPath('bash') ?? '/bin/bash';
    if (existsSync(bash)) found.push({ id: 'bash', name: 'bash', kind: 'bash', pathStyle: 'posix', executable: bash });
    const zsh = findOnPath('zsh');
    if (zsh) found.push({ id: 'zsh', name: 'zsh', kind: 'zsh', pathStyle: 'posix', executable: zsh });
    // New tabs open the user's own login shell first.
    const login = basename(process.env.SHELL ?? '');
    return found.sort((a, b) => Number(b.kind === login) - Number(a.kind === login));
  }

  const profiles: ResolvedProfile[] = [];
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const pwsh =
    findOnPath('pwsh.exe') ??
    [join(programFiles, 'PowerShell', '7', 'pwsh.exe'), join(programFiles, 'PowerShell', '7-preview', 'pwsh.exe')].find(
      (p) => existsSync(p),
    );
  if (pwsh) profiles.push({ id: 'pwsh', name: 'PowerShell 7', kind: 'powershell', pathStyle: 'windows', executable: pwsh });

  const winPs = join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (existsSync(winPs)) {
    profiles.push({ id: 'powershell', name: 'Windows PowerShell', kind: 'powershell', pathStyle: 'windows', executable: winPs });
  }
  // Last, so the default stays PowerShell.
  const cmd = join(systemRoot(), 'System32', 'cmd.exe');
  if (existsSync(cmd)) profiles.push({ id: 'cmd', name: 'Command Prompt', kind: 'cmd', pathStyle: 'windows', executable: cmd });
  return profiles;
}

/**
 * WSL distros (Windows only). Listing them can take seconds while the WSL service starts, so it runs
 * separately and never delays opening a local shell.
 */
export async function detectWslProfiles(
  platform: NodeJS.Platform = process.platform,
  /** Distros known to have zsh (a bash tab there reported it); looking for it would start every distro. */
  zshDistros: ReadonlySet<string> = new Set(),
): Promise<ResolvedProfile[]> {
  if (platform !== 'win32') return [];
  const wsl = join(systemRoot(), 'System32', 'wsl.exe');
  if (!existsSync(wsl)) return [];
  const profiles: ResolvedProfile[] = [];
  for (const distro of await listWslDistros(wsl)) {
    const base = { pathStyle: 'wsl' as const, wslDistro: distro, executable: wsl };
    profiles.push({ id: `wsl:${distro}`, name: `${distro} (WSL)`, kind: 'bash', ...base });
    if (zshDistros.has(distro)) profiles.push({ id: `wsl:${distro}:zsh`, name: `${distro} (WSL, zsh)`, kind: 'zsh', ...base });
  }
  return profiles;
}

export async function detectProfiles(platform: NodeJS.Platform = process.platform): Promise<ResolvedProfile[]> {
  return [...detectLocalProfiles(platform), ...(await detectWslProfiles(platform))];
}

/** Variables that belong to the Electron process itself and must not leak into the user's shells. */
const INTERNAL_ENV = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'ELECTRON_RENDERER_URL', 'CHROME_CRASHPAD_PIPE_NAME'];

export function shellEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined && !INTERNAL_ENV.includes(k.toUpperCase())) env[k] = v;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'AutobotTerminal';
  return env;
}

/** Builds the command line that starts a profile's shell with the Autobot hook loaded. */
export function launchSpec(profile: ResolvedProfile, shellDir: string, ssh?: SshLaunch): LaunchSpec {
  const env = shellEnvironment();
  const cwd = homedir();
  if (ssh && profile.kind !== 'cmd') sshEnvironment(env, profile, ssh);

  if (profile.kind === 'powershell') {
    return { file: profile.executable, args: ['-NoLogo', '-NoExit', '-Command', powershellLoader(shellDir)], cwd, env };
  }

  if (profile.kind === 'cmd') return cmdLaunchSpec(profile, env, cwd);

  if (profile.kind === 'zsh') {
    // zsh reads its startup files from ZDOTDIR: ours load the user's own and then add the hook.
    const zdotdir = join(shellDir, 'zsh');
    if (profile.pathStyle === 'wsl') {
      env.WSLENV = [env.WSLENV, 'TERM_PROGRAM/u', 'COLORTERM/u'].filter(Boolean).join(':');
      return {
        file: profile.executable,
        args: ['-d', profile.wslDistro ?? 'Ubuntu', '--cd', '~', '-e', 'env', `ZDOTDIR=${toWslPath(zdotdir)}`, 'zsh', '-i'],
        cwd,
        env,
      };
    }
    if (process.env.ZDOTDIR) env.AUTOBOT_USER_ZDOTDIR = process.env.ZDOTDIR;
    env.ZDOTDIR = zdotdir;
    return { file: profile.executable, args: ['-i'], cwd, env };
  }

  const rcfile = join(shellDir, 'autobot.bash');
  if (profile.pathStyle === 'wsl') {
    env.WSLENV = [env.WSLENV, 'TERM_PROGRAM/u', 'COLORTERM/u'].filter(Boolean).join(':');
    return {
      file: profile.executable,
      args: ['-d', profile.wslDistro ?? 'Ubuntu', '--cd', '~', '-e', 'bash', '--rcfile', toWslPath(rcfile), '-i'],
      cwd,
      env,
    };
  }
  return { file: profile.executable, args: ['--rcfile', rcfile, '-i'], cwd, env };
}

/**
 * A short -Command that loads the hook as a script block. Unlike running the .ps1 file this is not
 * blocked by execution policy, and unlike -EncodedCommand it keeps the command line short: a command
 * line of a few thousand characters stalls ConPTY's process start for ~5 s.
 */
export function powershellLoader(shellDir: string): string {
  const hook = join(shellDir, 'autobot.ps1').replace(/'/g, "''");
  return `. ([scriptblock]::Create([IO.File]::ReadAllText('${hook}')))`;
}

function systemRoot(): string {
  return process.env.SystemRoot ?? 'C:\\Windows';
}

function findOnPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function listWslDistros(wsl: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(wsl, ['-l', '-q'], { encoding: 'buffer', timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve([]);
      // wsl.exe writes UTF-16LE.
      const names = stdout
        .toString('utf16le')
        .replace(/\0/g, '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith('docker-desktop'));
      resolve(names);
    });
  });
}

/**
 * cmd.exe has no hook mechanism, so everything goes through two environment variables (nothing to quote):
 * PROMPT prints Autobot's markers (ESC \ ends them; PROMPT has no code for BEL), and __AB is what the
 * `%__AB%` at the end of every submitted line expands to (see CMD_HOOK_SUFFIX in submit.ts): `call` expands
 * %errorlevel% only when it runs, after the command, and `prompt` stores it for the next prompt.
 */
function cmdLaunchSpec(profile: ResolvedProfile, env: Record<string, string>, cwd: string): LaunchSpec {
  const ST = '$E\\'; // PROMPT's $E is ESC, so this is ESC followed by a backslash: the string terminator
  const marker = (exit: string) => `$E]7777;A;${exit};$P${ST}`;
  const home = (env.USERPROFILE ?? cwd).split('$').join('$$'); // $$ is a literal $ in PROMPT
  env.__AB = `call prompt ${marker('%errorlevel%')}`;
  // The first prompt also reports the home folder and shell version; later prompts carry only the marker.
  env.PROMPT = `$E]7777;P;Home=${home}${ST}$E]7777;P;Shell=cmd ${release()}${ST}${marker('0')}`;
  return { file: profile.executable, args: ['/d', '/k'], cwd, env };
}

/** The two variables the ssh wrapper in the shell hooks reads (resources/shell/ssh.sh and autobot.ps1). */
function sshEnvironment(env: Record<string, string>, profile: ResolvedProfile, ssh: SshLaunch): void {
  env.AUTOBOT_SSH = ssh.mode;
  env.AUTOBOT_SSH_CMDFILE = ssh.commandFile;
  if (ssh.token) env.AUTOBOT_SSH_TOKEN = ssh.token;
  // Into a WSL distro: the mode as is, the file as the path the distro sees (/p).
  if (profile.pathStyle === 'wsl') env.WSLENV = [env.WSLENV, 'AUTOBOT_SSH/u', 'AUTOBOT_SSH_CMDFILE/p', 'AUTOBOT_SSH_TOKEN/u'].filter(Boolean).join(':');
}
