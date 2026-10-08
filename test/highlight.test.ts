import { describe, expect, it } from 'vitest';
import { commandCategory, highlightCommand } from '../src/shared/highlight';
import type { ShellKind } from '../src/shared/types';

/** "word:role" for every coloured piece of the line. */
function roles(line: string, shell: ShellKind = 'bash'): string[] {
  return highlightCommand(line, shell).map((t) => `${line.slice(t.start, t.end)}:${t.role}`);
}

describe('highlightCommand', () => {
  it('colours a command by what kind of program it is, and its words by what they look like', () => {
    expect(roles('git commit -m "fix bug" --amend')).toEqual([
      'git:cmd-vcs',
      'commit:subcommand',
      '-m:option',
      '"fix bug":string',
      '--amend:option',
    ]);
    expect(roles('ls -la ~/projects | grep foo > out.txt')).toEqual([
      'ls:cmd-read',
      '-la:option',
      '~/projects:path',
      '|:operator',
      'grep:cmd-read',
      '>:operator',
      'out.txt:path',
    ]);
  });

  it('marks privilege, destructive tools and the words that come before the command', () => {
    expect(roles('sudo rm -rf /tmp/x')).toEqual(['sudo:cmd-priv', 'rm:cmd-danger', '-rf:option', '/tmp/x:path']);
    expect(roles('FOO=bar npm install --save-dev typescript')).toEqual(['FOO:keyword', 'npm:cmd-pkg', 'install:subcommand', '--save-dev:option']);
    expect(roles('if true; then echo ok; fi')).toEqual(['if:keyword', 'true:cmd-shell', ';:operator', 'then:keyword', 'echo:cmd-shell', ';:operator', 'fi:keyword']);
  });

  it('knows variables, numbers, urls and comments', () => {
    expect(roles('echo $HOME 42 https://example.com/a # a note')).toEqual([
      'echo:cmd-shell',
      '$HOME:variable',
      '42:number',
      'https://example.com/a:url',
      '# a note:comment',
    ]);
    // # inside words and quotes is not a comment.
    expect(roles('echo a#b "x # y"')).toEqual(['echo:cmd-shell', '"x # y":string']);
  });

  it('only the first plain word after a tool with subcommands is a subcommand, and option values are not', () => {
    expect(roles('docker run --rm -it alpine ls')).toEqual(['docker:cmd-cloud', 'run:subcommand', '--rm:option', '-it:option']);
    expect(roles('git -C repo status')).toEqual(['git:cmd-vcs', '-C:option', 'status:subcommand']);
    expect(roles('systemctl restart nginx')).toEqual(['systemctl:cmd-sys', 'restart:subcommand']);
  });

  it('splits --name=value into the option and its value', () => {
    expect(roles('curl --output=/tmp/a.txt --retry=3 https://x.dev')).toEqual([
      'curl:cmd-net',
      '--output=:option',
      '/tmp/a.txt:path',
      '--retry=:option',
      '3:number',
      'https://x.dev:url',
    ]);
  });

  it('treats each command of a pipeline and each line separately', () => {
    expect(roles('cat a.log | sort | uniq -c && echo done')).toEqual([
      'cat:cmd-read',
      '|:operator',
      'sort:cmd-read',
      '|:operator',
      'uniq:cmd-read',
      '-c:option',
      '&&:operator',
      'echo:cmd-shell',
    ]);
    expect(roles('echo a\nrm b')).toEqual(['echo:cmd-shell', 'rm:cmd-danger']);
    const tokens = highlightCommand('echo a\nrm b', 'bash');
    expect(tokens.map((t) => [t.start, t.end])).toEqual([
      [0, 4],
      [7, 9],
    ]);
  });

  it('handles an unfinished quote and an empty line', () => {
    expect(roles('echo "abc')).toEqual(['echo:cmd-shell', '"abc:string']);
    expect(roles('')).toEqual([]);
    expect(roles('   ')).toEqual([]);
  });

  it('works for PowerShell: cmdlets by verb, parameters, paths', () => {
    expect(roles('Get-ChildItem -Recurse C:\\Temp | Remove-Item -WhatIf', 'powershell')).toEqual([
      'Get-ChildItem:cmd-read',
      '-Recurse:option',
      'C:\\Temp:path',
      '|:operator',
      'Remove-Item:cmd-danger',
      '-WhatIf:option',
    ]);
    expect(roles('Set-Content -Path out.txt -Value hi # x', 'powershell')).toEqual([
      'Set-Content:cmd-change',
      '-Path:option',
      '-Value:option',
      '# x:comment',
    ]);
    expect(roles('$x = Get-Date', 'powershell')[roles('$x = Get-Date', 'powershell').length - 1]).toBe('Get-Date:cmd-read');
  });

  it('works for cmd.exe: /options, %VARIABLES%, no comments with #', () => {
    expect(roles('dir /s C:\\Temp', 'cmd')).toEqual(['dir:cmd-read', '/s:option', 'C:\\Temp:path']);
    expect(roles('echo %PATH% # not a comment', 'cmd')).toEqual(['echo:cmd-shell', '%PATH%:variable']);
  });

  it('keeps the tokens in order and never overlapping', () => {
    for (const line of ['sudo -u bob env A=1 git log --oneline -n 3 | head >> /tmp/x 2>&1', 'for f in *.txt; do echo "$f"; done']) {
      const tokens = highlightCommand(line, 'bash');
      for (let i = 1; i < tokens.length; i++) expect(tokens[i].start).toBeGreaterThanOrEqual(tokens[i - 1].end);
    }
  });
});

describe('commandCategory', () => {
  it('ignores directories and .exe, and PowerShell case', () => {
    expect(commandCategory('/usr/bin/git', 'bash')).toBe('cmd-vcs');
    expect(commandCategory('C:\\Windows\\System32\\ping.exe', 'powershell')).toBe('cmd-net');
    expect(commandCategory('GET-CHILDITEM', 'powershell')).toBe('cmd-read');
    expect(commandCategory('mystery-tool', 'bash')).toBe('cmd-other');
  });
});
