import { describe, expect, it } from 'vitest';
import { encodeSubmission, stripControlChars } from '../src/shared/submit';

describe('encodeSubmission (bash)', () => {
  it('sends single lines as typed', () => {
    expect(encodeSubmission('ls -la', 'bash')).toBe('ls -la\r');
    expect(encodeSubmission('', 'bash')).toBe('\r');
  });

  it('wraps multi-line text and tabs in a bracketed paste', () => {
    expect(encodeSubmission('for i in 1 2; do\n  echo $i\ndone', 'bash')).toBe(
      '\x1b[200~for i in 1 2; do\n  echo $i\ndone\x1b[201~\r',
    );
    expect(encodeSubmission('printf "a\tb"', 'bash')).toBe('\x1b[200~printf "a\tb"\x1b[201~\r');
  });

  it('normalizes CRLF and strips control characters', () => {
    expect(encodeSubmission('a\r\nb', 'bash')).toBe('\x1b[200~a\nb\x1b[201~\r');
    expect(encodeSubmission('echo \x1b[201~evil\x03', 'bash')).toBe('echo [201~evil\r');
  });
});

describe('encodeSubmission (powershell)', () => {
  it('sends single lines as typed', () => {
    expect(encodeSubmission('Get-ChildItem', 'powershell')).toBe('Get-ChildItem\r');
  });

  it('sends multi-line text line by line with a closing empty line', () => {
    expect(encodeSubmission('if ($true) {\n\n  "x"\n}', 'powershell')).toBe('if ($true) {\r  "x"\r}\r\r');
  });

  it('replaces tabs, which would trigger host completion', () => {
    expect(encodeSubmission('"a\tb"', 'powershell')).toBe('"a    b"\r');
  });
});

describe('stripControlChars', () => {
  it('keeps newline and tab only', () => {
    expect(stripControlChars('a\nb\tc\x00d\x7fe\x1b')).toBe('a\nb\tcde');
  });
});
