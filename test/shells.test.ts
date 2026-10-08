import { describe, expect, it } from 'vitest';
import { assessDanger } from '../src/shared/danger';
import { isIncomplete } from '../src/shared/incomplete';
import { foldsCase, isPosix } from '../src/shared/shell';
import { CMD_HOOK_SUFFIX, cmdParenDepth, encodeSubmission } from '../src/shared/submit';
import { syntaxIssues } from '../src/shared/syntax';
import { commandSegments, contextAt, findCommand, splitCommands, toolName } from '../src/shared/tokenize';

const words = (text: string, shell: 'cmd' | 'zsh' | 'bash' = 'cmd') => contextAt(text, text.length, shell).words.map((w) => w.value);

describe('shell kinds', () => {
  it('groups the shells', () => {
    expect(['bash', 'zsh'].every((k) => isPosix(k as 'bash'))).toBe(true);
    expect(isPosix('cmd')).toBe(false);
    expect(foldsCase('cmd')).toBe(true);
    expect(foldsCase('powershell')).toBe(true);
    expect(foldsCase('zsh')).toBe(false);
  });
});

describe('cmd.exe tokenizing', () => {
  it('splits commands at & && || | but not at ;', () => {
    expect(splitCommands('dir /b & echo a && echo b || echo c | more', 'cmd')).toEqual(['dir /b', 'echo a', 'echo b', 'echo c', 'more']);
    expect(splitCommands('dir a;b', 'cmd')).toEqual(['dir a;b']);
    expect(commandSegments('(echo a & echo b) & echo c', 'cmd')).toHaveLength(2);
  });

  it('understands double quotes, caret escapes and backslash paths; a single quote is ordinary', () => {
    expect(words('dir /s "C:\\Program Files\\x y"')).toEqual(['dir', '/s', 'C:\\Program Files\\x y']);
    expect(words('echo a^&b')).toEqual(['echo', 'a&b']);
    expect(words("echo 'a b'")).toEqual(['echo', "'a", "b'"]);
    expect(words('cd C:\\Users\\me')).toEqual(['cd', 'C:\\Users\\me']);
    expect(words('echo %PATH%;x')).toEqual(['echo', '%PATH%;x']);
  });

  it('works on the command after &', () => {
    expect(words('dir /b & echo hi there')).toEqual(['echo', 'hi', 'there']);
  });

  it('finds the command behind call, if and for', () => {
    const at = (text: string) => {
      const ctx = contextAt(text, text.length, 'cmd');
      return ctx.words[ctx.commandIndex].value;
    };
    expect(at('call mytool ')).toBe('mytool');
    expect(at('if exist foo.txt del ')).toBe('del');
    expect(at('if not "%a%"=="b" echo ')).toBe('echo');
    expect(at('if errorlevel 1 echo ')).toBe('echo');
    expect(at('for %i in (1 2 3) do echo ')).toBe('echo');
    expect(at('dir ')).toBe('dir');
  });

  it('names tools without path or extension, in lower case', () => {
    expect(toolName('DIR', 'cmd')).toBe('dir');
    expect(toolName('C:\\Windows\\System32\\Ipconfig.EXE', 'cmd')).toBe('ipconfig');
    expect(toolName('Git', 'zsh')).toBe('Git');
  });

  it('findCommand never points past the last word', () => {
    const ctx = contextAt('if exist ', 9, 'cmd');
    expect(findCommand(ctx.words, 'cmd')).toBeLessThan(ctx.words.length);
  });
});

describe('zsh tokenizing is bash-like', () => {
  it('splits on ; && | and honours quotes and backslashes', () => {
    expect(splitCommands("ls -l; echo 'a;b' && cat x | wc", 'zsh')).toEqual(['ls -l', "echo 'a;b'", 'cat x', 'wc']);
    expect(words('echo a\\ b "c d"', 'zsh')).toEqual(['echo', 'a b', 'c d']);
  });
});

describe('cmd.exe syntax', () => {
  const messages = (t: string) => syntaxIssues(t, 'cmd').map((i) => i.message);
  it('flags an operator with nothing before it and a stray )', () => {
    expect(messages('& dir')).toEqual(["Nothing before '&'."]);
    expect(messages('dir && && echo')).toHaveLength(1);
    expect(messages('echo hi)')).toEqual(["Unmatched ')'."]);
  });
  it('accepts normal cmd lines, comments and a ; or single quote in words', () => {
    for (const ok of ['dir /s /b', 'rem foo & bar )', ':: comment (', "echo it's;fine", 'if 1==1 (echo a) else (echo b)', 'dir ^& x']) {
      expect(messages(ok), ok).toEqual([]);
    }
  });
});

describe('cmd.exe danger', () => {
  const level = (c: string) => assessDanger(c, 'cmd')?.level ?? null;
  it('needs confirmation for system-wide destruction', () => {
    for (const c of ['rd /s /q C:\\', 'RMDIR /S C:\\Windows', 'del /s /q C:\\Users', 'format D:', 'shutdown /s /t 0', 'rd /s /q %SystemRoot%', 'vssadmin delete shadows /all']) {
      expect(level(c), c).toBe('confirm');
    }
  });
  it('only warns about wiping the current folder', () => {
    expect(level('del /s /q *.*')).toBe('caution');
    expect(level('rd /s /q .')).toBe('caution');
  });
  it('leaves everyday commands alone', () => {
    for (const c of ['rd /s /q build', 'del temp.txt', 'dir C:\\', 'shutdown /a', 'format', 'echo rd /s C:\\']) expect(level(c), c).toBeNull();
  });
  it('still applies the shared tool rules', () => {
    expect(level('git push --force')).toBe('caution');
  });
  it('rm is not a cmd command', () => {
    expect(level('rm -rf /')).toBeNull();
    expect(assessDanger('rm -rf /', 'zsh')?.level).toBe('confirm');
  });
});

describe('submitting to zsh and cmd.exe', () => {
  it('zsh gets bracketed paste for multi-line text, like bash', () => {
    expect(encodeSubmission('ls', 'zsh')).toBe('ls\r');
    expect(encodeSubmission('a\nb', 'zsh')).toBe('\x1b[200~a\nb\x1b[201~\r');
  });

  it('cmd gets the exit-code hook on its last line', () => {
    expect(CMD_HOOK_SUFFIX).toBe(' &%__AB%');
    expect(encodeSubmission('dir /b', 'cmd')).toBe(`dir /b${CMD_HOOK_SUFFIX}\r`);
  });

  it('cmd joins independent lines with & so there is one command and one prompt', () => {
    expect(encodeSubmission('echo a\necho b\n\n', 'cmd')).toBe(`echo a & echo b${CMD_HOOK_SUFFIX}\r`);
  });

  it('cmd sends blocks as separate lines for its More? continuation', () => {
    expect(encodeSubmission('if 1==1 (\n  echo a\n)', 'cmd')).toBe(`if 1==1 (\r  echo a\r)${CMD_HOOK_SUFFIX}\r`);
    expect(encodeSubmission('echo a ^\nb', 'cmd')).toBe(`echo a ^\rb${CMD_HOOK_SUFFIX}\r`);
  });

  it('cmd drops control characters pasted into the line', () => {
    expect(encodeSubmission('echo \x1b[31mhi', 'cmd')).toBe(`echo [31mhi${CMD_HOOK_SUFFIX}\r`);
  });

  it('counts parentheses outside quotes and escapes', () => {
    expect(cmdParenDepth('if 1==1 (')).toBe(1);
    expect(cmdParenDepth('echo "(" ^( )')).toBe(-1);
    expect(cmdParenDepth('(echo a)')).toBe(0);
  });
});

describe('unfinished lines', () => {
  it('cmd continues only after ^ or inside an open (', () => {
    expect(isIncomplete('if 1==1 (', 'cmd')).toBe(true);
    expect(isIncomplete('echo a ^', 'cmd')).toBe(true);
    expect(isIncomplete('echo "abc', 'cmd')).toBe(false);
    expect(isIncomplete('dir &', 'cmd')).toBe(false);
    expect(isIncomplete('(echo a)', 'cmd')).toBe(false);
  });
  it('zsh behaves like bash', () => {
    expect(isIncomplete("echo 'a", 'zsh')).toBe(true);
    expect(isIncomplete('if true; then', 'zsh')).toBe(true);
    expect(isIncomplete('ls', 'zsh')).toBe(false);
  });
});
