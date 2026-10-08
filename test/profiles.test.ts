import { describe, expect, it } from 'vitest';
import { launchSpec, shellEnvironment, type ResolvedProfile } from '../src/main/profiles';

describe('shellEnvironment', () => {
  it('drops Electron-internal variables and sets terminal identity', () => {
    const env = shellEnvironment({
      PATH: '/usr/bin',
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_RENDERER_URL: 'http://localhost:5173',
      TERM: 'dumb',
    });
    expect(env).toEqual({ PATH: '/usr/bin', TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'AutobotTerminal' });
  });
});

describe('launchSpec', () => {
  it('starts bash with the Autobot rcfile', () => {
    const bash: ResolvedProfile = { id: 'bash', name: 'bash', kind: 'bash', pathStyle: 'posix', executable: '/bin/bash' };
    const spec = launchSpec(bash, '/opt/autobot/shell');
    expect(spec.file).toBe('/bin/bash');
    expect(spec.args.slice(-1)).toEqual(['-i']);
    expect(spec.args[1].replace(/\\/g, '/')).toBe('/opt/autobot/shell/autobot.bash');
  });

  it('starts WSL bash with the rcfile translated to a /mnt path', () => {
    const wsl: ResolvedProfile = {
      id: 'wsl:Ubuntu',
      name: 'Ubuntu (WSL)',
      kind: 'bash',
      pathStyle: 'wsl',
      wslDistro: 'Ubuntu',
      executable: 'C:\\Windows\\System32\\wsl.exe',
    };
    const spec = launchSpec(wsl, 'F:\\AI Terminal\\resources\\shell');
    expect(spec.args).toEqual([
      '-d',
      'Ubuntu',
      '--cd',
      '~',
      '-e',
      'bash',
      '--rcfile',
      '/mnt/f/AI Terminal/resources/shell/autobot.bash',
      '-i',
    ]);
    expect(spec.env.WSLENV).toContain('TERM_PROGRAM/u');
  });

  it('loads the PowerShell hook as a script block with a short command line', () => {
    const ps: ResolvedProfile = { id: 'pwsh', name: 'PowerShell 7', kind: 'powershell', pathStyle: 'windows', executable: 'pwsh.exe' };
    const spec = launchSpec(ps, "C:\\Users\\O'Brien\\autobot\\shell");
    expect(spec.args.slice(0, 3)).toEqual(['-NoLogo', '-NoExit', '-Command']);
    // Single quotes in the path are doubled for the PowerShell string literal.
    expect(spec.args[3].replace(/\\/g, '/')).toBe(
      ". ([scriptblock]::Create([IO.File]::ReadAllText('C:/Users/O''Brien/autobot/shell/autobot.ps1')))",
    );
    expect(spec.args[3].length).toBeLessThan(300);
  });
});
