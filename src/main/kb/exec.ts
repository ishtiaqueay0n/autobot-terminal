import { existsSync } from 'node:fs';
import { shellEnvironment } from '../profiles';
import type { ResolvedProfile } from '../profiles';
import { toHostPath } from '../../shared/paths';
import type { RemoteContext } from '../../shared/types';
import { spawnCollect, type SpawnResult } from './spawner';

/**
 * Where a command runs: the Windows host, a Linux host, inside a WSL distro, or on another machine over ssh.
 * Nothing is ever run on an 'ssh' environment: only what its shell reports is known about it.
 */
export interface EnvRef {
  /** Stable key for stored knowledge: "windows", "linux", "wsl:Ubuntu", "ssh:alice@prod-db". */
  id: string;
  kind: 'windows' | 'linux' | 'wsl' | 'ssh';
  distro?: string;
}

export function envForRemote(remote: Pick<RemoteContext, 'host'>): EnvRef {
  return { id: `ssh:${remote.host}`, kind: 'ssh' };
}

export function envForProfile(profile: Pick<ResolvedProfile, 'pathStyle' | 'wslDistro'>): EnvRef {
  if (profile.pathStyle === 'wsl') return { id: `wsl:${profile.wslDistro ?? 'Ubuntu'}`, kind: 'wsl', distro: profile.wslDistro ?? 'Ubuntu' };
  return profile.pathStyle === 'windows' ? { id: 'windows', kind: 'windows' } : { id: 'linux', kind: 'linux' };
}

/** Maps a path as the shell in `env` sees it to one this process can read. */
export function hostPath(env: EnvRef, path: string): string {
  return env.kind === 'wsl' ? toHostPath(path, { pathStyle: 'wsl', wslDistro: env.distro }) : path;
}

export type RunResult = SpawnResult;

/** Variables that keep tools quiet and non-interactive while Autobot reads their output. */
const QUIET = {
  LANG: 'C',
  LC_ALL: 'C',
  NO_COLOR: '1',
  TERM: 'dumb',
  PAGER: 'cat',
  MANPAGER: 'cat',
  GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
};

/**
 * Runs a program without a shell (off the main thread, see spawner.ts), output capped, killed after
 * `timeoutMs`. Stdin gets `input` when given and is closed otherwise. In WSL it runs inside the distro through
 * wsl.exe.
 */
export function runIn(
  env: EnvRef,
  file: string,
  args: string[],
  opts: { timeoutMs: number; cwd?: string | null; maxBytes?: number; input?: string },
): Promise<RunResult> {
  if (env.kind === 'ssh') return Promise.resolve({ code: null, stdout: '', stderr: '', timedOut: false });
  const maxBytes = opts.maxBytes ?? 2_000_000;
  let command = file;
  let argv = args;
  let cwd: string | undefined;
  const childEnv = { ...shellEnvironment(), ...QUIET };
  if (env.kind === 'wsl') {
    command = 'wsl.exe';
    argv = ['-d', env.distro ?? 'Ubuntu', ...(opts.cwd ? ['--cd', opts.cwd] : []), '-e', 'env', ...Object.entries(QUIET).map(([k, v]) => `${k}=${v}`), file, ...args];
  } else if (opts.cwd && existsSync(opts.cwd)) {
    cwd = opts.cwd;
  }

  return spawnCollect({ command, args: argv, cwd, env: childEnv, input: opts.input, timeoutMs: opts.timeoutMs, maxBytes });
}
