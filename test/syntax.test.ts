import { describe, expect, it } from 'vitest';
import { syntaxIssues } from '../src/shared/syntax';

const bash = (s: string) => syntaxIssues(s, 'bash').map((i) => i.message);
const ps = (s: string) => syntaxIssues(s, 'powershell').map((i) => i.message);

describe('syntaxIssues (bash)', () => {
  it.each([
    'ls -la',
    'ls | grep x && echo ok || echo no; date',
    'if true; then echo y; else echo n; fi',
    'for i in 1 2; do echo $i; done',
    'while read l; do echo "$l"; done < f',
    'case $x in a) echo a;; b|c) echo bc;; esac',
    'echo $(date) "a | b" \'fi\'',
    '[ -f x ] && echo "found"',
    'arr=(1 2 3); echo ${arr[0]}',
    'ls |', // unfinished, not wrong
    'echo "unclosed',
    'echo fi done',
    'f() { echo hi; }',
    '# just a comment with |',
  ])('no issues: %j', (line) => {
    expect(bash(line)).toEqual([]);
  });

  it.each([
    ['| grep x', "Nothing before '|'."],
    ['ls | | wc', "Nothing before '|'."],
    ['&& make', "Nothing before '&&'."],
    ['ls ;; date', undefined],
    ['echo hi)', "Unmatched ')'."],
    ['echo x; fi', "'fi' without a matching 'if'."],
    ['done', "'done' without a matching 'for/while'."],
    ['if true; then echo; esac', "'esac' without a matching 'case'."],
  ])('flags %j', (line, message) => {
    if (message) expect(bash(line)).toContain(message);
    else expect(bash(line)).toEqual([]);
  });

  it('points at the offending text', () => {
    expect(syntaxIssues('ls | | wc', 'bash')).toEqual([{ from: 5, to: 6, message: "Nothing before '|'." }]);
  });
});

describe('syntaxIssues (powershell)', () => {
  it('accepts normal pipelines, blocks and indexing', () => {
    expect(ps('Get-Process | Where-Object { $_.CPU -gt 1 } | Select-Object -First 3')).toEqual([]);
    expect(ps('$a = @(1, 2); $a[0]; [Math]::Max(1, 2)')).toEqual([]);
    expect(ps('if ($x) { "y" }')).toEqual([]);
  });

  it('flags empty pipe elements and unmatched brackets', () => {
    expect(ps('| Select-Object Name')).toEqual(["Nothing before '|'."]);
    expect(ps('Get-Item x }')).toEqual(["Unmatched '}'."]);
    expect(ps('Get-Date)')).toEqual(["Unmatched ')'."]);
  });
});
