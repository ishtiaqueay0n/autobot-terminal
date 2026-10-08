import { describe, expect, it } from 'vitest';
import { isIncomplete } from '../src/shared/incomplete';

const bash = (s: string) => isIncomplete(s, 'bash');
const ps = (s: string) => isIncomplete(s, 'powershell');

describe('isIncomplete (bash)', () => {
  it.each([
    'ls -la',
    'echo "hello world"',
    "echo 'it''s'",
    'echo $(date)',
    'git commit -m "msg" && git push',
    'sleep 10 &',
    'echo a; echo b;',
    'for i in 1 2; do echo $i; done',
    'if true; then echo y; else echo n; fi',
    'case $x in a) echo a;; *) echo other;; esac',
    'f() { echo hi; }',
    'echo {a,b}',
    'echo }',
    'echo if fi done',
    'echo $((1 + 2))',
    'cat <<EOF\nhello\nEOF',
    'cat <<-EOF\n\thello\n\tEOF',
    "cat <<'EOF'\n$HOME\nEOF",
    'grep x <<< "text"',
    'echo a # trailing comment with "quote',
    'echo \\"',
    'echo $#',
    'arr=(1 2 3)',
    '[[ -f x ]] || echo missing',
    "echo $'a\\'b'",
  ])('complete: %j', (cmd) => {
    expect(bash(cmd)).toBe(false);
  });

  it.each([
    'echo "unclosed',
    "echo 'unclosed",
    'echo `date',
    'echo $(date',
    'ls |',
    'ls | ',
    'make &&',
    'test -f x ||',
    'echo a \\',
    'for i in 1 2; do',
    'for i in 1 2; do\n  echo $i',
    'if true; then',
    'case $x in',
    'f() {',
    '(cd /tmp',
    'cat <<EOF',
    'cat <<EOF\nline',
    'echo ${HOME',
    'while true\ndo\n  sleep 1',
  ])('incomplete: %j', (cmd) => {
    expect(bash(cmd)).toBe(true);
  });
});

describe('isIncomplete (powershell)', () => {
  it.each([
    'Get-ChildItem',
    'Get-Process | Where-Object { $_.CPU -gt 10 }',
    "'it''s'",
    '"say ""hi"""',
    '"value: $($x + 1)"',
    '"tick `" inside"',
    "@'\nraw text\n'@",
    '@"\nhello $name\n"@',
    '<# block #> Get-Date',
    'Get-Date # comment with {',
    '$h = @{ a = 1; b = 2 }',
    '$a = @(1, 2, 3)',
    'if ($true) { "x" } else { "y" }',
    'git log --format="%H"',
  ])('complete: %j', (cmd) => {
    expect(ps(cmd)).toBe(false);
  });

  it.each([
    '"unclosed',
    "'unclosed",
    'Get-Process |',
    'if ($true) {',
    'foreach ($i in 1..3) {\n  $i',
    '$a = @(1, 2,',
    '"value: $($x + 1"',
    "@'\nraw text",
    '@"',
    '<# open comment',
    'Get-ChildItem `',
    'Test-Path x &&',
  ])('incomplete: %j', (cmd) => {
    expect(ps(cmd)).toBe(true);
  });
});
