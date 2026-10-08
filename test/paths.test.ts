import { describe, expect, it } from 'vitest';
import { baseName, shortenHome, toHostPath, toWslPath } from '../src/shared/paths';

describe('toWslPath', () => {
  it('maps drive paths to /mnt', () => {
    expect(toWslPath('F:\\AI Terminal\\resources\\shell\\autobot.bash')).toBe('/mnt/f/AI Terminal/resources/shell/autobot.bash');
    expect(toWslPath('C:\\')).toBe('/mnt/c');
  });
});

describe('toHostPath', () => {
  const wsl = { pathStyle: 'wsl' as const, wslDistro: 'Ubuntu' };
  it('maps WSL paths back to Windows paths', () => {
    expect(toHostPath('/mnt/c/Users/me', wsl)).toBe('C:\\Users\\me');
    expect(toHostPath('/mnt/d', wsl)).toBe('D:\\');
    expect(toHostPath('/home/me/proj', wsl)).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\proj');
  });

  it('leaves native paths alone', () => {
    expect(toHostPath('/home/me', { pathStyle: 'posix' })).toBe('/home/me');
    expect(toHostPath('C:\\x', { pathStyle: 'windows' })).toBe('C:\\x');
  });
});

describe('shortenHome', () => {
  it('replaces the home prefix', () => {
    expect(shortenHome('/home/me', '/home/me')).toBe('~');
    expect(shortenHome('/home/me/src/app', '/home/me')).toBe('~/src/app');
    expect(shortenHome('/home/meow', '/home/me')).toBe('/home/meow');
    expect(shortenHome('/etc', null)).toBe('/etc');
  });

  it('compares Windows paths case-insensitively', () => {
    expect(shortenHome('C:\\Users\\Me\\Code', 'c:\\users\\me')).toBe('~\\Code');
    expect(shortenHome('C:\\Users\\Me', 'C:\\Users\\Me\\')).toBe('~');
  });
});

describe('baseName', () => {
  it('returns the last segment', () => {
    expect(baseName('/home/me/proj')).toBe('proj');
    expect(baseName('C:\\Users\\me\\')).toBe('me');
    expect(baseName('~')).toBe('~');
    expect(baseName('/')).toBe('/');
  });
});
