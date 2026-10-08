import type { ShellProfile } from './types';

const WINDOWS_PATH = /^[A-Za-z]:[\\/]/;

/** Converts a Windows path to the path WSL sees through its default /mnt automount. */
export function toWslPath(windowsPath: string): string {
  const m = /^([A-Za-z]):[\\/]?(.*)$/.exec(windowsPath);
  if (!m) return windowsPath.replace(/\\/g, '/');
  const rest = m[2].replace(/\\/g, '/');
  return `/mnt/${m[1].toLowerCase()}${rest ? `/${rest}` : ''}`;
}

/** Maps a cwd reported by the shell to a path the main process can read (for git branch lookup). */
export function toHostPath(cwd: string, profile: Pick<ShellProfile, 'pathStyle' | 'wslDistro'>): string {
  if (profile.pathStyle !== 'wsl') return cwd;
  const mnt = /^\/mnt\/([a-z])(?:\/(.*))?$/.exec(cwd);
  if (mnt) return `${mnt[1].toUpperCase()}:\\${(mnt[2] ?? '').replace(/\//g, '\\')}`;
  return `\\\\wsl.localhost\\${profile.wslDistro ?? 'Ubuntu'}${cwd.replace(/\//g, '\\')}`;
}

/** Replaces the home directory prefix with "~". Windows paths compare case-insensitively. */
export function shortenHome(cwd: string, home: string | null | undefined): string {
  if (!home) return cwd;
  const windows = WINDOWS_PATH.test(cwd);
  const norm = (p: string) => (windows ? p.toLowerCase().replace(/\//g, '\\') : p);
  const h = norm(home).replace(/[\\/]+$/, '');
  const c = norm(cwd);
  if (c === h) return '~';
  const sep = windows ? '\\' : '/';
  if (c.startsWith(h + sep)) return `~${sep}${cwd.slice(h.length + 1)}`;
  return cwd;
}

/** Last path segment, for tab titles. */
export function baseName(path: string): string {
  if (path === '~' || path === '/') return path;
  const trimmed = path.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx === -1 ? trimmed : trimmed.slice(idx + 1) || trimmed;
}
