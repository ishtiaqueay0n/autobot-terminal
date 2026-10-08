import { describe, expect, it } from 'vitest';
import { isHookFile, isPlainHome } from '../src/main/hook-files';

describe('isHookFile', () => {
  it('accepts the files the shell hooks write', () => {
    expect(isHookFile('/tmp/autobot-4242.commands')).toBe(true);
    expect(isHookFile('/tmp/autobot-4242.vars')).toBe(true);
    expect(isHookFile('/run/user/1000/autobot-7.commands')).toBe(true);
    expect(isHookFile('C:\\Users\\me\\AppData\\Local\\Temp\\autobot-1234.commands')).toBe(true);
  });

  it('refuses anything else a marker could name (it would be read and then deleted)', () => {
    for (const path of [
      '/home/me/.ssh/id_ed25519',
      '/etc/passwd',
      '/tmp/autobot-1.commands/../../home/me/.bashrc',
      '/tmp/../etc/autobot-1.commands',
      '/tmp/autobot-x.commands',
      '/tmp/autobot-1.commands.bak',
      '/tmp/autobot-1.commands\0.txt',
      'autobot-1.commands/../x',
      '',
    ]) {
      expect(isHookFile(path), path).toBe(false);
    }
    expect(isHookFile('/tmp/' + 'a'.repeat(2000) + '/autobot-1.commands')).toBe(false);
  });
});

describe('isPlainHome', () => {
  it('takes an absolute path that stays where it says', () => {
    expect(isPlainHome('/home/alice')).toBe(true);
    expect(isPlainHome('/root')).toBe(true);
    expect(isPlainHome('/home/alice/../bob')).toBe(false);
    expect(isPlainHome('home/alice')).toBe(false);
    expect(isPlainHome('C:\\Users\\me')).toBe(false);
    expect(isPlainHome('')).toBe(false);
  });
});
