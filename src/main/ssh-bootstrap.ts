import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

export interface RemoteHooks {
  /** The hook bash loads with --rcfile. */
  bash: string;
  /** The two files zsh reads from its ZDOTDIR. */
  zshenv: string;
  zshrc: string;
}

/** Drops comments, blank lines and indentation: the hooks travel inside a command line, so size matters. */
export function minifyHook(script: string): string {
  return script
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimStart())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .join('\n')
    .concat('\n');
}

export function loadRemoteHooks(shellDir: string): RemoteHooks {
  const read = (...parts: string[]) => minifyHook(readFileSync(join(shellDir, ...parts), 'utf8'));
  const common = read('remote', 'common.sh');
  return {
    bash: common + read('remote', 'bash.sh'),
    zshenv: read('zsh', '.zshenv'),
    zshrc: common + read('remote', 'zshrc'),
  };
}

/** Gzipped, then base64: the command has to stay short (see MAX_COMMAND_LENGTH). */
const pack = (text: string): string => gzipSync(Buffer.from(text, 'utf8'), { level: 9 }).toString('base64');

/**
 * OpenSSH before 8.4 (RHEL 8 ships 8.0) fails with "percent_expand: string too long" when RemoteCommand is 4096
 * characters or longer, and does not even connect. Staying below this leaves room for the hooks to grow.
 */
export const MAX_COMMAND_LENGTH = 3800;

/**
 * The command ssh runs on the remote machine in place of the plain login shell (ssh's RemoteCommand option). It
 * writes the hook for the user's own shell to a private temporary folder and starts that shell with it; the hook
 * deletes the folder as soon as it is loaded. Anything unexpected (no bash or zsh, no base64, no writable folder)
 * ends in an ordinary login shell, so the worst case is a session without suggestions.
 *
 * It must survive three layers of quoting, so it is one line without quotes of any kind besides the single
 * quotes around the script, and without `%` (ssh expands those in RemoteCommand) or `!` (csh history). It stays
 * under MAX_COMMAND_LENGTH characters, which is why the hooks are gzipped.
 */
export function buildRemoteCommand(hooks: RemoteHooks): string {
  // `case $d in /*)` is the quote-free way to say "mktemp gave us a folder".
  const script = [
    'd=$(mktemp -d 2>/dev/null)',
    'case $d in /*) if [ -x $SHELL ]; then ' +
      'case ${SHELL##*/} in ' +
      `bash) echo ${pack(hooks.bash)} | base64 -d | gzip -dc > $d/h && AUTOBOT_DIR=$d exec $SHELL --rcfile $d/h -i;; ` +
      `zsh) echo ${pack(hooks.zshenv)} | base64 -d | gzip -dc > $d/.zshenv && echo ${pack(hooks.zshrc)} | base64 -d | gzip -dc > $d/.zshrc && AUTOBOT_DIR=$d ZDOTDIR=$d exec $SHELL -i;; ` +
      'esac; fi; rm -rf $d;; esac',
    'exec ${SHELL:-sh} -l',
  ].join('; ');
  return `sh -c '${script}'`;
}

/** Writes the command where the ssh wrapper in the user's shell finds it (AUTOBOT_SSH_CMDFILE). */
export function writeRemoteCommandFile(shellDir: string, file: string): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, buildRemoteCommand(loadRemoteHooks(shellDir)) + '\n', 'utf8');
  return file;
}
