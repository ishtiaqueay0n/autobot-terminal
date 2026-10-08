import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { hostPath, runIn, type EnvRef } from './exec';

/**
 * Tools Autobot never runs on its own, not even with --help: destructive ones (an implementation that
 * ignored --help would do real damage), privilege changers, and full-screen or pager programs.
 */
const DENY = new Set([
  'rm', 'rmdir', 'del', 'erase', 'rd', 'dd', 'shred', 'wipefs', 'format', 'diskpart', 'fdisk', 'sfdisk', 'gdisk',
  'cfdisk', 'parted', 'shutdown', 'reboot', 'halt', 'poweroff', 'init', 'telinit', 'kill', 'killall', 'pkill',
  'taskkill', 'sudo', 'su', 'doas', 'runas', 'passwd', 'chpasswd', 'userdel', 'groupdel', 'crontab', 'less',
  'more', 'most', 'top', 'htop', 'btop', 'watch', 'tmux', 'screen', 'vim', 'vi', 'nvim', 'nano', 'emacs', 'ed',
  'joe', 'mc', 'nnn', 'ranger', 'explorer', 'notepad', 'start', 'regedit', 'mstsc', 'cmd', 'wsl', 'bcdedit',
  'cipher', 'vssadmin', 'wmic', 'reg', 'sc', 'net', 'netsh',
]);

export function isDenied(tool: string): boolean {
  const t = tool.toLowerCase();
  return DENY.has(t) || /^(mkfs|fsck|mkswap|swapoff|lvremove|vgremove|pvremove)/.test(t);
}

const IMAGE_SUBSYSTEM_WINDOWS_CUI = 3;

function readHead(path: string, bytes: number): Buffer | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** True for a Windows console program (not a GUI app, which --help would open as a window). */
export function isConsoleExe(path: string): boolean {
  const head = readHead(path, 4096);
  if (!head || head.length < 0x40 || head.toString('latin1', 0, 2) !== 'MZ') return false;
  const pe = head.readUInt32LE(0x3c);
  if (pe + 24 + 70 > head.length || head.toString('latin1', pe, pe + 4) !== 'PE\0\0') return false;
  return head.readUInt16LE(pe + 24 + 68) === IMAGE_SUBSYSTEM_WINDOWS_CUI;
}

/** True for an ELF binary (compiled program), false for scripts and anything else. */
export function isElf(path: string): boolean {
  const head = readHead(path, 4);
  return head !== null && head.length === 4 && head[0] === 0x7f && head.toString('latin1', 1, 4) === 'ELF';
}

/**
 * Finds a tool on PATH and returns the path to run, or null when Autobot should not run it: denied,
 * a script, a GUI program, or a Microsoft Store app alias.
 */
export async function resolveExecutable(env: EnvRef, tool: string): Promise<string | null> {
  if (!/^[\w.+-]+$/.test(tool) || isDenied(tool)) return null;

  if (env.kind === 'windows') {
    const names = /\.(exe|com)$/i.test(tool) ? [tool] : [`${tool}.exe`, `${tool}.com`];
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      if (!dir || /\\WindowsApps\\?$/i.test(dir)) continue;
      for (const name of names) {
        const p = join(dir, name);
        if (existsSync(p) && isConsoleExe(p)) return p;
      }
    }
    return null;
  }

  if (env.kind === 'linux') {
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      if (!dir.startsWith('/')) continue;
      const p = join(dir, tool);
      try {
        if (statSync(p).isFile() && isElf(p)) return p;
      } catch {
        // not here
      }
    }
    return null;
  }

  // WSL: ask the distro where the tool is, then check the file through the \\wsl.localhost share.
  const res = await runIn(env, 'sh', ['-c', 'command -v -- "$1"', 'sh', tool], { timeoutMs: 4000 });
  const path = res.stdout.trim().split('\n')[0];
  if (!path?.startsWith('/')) return null;
  return isElf(hostPath(env, path)) ? path : null;
}
