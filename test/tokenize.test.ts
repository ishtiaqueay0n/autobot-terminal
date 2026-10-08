import { describe, expect, it } from 'vitest';
import { contextAt, splitCommands, toolName } from '../src/shared/tokenize';
import type { ShellKind } from '../src/shared/types';

/** Context at the end of the line, or at the "|" marker. */
function ctx(line: string, shell: ShellKind = 'bash') {
  const at = line.indexOf('‸');
  const text = at === -1 ? line : line.replace('‸', '');
  const c = contextAt(text, at === -1 ? text.length : at, shell);
  return {
    words: c.words.map((w) => w.value),
    current: c.words[c.index],
    command: c.commandIndex >= 0 ? c.words[c.commandIndex]?.value : null,
    atCommand: c.index === c.commandIndex,
  };
}

describe('contextAt (bash)', () => {
  it('splits words and finds the current one', () => {
    expect(ctx('git chec')).toMatchObject({ words: ['git', 'chec'], command: 'git', atCommand: false });
    expect(ctx('git ').words).toEqual(['git', '']);
    expect(ctx('gi')).toMatchObject({ words: ['gi'], atCommand: true });
    expect(ctx('')).toMatchObject({ words: [''], atCommand: true });
  });

  it('only looks at the simple command around the cursor', () => {
    expect(ctx('cat x | grep -i fo').words).toEqual(['grep', '-i', 'fo']);
    expect(ctx('make && npm run b').words).toEqual(['npm', 'run', 'b']);
    expect(ctx('cd /tmp; ls -l').words).toEqual(['ls', '-l']);
    expect(ctx('echo $(git rev-p').words).toEqual(['git', 'rev-p']);
    expect(ctx('echo `date +%').words).toEqual(['date', '+%']);
    expect(ctx('echo `date` && ls').words).toEqual(['ls']);
    expect(ctx('x=$(echo a) && git s').words).toEqual(['git', 's']);
  });

  it('removes quotes and escapes but keeps raw offsets', () => {
    const c = ctx('ls "My Doc');
    expect(c.words).toEqual(['ls', 'My Doc']);
    expect(c.current).toMatchObject({ start: 3, end: 10, quote: '"' });
    expect(ctx("cat 'a b' My\\ Fi").words).toEqual(['cat', 'a b', 'My Fi']);
  });

  it('marks redirection targets as paths', () => {
    expect(ctx('echo hi > out').current.redirect).toBe('out');
    expect(ctx('cmd 2>> err').current.redirect).toBe('out');
    expect(ctx('cmd &> lo').current.redirect).toBe('out');
    expect(ctx('sort < in').current.redirect).toBe('in');
    expect(ctx('echo hi').current.redirect).toBeUndefined();
  });

  it('skips prefixes, keywords and assignments to find the command', () => {
    expect(ctx('sudo -u root systemctl rest')).toMatchObject({ command: 'systemctl' });
    expect(ctx('sudo ').atCommand).toBe(true);
    expect(ctx('LANG=C sort -')).toMatchObject({ command: 'sort' });
    expect(ctx('if grep -q x f; then ech')).toMatchObject({ command: 'ech', atCommand: true });
    expect(ctx('timeout 5 curl -')).toMatchObject({ command: 'curl' });
    expect(ctx('env FOO=1 node -')).toMatchObject({ command: 'node' });
  });

  it('completes at the cursor, not the end of the line', () => {
    expect(ctx('git ch‸ origin').words).toEqual(['git', 'ch']);
  });
});

describe('contextAt (powershell)', () => {
  it('handles pipes, script blocks and subexpressions', () => {
    expect(ctx('Get-Process | Where-Obj', 'powershell').words).toEqual(['Where-Obj']);
    expect(ctx('Get-ChildItem | ForEach-Object { Get-Item -Pa', 'powershell').words).toEqual(['Get-Item', '-Pa']);
    expect(ctx('Write-Output $(Get-Dat', 'powershell').words).toEqual(['Get-Dat']);
    expect(ctx('Get-Item C:\\Win', 'powershell').words).toEqual(['Get-Item', 'C:\\Win']);
  });

  it('uses backtick escapes and keeps backslashes', () => {
    expect(ctx('Get-Item "C:\\Program` Files', 'powershell').words).toEqual(['Get-Item', 'C:\\Program Files']);
  });

  it('finds the command after assignments and call operators', () => {
    expect(ctx('$x = Get-Ch', 'powershell')).toMatchObject({ command: 'Get-Ch', atCommand: true });
    expect(ctx('& git sta', 'powershell')).toMatchObject({ command: 'git', words: ['git', 'sta'] });
  });
});

describe('toolName', () => {
  it('normalizes command words', () => {
    expect(toolName('git', 'bash')).toBe('git');
    expect(toolName('/usr/bin/git', 'bash')).toBe('git');
    expect(toolName('C:\\Program Files\\Git\\cmd\\git.exe', 'powershell')).toBe('git');
    expect(toolName('Get-ChildItem', 'powershell')).toBe('get-childitem');
    expect(toolName('Make', 'bash')).toBe('Make');
  });
});

describe('splitCommands', () => {
  it('splits at top-level operators only', () => {
    expect(splitCommands('kubectl get pods -n prod | grep api && echo "a | b"; ls', 'bash')).toEqual([
      'kubectl get pods -n prod',
      'grep api',
      'echo "a | b"',
      'ls',
    ]);
    expect(splitCommands('echo $(a | b) || c', 'bash')).toEqual(['echo $(a | b)', 'c']);
    expect(splitCommands('Get-Process | Where-Object { $_.CPU -gt 1 } | Sort-Object', 'powershell')).toEqual([
      'Get-Process',
      'Where-Object { $_.CPU -gt 1 }',
      'Sort-Object',
    ]);
  });
});
