import type { ShellKind } from './types';

export interface SyntaxIssue {
  from: number;
  to: number;
  message: string;
}

type Block = 'if' | 'case' | 'loop';

/** bash keywords that close or continue a block, and the block they need. */
const NEEDS: Record<string, Block> = { fi: 'if', then: 'if', else: 'if', elif: 'if', esac: 'case', done: 'loop', do: 'loop' };
const CLOSES = new Set(['fi', 'esac', 'done']);
const OPENS: Record<string, Block> = { if: 'if', case: 'case', for: 'loop', while: 'loop', until: 'loop', select: 'loop' };
/** After these keywords the next word is a command again. */
const KEEPS_COMMAND = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', 'time']);

/**
 * Mistakes that are certainly wrong, not just unfinished (an open quote or a trailing pipe only means the
 * line continues, which Enter handles): an operator with nothing before it, a stray closing bracket, a
 * fi/done/esac with nothing to close. Quotes, escapes and comments are respected.
 */
export function syntaxIssues(text: string, shell: ShellKind): SyntaxIssue[] {
  const ps = shell === 'powershell';
  const cmd = shell === 'cmd';
  const posix = !ps && !cmd;
  const escape = ps ? '`' : cmd ? '^' : '\\';
  const issues: SyntaxIssue[] = [];
  const brackets: string[] = [];
  const blocks: Block[] = [];
  let empty = true; // nothing typed since the last operator
  let atCommand = true; // the next word is in command position
  let i = 0;

  const operator = (at: number, op: string) => {
    if (empty) issues.push({ from: at, to: at + op.length, message: `Nothing before '${op}'.` });
    empty = true;
    atCommand = true;
  };

  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if ((c === "'" && !cmd) || c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += c === '"' && text[j] === escape && !cmd ? 2 : 1;
      i = j + 1;
      empty = false;
      atCommand = false;
      continue;
    }
    if (c === escape) {
      i += 2;
      empty = false;
      continue;
    }
    if (c === '#' && !cmd && (i === 0 || /\s/.test(text[i - 1]))) {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '\n') {
      // A newline ends the command (or, after an operator, just continues the line): either way the next
      // word starts a command.
      empty = true;
      atCommand = true;
      i++;
      continue;
    }
    if ((c === '|' || c === '&') && next === c) {
      operator(i, c + c);
      i += 2;
      continue;
    }
    if (c === '|' || (cmd && c === '&')) {
      operator(i, c);
      i++;
      continue;
    }
    if (c === ';' && !cmd) {
      if (posix && next === ';') {
        // ";;" ends a case branch.
        i += 2;
        empty = true;
        atCommand = true;
        continue;
      }
      operator(i, ';');
      i++;
      continue;
    }
    if (c === '(' || (ps && (c === '[' || c === '{'))) {
      brackets.push(c);
      empty = true;
      atCommand = true;
      i++;
      continue;
    }
    if (c === ')' || (ps && (c === ']' || c === '}'))) {
      const want = c === ')' ? '(' : c === ']' ? '[' : '{';
      if (brackets[brackets.length - 1] === want) brackets.pop();
      // In a bash case statement, "pattern)" has no opening bracket.
      else if (!(c === ')' && !ps && blocks[blocks.length - 1] === 'case')) issues.push({ from: i, to: i + 1, message: `Unmatched '${c}'.` });
      i++;
      empty = false;
      atCommand = c === ')' && !ps && blocks[blocks.length - 1] === 'case';
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }

    let j = i;
    while (j < text.length && !(cmd ? /[\s|&()<>"]/ : /[\s|&;()<>'"]/).test(text[j]) && !(ps && /[{}[\]]/.test(text[j]))) j++;
    if (j === i) j = i + 1;
    const word = text.slice(i, j);
    if (cmd && atCommand && (word.toLowerCase() === 'rem' || word.startsWith('::'))) {
      // A comment: the rest of the line is ignored.
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (posix && atCommand) {
      if (OPENS[word]) blocks.push(OPENS[word]);
      else if (NEEDS[word]) {
        const need = NEEDS[word];
        if (blocks[blocks.length - 1] !== need) {
          const opener = need === 'loop' ? 'for/while' : need;
          issues.push({ from: i, to: j, message: `'${word}' without a matching '${opener}'.` });
        } else if (CLOSES.has(word)) {
          blocks.pop();
        }
      }
    }
    empty = false;
    atCommand = posix && KEEPS_COMMAND.has(word) && atCommand;
    i = j;
  }
  return issues;
}
