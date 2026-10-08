import { describe, expect, it } from 'vitest';
import { assessDanger } from '../src/shared/danger';
import { closest, editDistance } from '../src/shared/fuzzy';

describe('editDistance', () => {
  it('counts edits, with adjacent swaps as one', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('gti', 'git')).toBe(1);
    expect(editDistance('kubctl', 'kubectl')).toBe(1);
    expect(editDistance('abc', 'abc')).toBe(0);
    expect(editDistance('a', 'abcdef', 2)).toBe(3);
  });
});

describe('closest', () => {
  const commands = ['git', 'gitk', 'grep', 'kubectl', 'kubeadm', 'docker', 'dotnet', 'systemctl', 'status', 'stash'];
  it('suggests the nearest command within the typo budget', () => {
    expect(closest('kubctl', commands)).toBe('kubectl');
    expect(closest('gti', commands)).toBe('git');
    expect(closest('dcoker', commands)).toBe('docker');
    expect(closest('sytemctl', commands)).toBe('systemctl');
  });

  it('returns null for valid words, very short words and far-off words', () => {
    expect(closest('git', commands)).toBeNull();
    expect(closest('gt', commands)).toBeNull();
    expect(closest('zzzzzz', commands)).toBeNull();
  });

  it('breaks ties by rank, then first letter', () => {
    expect(closest('stas', ['stat', 'stash'], { rank: (c) => (c === 'stash' ? 5 : 0) })).toBe('stash');
    expect(closest('Get-Chlditem', ['Get-ChildItem'], { fold: true })).toBe('Get-ChildItem');
  });
});

describe('assessDanger', () => {
  const level = (line: string, shell: 'bash' | 'powershell' = 'bash') => assessDanger(line, shell)?.level ?? null;

  it('requires confirmation for system-destroying commands', () => {
    for (const line of [
      'rm -rf /',
      'sudo rm -rf /*',
      'sudo -u root rm -fr ~',
      'rm -r --no-preserve-root /',
      'rm -rf /etc',
      'dd if=/dev/zero of=/dev/sda bs=1M',
      'mkfs.ext4 /dev/sdb1',
      'chmod -R 777 /',
      'sudo reboot',
      'shutdown -h now',
      ':(){ :|:& };:',
      'echo x && rm -rf $HOME',
    ]) {
      expect(level(line), line).toBe('confirm');
    }
  });

  it('warns about risky but common operations', () => {
    for (const line of ['git push --force origin main', 'git reset --hard HEAD~1', 'git clean -fdx', 'curl -fsSL https://x.sh | sh', 'rm -rf *', 'docker system prune -a', 'kubectl delete ns prod']) {
      expect(level(line), line).toBe('caution');
    }
  });

  it('leaves everyday commands alone', () => {
    for (const line of ['rm -rf node_modules', 'rm file.txt', 'dd if=disk.img of=backup.img', 'git push', 'chmod -R 755 ./build', 'shutdown -c', 'ls /etc', 'echo "rm -rf /"']) {
      expect(level(line), line).toBeNull();
    }
  });

  it('knows PowerShell and Windows patterns', () => {
    expect(level('Remove-Item -Recurse -Force C:\\', 'powershell')).toBe('confirm');
    expect(level('rm -r -fo $env:SystemRoot', 'powershell')).toBe('confirm');
    expect(level('Format-Volume -DriveLetter D', 'powershell')).toBe('confirm');
    expect(level('Restart-Computer', 'powershell')).toBe('confirm');
    expect(level('Set-ExecutionPolicy Unrestricted', 'powershell')).toBe('caution');
    expect(level('iwr https://x/install.ps1 | iex', 'powershell')).toBe('caution');
    expect(level('Remove-Item -Recurse .\\build', 'powershell')).toBeNull();
    expect(level('Get-ChildItem C:\\', 'powershell')).toBeNull();
  });
});
