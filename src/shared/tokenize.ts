import { foldsCase } from './shell';
import type { ShellKind } from './types';

export interface Word {
  /** Text with quotes and escapes removed. */
  value: string;
  /** Raw offsets in the line, including quotes. */
  start: number;
  end: number;
  /** Quote character the word started with, if any (completion keeps quoting consistent). */
  quote: '' | "'" | '"';
  /** The word follows a redirection operator, so it is a file path: read from (<) or written to (>, >>, 2>). */
  redirect?: 'in' | 'out';
}

export interface CommandContext {
  /** Words of the simple command around the cursor, up to and including the current word. */
  words: Word[];
  /** Index of the word under the cursor (possibly an empty word starting at the cursor). */
  index: number;
  /** Index of the command name, after prefixes such as sudo / env / time. Equal to `index` when the word under
   *  the cursor is in command position. */
  commandIndex: number;
}

const BASH_PREFIXES = new Set(['sudo', 'doas', 'env', 'time', 'nohup', 'nice', 'exec', 'command', 'builtin', 'xargs', 'watch', 'stdbuf', 'timeout']);
const BASH_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', 'time']);
/** sudo options that take a value as the next word. */
const SUDO_VALUE_FLAGS = new Set(['-u', '-g', '-p', '-C', '-D', '-h', '-r', '-t', '-U', '-T']);

/**
 * Splits a command line up to the cursor into the words of the innermost simple command: everything after
 * the last pipe, &&, ;, newline or opening bracket ($(...), (...), and PowerShell { } script blocks).
 * Quotes and escapes are understood, so `ls "My Doc` is one word.
 */
export function contextAt(text: string, cursor: number, shell: ShellKind): CommandContext {
  const src = text.slice(0, cursor);
  const ps = shell === 'powershell';
  const cmd = shell === 'cmd';
  const posix = !ps && !cmd;
  // The character that escapes the next one outside quotes (cmd.exe has no escapes inside quotes).
  const escapeChar = ps ? '`' : cmd ? '^' : '\\';
  // A stack of segments; opening brackets push, closing ones pop.
  const stack: Word[][] = [[]];
  let word: Word | null = null;
  let redirectNext: false | 'in' | 'out' = false;

  const seg = () => stack[stack.length - 1];
  const finish = () => {
    if (!word) return;
    seg().push(word);
    word = null;
  };
  const begin = (i: number, quote: Word['quote'] = '') => {
    if (!word) {
      word = { value: '', start: i, end: i, quote, ...(redirectNext ? { redirect: redirectNext } : {}) };
      redirectNext = false;
    }
    return word;
  };
  const newSegment = () => {
    finish();
    stack[stack.length - 1] = [];
    redirectNext = false;
  };

  let inBacktick = false;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    // Quoted runs extend the current word. (In cmd.exe a single quote is an ordinary character.)
    if (c === "'" && !cmd) {
      const w = begin(i, "'");
      const close = src.indexOf("'", i + 1);
      const endAt = close === -1 ? src.length : close;
      w.value += src.slice(i + 1, endAt);
      i = close === -1 ? src.length : close + 1;
      w.end = i;
      continue;
    }
    if (c === '"') {
      const w = begin(i, '"');
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (!cmd && src[j] === escapeChar && j + 1 < src.length) {
          w.value += src[j + 1];
          j += 2;
        } else {
          w.value += src[j];
          j++;
        }
      }
      i = j < src.length ? j + 1 : j;
      w.end = i;
      continue;
    }
    // Escapes: backslash in bash and zsh, backtick in PowerShell, caret in cmd.exe.
    if (c === escapeChar) {
      if (next === '\n') {
        i += 2;
        continue;
      }
      const w = begin(i);
      if (next !== undefined) w.value += next;
      i += 2;
      w.end = Math.min(i, src.length);
      continue;
    }

    // Brackets that start a nested command.
    if (((posix && c === '$') || (ps && (c === '$' || c === '@'))) && next === '(') {
      finish();
      stack.push([]);
      i += 2;
      continue;
    }
    if (posix && c === '`') {
      // `...` command substitution: the first backtick opens, the next one closes.
      finish();
      if (inBacktick && stack.length > 1) stack.pop();
      else stack.push([]);
      inBacktick = !inBacktick;
      i++;
      continue;
    }
    if (c === '(' || (ps && c === '{')) {
      finish();
      stack.push([]);
      i++;
      continue;
    }
    if (c === ')' || (ps && c === '}')) {
      finish();
      if (stack.length > 1) stack.pop();
      i++;
      continue;
    }

    // Operators that end a simple command.
    // (In cmd.exe ";" is an argument delimiter, not a command separator.)
    if (c === '|' || (c === ';' && !cmd) || c === '\n' || (c === '&' && (next === '&' || !ps))) {
      if (c === '&' && posix && next === '>') {
        // &> redirect
        finish();
        redirectNext = 'out';
        i += src[i + 2] === '>' ? 3 : 2;
        continue;
      }
      newSegment();
      i += (c === '|' && next === '|') || (c === '&' && next === '&') ? 2 : 1;
      continue;
    }
    if (ps && c === '&' && !word) {
      // PowerShell call operator: the next word is the command.
      i++;
      continue;
    }

    // Redirections.
    if (c === '>' || c === '<') {
      finish();
      redirectNext = c === '<' ? 'in' : 'out';
      i += next === '>' || next === '&' ? 2 : 1;
      continue;
    }
    if (/[0-9*]/.test(c) && next === '>' && !word) {
      finish();
      redirectNext = 'out';
      i += src[i + 2] === '>' ? 3 : 2;
      if (src[i] === '&') i++;
      continue;
    }

    if (c === ' ' || c === '\t') {
      finish();
      i++;
      continue;
    }

    const w = begin(i);
    w.value += c;
    i++;
    w.end = i;
  }

  const words = seg();
  const current: Word =
    word ?? { value: '', start: cursor, end: cursor, quote: '', ...(redirectNext ? { redirect: redirectNext } : {}) };
  const all = [...words, current];
  return { words: all, index: all.length - 1, commandIndex: findCommand(all, shell) };
}

/** Index of the command name in a simple command, skipping assignments, keywords and prefix commands. */
export function findCommand(words: Word[], shell: ShellKind): number {
  let i = 0;
  const last = words.length - 1;
  while (i < last) {
    const w = words[i];
    if (w.redirect) {
      i++;
      continue;
    }
    if (shell === 'cmd') {
      const v = w.value.toLowerCase();
      if (v === 'call' || v === 'else' || v === 'do' || v === 'not') {
        i++;
        continue;
      }
      if (v === 'if') {
        // if [/i] [not] (exist X | defined X | errorlevel N | A==B | A EQU B) command
        i++;
        if (words[i]?.value.toLowerCase() === '/i') i++;
        if (words[i]?.value.toLowerCase() === 'not') i++;
        const keyword = words[i]?.value.toLowerCase();
        if (keyword === 'exist' || keyword === 'defined' || keyword === 'errorlevel' || keyword === 'cmdextversion') i += 2;
        else if (words[i]?.value.includes('==')) i++;
        else if (words[i + 1]?.value === '==' || /^(equ|neq|lss|leq|gtr|geq)$/i.test(words[i + 1]?.value ?? '')) i += 3;
        continue;
      }
      if (v === 'for') {
        // for %i in (set) do command
        let j = i + 1;
        while (j < last && words[j].value.toLowerCase() !== 'do') j++;
        if (j >= last) return i;
        i = j + 1;
        continue;
      }
      return i;
    }
    if (shell === 'powershell') {
      // $x = Get-Thing ...
      if (w.value.startsWith('$') && words[i + 1]?.value === '=') {
        i += 2;
        continue;
      }
      if (w.value === '.' || w.value === '&') {
        i++;
        continue;
      }
      return i;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w.value) && w.quote === '') {
      i++;
      continue;
    }
    if (BASH_KEYWORDS.has(w.value)) {
      i++;
      continue;
    }
    if (BASH_PREFIXES.has(w.value)) {
      i++;
      // Skip the prefix's own flags (and sudo's flag values) and env assignments.
      while (i < last && (words[i].value.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i].value))) {
        if (w.value === 'sudo' && SUDO_VALUE_FLAGS.has(words[i].value)) i++;
        i++;
      }
      if (w.value === 'timeout' && i < last && /^\d/.test(words[i].value)) i++;
      continue;
    }
    return i;
  }
  // Command position is the current (last) word, typed or not.
  return Math.min(i, last);
}

/** The command name as a knowledge-base key: no directory, no .exe, lower case for PowerShell. */
export function toolName(word: string, shell: ShellKind): string {
  const base = word.replace(/^.*[\\/]/, '');
  const noExt = /\.(exe|com|cmd|bat)$/i.test(base) ? base.replace(/\.[^.]+$/, '') : base;
  return foldsCase(shell) || /\.(exe|com|cmd|bat)$/i.test(base) ? noExt.toLowerCase() : noExt;
}

/**
 * Splits a full command line into its simple commands at top-level |, ||, &&, ; and newlines (quotes and
 * brackets respected). Used to learn from every command in a pipeline, not just the last one.
 */
export function splitCommands(text: string, shell: ShellKind): string[] {
  return commandSegments(text, shell).map((s) => text.slice(s.start, s.end));
}

/** Like splitCommands, but returns where each command is in the line (trimmed, empty ones dropped). */
export function commandSegments(text: string, shell: ShellKind): { start: number; end: number }[] {
  const ps = shell === 'powershell';
  const cmd = shell === 'cmd';
  const escape = ps ? '`' : cmd ? '^' : '\\';
  const out: { start: number; end: number }[] = [];
  const push = (from: number, to: number) => {
    while (from < to && /\s/.test(text[from])) from++;
    while (to > from && /\s/.test(text[to - 1])) to--;
    if (to > from) out.push({ start: from, end: to });
  };
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "'" && !cmd) {
      const close = text.indexOf("'", i + 1);
      i = close === -1 ? text.length : close + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === escape && !cmd ? 2 : 1;
      i = j + 1;
      continue;
    }
    if (c === escape) {
      i += 2;
      continue;
    }
    if (c === '(' || (ps && c === '{')) depth++;
    else if ((c === ')' || (ps && c === '}')) && depth > 0) depth--;
    else if (depth === 0 && (c === '|' || (c === ';' && !cmd) || c === '\n' || (c === '&' && (next === '&' || !ps)))) {
      if (!(c === '&' && next === '>')) {
        push(start, i);
        i += (c === '|' && next === '|') || (c === '&' && next === '&') ? 2 : 1;
        start = i;
        continue;
      }
    }
    i++;
  }
  push(start, text.length);
  return out;
}
