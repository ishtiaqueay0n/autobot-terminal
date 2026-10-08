import type { HistoryKey, RemoteContext, ShellKind } from './types';

/** bash and zsh: POSIX-style quoting, `$VAR`, `;`, `&&`, command substitution. */
export function isPosix(kind: ShellKind): kind is 'bash' | 'zsh' {
  return kind === 'bash' || kind === 'zsh';
}

/** Windows shells match command names, options and file names without regard to case. */
export function foldsCase(kind: ShellKind | string): boolean {
  return kind === 'powershell' || kind === 'cmd';
}

/** The key history is filed under: the shell, or the shell on the machine an ssh session is connected to. */
export function historyKey(shell: ShellKind, remote?: RemoteContext | null): HistoryKey {
  return remote ? `${remote.shell}@${remote.host}` : shell;
}

/** The shell a history key stands for ("bash@alice@prod-db" is bash). */
export function baseShell(key: HistoryKey): ShellKind {
  return key.split('@')[0] as ShellKind;
}

/** Name for people (settings, prompts to the AI). */
export const SHELL_NAMES: Record<ShellKind, string> = {
  bash: 'bash',
  zsh: 'zsh',
  powershell: 'PowerShell',
  cmd: 'cmd.exe (Command Prompt)',
};
