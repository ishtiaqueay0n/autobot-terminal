import { execFileSync } from 'node:child_process';
import type { ResolvedProfile } from '../../src/main/profiles';
import { toWslPath } from '../../src/shared/paths';

/** Running scripts in the machine behind a bash profile: this one on Linux, a WSL distro on Windows. */

/** The profile's machine can run things (a WSL distro has to be started first). */
export function usable(p: ResolvedProfile | undefined): p is ResolvedProfile {
  if (!p) return false;
  if (p.pathStyle !== 'wsl') return true;
  try {
    execFileSync('wsl.exe', ['-d', p.wslDistro!, '-e', 'true'], { timeout: 60000 });
    return true;
  } catch {
    return false;
  }
}

function invoke(p: ResolvedProfile, program: string, args: string[], input?: string): string {
  const wsl = p.pathStyle === 'wsl';
  return execFileSync(wsl ? 'wsl.exe' : program, wsl ? ['-d', p.wslDistro!, '-e', program, ...args] : args, {
    input,
    encoding: 'utf8',
    timeout: 60000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function hasShell(p: ResolvedProfile, shell: string): boolean {
  try {
    invoke(p, 'sh', ['-c', `command -v ${shell}`]);
    return true;
  } catch {
    return false;
  }
}

/** Runs a script with `shell -s` (reading it from stdin) on the profile's machine. Returns its output. */
export function runScript(p: ResolvedProfile, shell: string, script: string): string {
  return invoke(p, shell, ['-s'], script);
}

/** A path of this machine as the profile's machine sees it. */
export function pathOn(p: ResolvedProfile, path: string): string {
  return p.pathStyle === 'wsl' ? toWslPath(path) : path;
}
