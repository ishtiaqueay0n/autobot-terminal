import { isPosix } from './shell';
import type { ShellKind } from './types';

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

/**
 * cmd.exe has no hook that runs after a command, and nothing in its prompt can read the exit code. So every
 * submitted line ends with this: `&` runs after the command (whatever it was), and `%__AB%` expands to the
 * AUTOBOT_CMD_HOOK environment variable `call prompt <marker with %errorlevel%>`. `call` expands %errorlevel%
 * only when it runs, after the command, and `prompt` stores it in the prompt that cmd shows next. The echo
 * of this text is blanked out of the output (see CmdEchoFilter).
 */
export const CMD_HOOK_SUFFIX = ' &%__AB%';

/**
 * Turns the text in the input editor into the bytes written to the shell's PTY.
 *
 * bash and zsh: the line editor is still reading the line, so multi-line text (or text with tabs, which would
 * trigger completion) goes in as one bracketed paste and is accepted as a single history entry.
 *
 * PowerShell: PSReadLine is unloaded, so the console host reads plain lines. Lines are sent one by
 * one; the host's ">>" continuation handles open blocks and a final empty line closes them. Blank
 * lines inside the text are dropped because an empty line would end the block early.
 *
 * cmd.exe: see encodeCmd.
 */
export function encodeSubmission(text: string, kind: ShellKind): string {
  const clean = stripControlChars(text.replace(/\r\n?/g, '\n'));

  if (isPosix(kind)) {
    if (/[\n\t]/.test(clean)) return `${BRACKETED_PASTE_START}${clean}${BRACKETED_PASTE_END}\r`;
    return `${clean}\r`;
  }
  if (kind === 'cmd') return encodeCmd(clean);

  const lines = clean.replace(/\t/g, '    ').split('\n');
  if (lines.length === 1) return `${lines[0]}\r`;
  const kept = lines.filter((line) => line.trim() !== '');
  return `${kept.join('\r')}\r\r`;
}

/**
 * cmd.exe runs each line as its own command and shows a prompt after each, which would look like several
 * finished commands. Lines that are complete on their own are therefore joined with `&` into one line. Lines
 * that open or continue a block (a trailing `(` or `^`, an unbalanced parenthesis) are sent as separate lines
 * and cmd's "More?" continuation joins them. The hook suffix goes on the last line.
 */
function encodeCmd(clean: string): string {
  const lines = clean
    .replace(/\t/g, ' ')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '');
  if (lines.length === 0) return '\r';
  const independent = lines.every((l) => !l.endsWith('^') && cmdParenDepth(l) === 0);
  const body = independent ? lines.join(' & ') : lines.join('\r');
  return `${body}${CMD_HOOK_SUFFIX}\r`;
}

/** Net number of unclosed `(` in cmd text, ignoring quoted text and `^`-escaped characters. */
export function cmdParenDepth(text: string): number {
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (c === '^') i++;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
  }
  return depth;
}

/** Removes C0 control characters (except newline and tab) and DEL, so pasted escapes cannot reach the shell. */
export function stripControlChars(text: string): string {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}
