import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isConsoleExe, isDenied, isElf, resolveExecutable } from '../src/main/kb/resolve';

const dir = mkdtempSync(join(tmpdir(), 'autobot-resolve-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Minimal PE header with the given subsystem. */
function fakePe(subsystem: number): Buffer {
  const buf = Buffer.alloc(512);
  buf.write('MZ', 0, 'latin1');
  buf.writeUInt32LE(0x80, 0x3c);
  buf.write('PE\0\0', 0x80, 'latin1');
  buf.writeUInt16LE(subsystem, 0x80 + 24 + 68);
  return buf;
}

describe('executable checks', () => {
  it('tells console programs from GUI programs', () => {
    writeFileSync(join(dir, 'cli.exe'), fakePe(3));
    writeFileSync(join(dir, 'gui.exe'), fakePe(2));
    writeFileSync(join(dir, 'script.cmd'), '@echo off\r\n');
    expect(isConsoleExe(join(dir, 'cli.exe'))).toBe(true);
    expect(isConsoleExe(join(dir, 'gui.exe'))).toBe(false);
    expect(isConsoleExe(join(dir, 'script.cmd'))).toBe(false);
  });

  it('tells ELF binaries from scripts', () => {
    writeFileSync(join(dir, 'bin'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]));
    writeFileSync(join(dir, 'deploy.sh'), '#!/bin/sh\nrm -rf /\n');
    expect(isElf(join(dir, 'bin'))).toBe(true);
    expect(isElf(join(dir, 'deploy.sh'))).toBe(false);
    expect(isElf(join(dir, 'missing'))).toBe(false);
  });

  it('denies destructive and interactive tools', () => {
    for (const t of ['rm', 'dd', 'mkfs.ext4', 'fsck', 'shutdown', 'diskpart', 'sudo', 'less', 'vim', 'Format']) {
      expect(isDenied(t)).toBe(true);
    }
    for (const t of ['git', 'docker', 'kubectl', 'dnf', 'ls']) expect(isDenied(t)).toBe(false);
  });

  it('refuses names that are not plain tool names', async () => {
    expect(await resolveExecutable({ id: 'linux', kind: 'linux' }, '../x')).toBeNull();
    expect(await resolveExecutable({ id: 'linux', kind: 'linux' }, 'a b')).toBeNull();
    expect(await resolveExecutable({ id: 'windows', kind: 'windows' }, 'rm')).toBeNull();
  });

  it.runIf(process.platform === 'win32')('finds real console programs on PATH', async () => {
    expect(await resolveExecutable({ id: 'windows', kind: 'windows' }, 'where')).toMatch(/where\.exe$/i);
    expect(await resolveExecutable({ id: 'windows', kind: 'windows' }, 'notepad')).toBeNull(); // GUI
  });
});
