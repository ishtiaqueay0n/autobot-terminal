import { isPosix } from './shell';
import { cmdParenDepth } from './submit';
import type { ShellKind } from './types';

/**
 * True when the command text is unfinished, so Enter should insert a newline instead of running it:
 * open quotes, open brackets/subshells, open heredocs or here-strings, open compound commands
 * (if/case/loops), trailing pipes or && / ||, or a trailing line continuation.
 *
 * This is a lightweight scanner, not a full parser. It errs toward "complete" on constructs it does not
 * understand, so Enter never gets stuck. The milestone 4 syntax checker builds on the same rules.
 */
export function isIncomplete(text: string, kind: ShellKind): boolean {
  if (isPosix(kind)) return bashIncomplete(text);
  if (kind === 'cmd') return cmdIncomplete(text);
  return powershellIncomplete(text);
}

/** cmd.exe continues a line only after a trailing ^ or inside an open ( block; an open quote or a trailing & do not. */
function cmdIncomplete(text: string): boolean {
  return text.trimEnd().endsWith('^') || cmdParenDepth(text) > 0;
}

// ---------------------------------------------------------------------------------------------- bash

type BashCtx = 'sq' | 'dq' | 'ansi' | 'bt' | 'param' | 'paren' | 'cmdsub';

const BASH_OPENERS = new Set(['if', 'case', 'do', '{']);
const BASH_CLOSERS = new Set(['fi', 'esac', 'done', '}']);
/** Keywords after which the next word is again in command position. */
const BASH_COMMAND_PREFIX = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '{', '!', 'time']);

function bashIncomplete(src: string): boolean {
  const stack: BashCtx[] = [];
  const heredocs: { delim: string; stripTabs: boolean }[] = [];
  let blocks = 0;
  let word = '';
  let wordQuoted = false;
  let commandPos = true;
  let trailingOperator = false;

  const isCode = () => {
    const top = stack[stack.length - 1];
    return top === undefined || top === 'paren' || top === 'cmdsub';
  };

  const endWord = () => {
    if (!word && !wordQuoted) return;
    trailingOperator = false;
    if (commandPos && !wordQuoted) {
      if (BASH_OPENERS.has(word)) blocks++;
      else if (BASH_CLOSERS.has(word)) blocks = Math.max(0, blocks - 1);
    }
    if (wordQuoted) commandPos = false;
    else if (BASH_COMMAND_PREFIX.has(word)) commandPos = true;
    else if (commandPos && /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(word)) commandPos = true; // VAR=x cmd
    else commandPos = false;
    word = '';
    wordQuoted = false;
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    const top = stack[stack.length - 1];

    if (top === 'sq') {
      if (c === "'") stack.pop();
      i++;
      continue;
    }
    if (top === 'ansi' || top === 'bt') {
      if (c === '\\') i += 2;
      else {
        if ((top === 'ansi' && c === "'") || (top === 'bt' && c === '`')) stack.pop();
        i++;
      }
      continue;
    }
    if (top === 'dq' || top === 'param') {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (top === 'dq' && c === '"') stack.pop();
      else if (top === 'param' && c === '}') stack.pop();
      else if (top === 'param' && c === "'") stack.push('sq');
      else if (top === 'param' && c === '"') stack.push('dq');
      else if (c === '`') stack.push('bt');
      else if (c === '$' && next === '(') {
        stack.push('cmdsub');
        i++;
      } else if (c === '$' && next === '{') {
        stack.push('param');
        i++;
      }
      i++;
      continue;
    }

    // Code context: top level, ( subshell ), or $( command substitution ).
    if (c === '\\') {
      if (i + 1 >= src.length) return true; // trailing line continuation
      if (next === '\n') {
        i += 2;
        continue;
      }
      word += src.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === '#' && !word && !wordQuoted) {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      stack.push(c === "'" ? 'sq' : c === '"' ? 'dq' : 'bt');
      wordQuoted = true;
      i++;
      continue;
    }
    if (c === '$' && next === "'") {
      stack.push('ansi');
      wordQuoted = true;
      i += 2;
      continue;
    }
    if (c === '$' && next === '(') {
      stack.push('cmdsub');
      wordQuoted = true;
      i += 2;
      continue;
    }
    if (c === '$' && next === '{') {
      stack.push('param');
      wordQuoted = true;
      i += 2;
      continue;
    }
    if (c === '(') {
      endWord();
      stack.push('paren');
      commandPos = true;
      i++;
      continue;
    }
    if (c === ')') {
      endWord();
      if (top === 'paren' || top === 'cmdsub') stack.pop();
      // A bare ')' is a case pattern terminator; the next word is a command.
      commandPos = top !== 'cmdsub';
      if (top === 'cmdsub') wordQuoted = true;
      i++;
      continue;
    }
    if (c === '<' && next === '<') {
      endWord();
      if (src[i + 2] === '<') {
        i += 3; // here-string, complete on its own line
        continue;
      }
      let j = i + 2;
      const stripTabs = src[j] === '-';
      if (stripTabs) j++;
      while (src[j] === ' ' || src[j] === '\t') j++;
      let delim = '';
      while (j < src.length && !/[\s;&|<>()]/.test(src[j])) {
        if (src[j] !== "'" && src[j] !== '"' && src[j] !== '\\') delim += src[j];
        j++;
      }
      if (delim) heredocs.push({ delim, stripTabs });
      i = j;
      continue;
    }
    if (c === '\n') {
      endWord();
      if (!trailingOperator) commandPos = true;
      i++;
      while (heredocs.length > 0) {
        const { delim, stripTabs } = heredocs.shift()!;
        let found = false;
        while (i < src.length) {
          const eol = src.indexOf('\n', i);
          const lineEnd = eol === -1 ? src.length : eol;
          let line = src.slice(i, lineEnd);
          if (stripTabs) line = line.replace(/^\t+/, '');
          i = eol === -1 ? src.length : eol + 1;
          if (line === delim) {
            found = true;
            break;
          }
        }
        if (!found) return true;
      }
      continue;
    }
    if (c === ' ' || c === '\t') {
      endWord();
      i++;
      continue;
    }
    if (c === ';' || c === '&' || c === '|') {
      endWord();
      if (c === '|' || (c === '&' && next === '&')) {
        trailingOperator = true;
        i += next === c ? 2 : 1;
      } else {
        trailingOperator = false;
        i += next === c ? 2 : 1;
      }
      commandPos = true;
      continue;
    }
    if (isCode()) word += c;
    i++;
  }
  endWord();

  return stack.length > 0 || heredocs.length > 0 || blocks > 0 || trailingOperator;
}

// ---------------------------------------------------------------------------------------- PowerShell

type PsCtx = 'sq' | 'dq' | 'hsq' | 'hdq' | 'comment' | '(' | '[' | '{' | 'subexpr';

function powershellIncomplete(src: string): boolean {
  const stack: PsCtx[] = [];
  let trailingOperator = false;
  let atWordStart = true;
  let i = 0;

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    const top = stack[stack.length - 1];

    if (top === 'comment') {
      if (c === '#' && next === '>') {
        stack.pop();
        i += 2;
      } else i++;
      continue;
    }
    if (top === 'sq') {
      if (c === "'") {
        if (next === "'") i += 2;
        else {
          stack.pop();
          i++;
        }
      } else i++;
      continue;
    }
    if (top === 'dq') {
      if (c === '`') i += 2;
      else if (c === '"') {
        if (next === '"') i += 2;
        else {
          stack.pop();
          i++;
        }
      } else if (c === '$' && next === '(') {
        stack.push('subexpr');
        i += 2;
      } else i++;
      continue;
    }
    if (top === 'hsq' || top === 'hdq') {
      const close = top === 'hsq' ? "'@" : '"@';
      const lineStart = i === 0 || src[i - 1] === '\n';
      if (lineStart && src.startsWith(close, i)) {
        stack.pop();
        i += 2;
      } else i++;
      continue;
    }

    // Code context.
    if (c === '`') {
      if (i + 1 >= src.length || next === '\n') {
        if (i + 1 >= src.length) return true; // trailing line continuation
        i += 2;
        continue;
      }
      i += 2;
      atWordStart = false;
      continue;
    }
    if (c === '<' && next === '#') {
      stack.push('comment');
      i += 2;
      continue;
    }
    if (c === '#' && atWordStart) {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '@' && (next === "'" || next === '"')) {
      const rest = src.slice(i + 2);
      const m = /^[ \t]*(\n|$)/.exec(rest);
      if (m) {
        if (m[1] === '') return true; // here-string opened on the last line
        stack.push(next === "'" ? 'hsq' : 'hdq');
        i += 2 + m[0].length;
        trailingOperator = false;
        continue;
      }
    }
    if (c === "'" || c === '"') {
      stack.push(c === "'" ? 'sq' : 'dq');
      trailingOperator = false;
      atWordStart = false;
      i++;
      continue;
    }
    if (c === '$' && next === '(') {
      stack.push('subexpr');
      trailingOperator = false;
      i += 2;
      atWordStart = true;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      stack.push(c);
      trailingOperator = false;
      atWordStart = true;
      i++;
      continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      const want = c === ')' ? ['(', 'subexpr'] : c === ']' ? ['['] : ['{'];
      if (top && want.includes(top)) stack.pop();
      trailingOperator = false;
      atWordStart = false;
      i++;
      continue;
    }
    if (c === '|' || (c === '&' && next === '&')) {
      trailingOperator = true;
      i += next === c ? 2 : 1;
      atWordStart = true;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === ';') {
      if (c === ';') trailingOperator = false;
      atWordStart = true;
      i++;
      continue;
    }
    trailingOperator = false;
    atWordStart = false;
    i++;
  }

  return stack.length > 0 || trailingOperator;
}
