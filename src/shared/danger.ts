import { isPosix } from './shell';
import { splitCommands } from './tokenize';
import type { ShellKind } from './types';

/**
 * "confirm": can destroy a system or a disk; Enter has to be pressed twice.
 * "caution": can lose work or is risky; shown as a warning, runs normally.
 */
export interface Danger {
  level: 'confirm' | 'caution';
  reason: string;
}

const CRITICAL_POSIX = /^(\/|\/\*|~\/?|~\/\*|\$HOME\/?|\$\{HOME\}\/?|\/(bin|boot|dev|etc|home|lib|lib64|opt|proc|root|sbin|srv|sys|usr|var)(\/\*?)?)$/;
const CRITICAL_WINDOWS = /^['"]?([A-Za-z]:\\?\*?|[A-Za-z]:\\(Windows|Users|Program Files( \(x86\))?|ProgramData)(\\\*?)?|\$env:(SystemRoot|windir|SystemDrive|USERPROFILE|ProgramFiles)\\?\*?|~\\?)['"]?$/i;
const BLOCK_DEVICE = /^\/dev\/(sd[a-z]|nvme\d|hd[a-z]|vd[a-z]|xvd[a-z]|mmcblk\d|disk\d|dm-\d|md\d|mapper\/)/;

/** Looks for well-known destructive patterns in each command of the line. Returns the most serious one. */
export function assessDanger(line: string, shell: ShellKind): Danger | null {
  let found: Danger | null = null;
  const consider = (d: Danger | null) => {
    if (d && (!found || (d.level === 'confirm' && found.level === 'caution'))) found = d;
  };
  if (/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(line)) consider({ level: 'confirm', reason: 'This is a fork bomb: it starts processes until the system stops responding.' });
  if (/\b(curl|wget|iwr|Invoke-WebRequest|irm|Invoke-RestMethod)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b|\|\s*(iex|Invoke-Expression)\b/i.test(line)) {
    consider({ level: 'caution', reason: 'Runs a script straight from the internet without saving it first. Make sure you trust the source.' });
  }
  for (const part of splitCommands(line, shell)) consider(assessCommand(words(part), shell));
  return found;
}

function words(command: string): string[] {
  return (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^(["'])(.*)\1$/, '$2'));
}

const PREFIXES = /^(sudo|doas|nohup|time|nice|exec|command|builtin)$/;
/** Prefix flags that take the next word as their value (sudo -u root ...). */
const PREFIX_VALUE_FLAGS = /^-[ugCDhprtUTn]$/;

function assessCommand(argv: string[], shell: ShellKind): Danger | null {
  // Skip prefixes (and their own flags) that do not change what the command does.
  while (argv.length && PREFIXES.test(argv[0])) {
    argv = argv.slice(1);
    while (argv.length && argv[0].startsWith('-')) argv = argv.slice(PREFIX_VALUE_FLAGS.test(argv[0]) ? 2 : 1);
  }
  if (!argv.length) return null;
  const cmd = argv[0].replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();
  const args = argv.slice(1);
  const flags = args.filter((a) => a.startsWith('-')).join(' ');
  const targets = args.filter((a) => !a.startsWith('-'));
  const has = (re: RegExp) => re.test(flags);

  if (shell === 'cmd') {
    const verdict = assessCmd(cmd, args);
    if (verdict !== undefined) return verdict;
  }

  // In PowerShell, rm is an alias of Remove-Item: handled with the PowerShell rules below. cmd.exe has no rm.
  if (cmd === 'rm' && isPosix(shell)) {
    const recursive = has(/(^|\s)-[a-zA-Z]*[rR]|--recursive/);
    const force = has(/(^|\s)-[a-zA-Z]*f|--force/);
    if (has(/--no-preserve-root/)) return { level: 'confirm', reason: 'rm --no-preserve-root removes the protection against deleting /.' };
    const critical = targets.find((t) => CRITICAL_POSIX.test(t));
    if (recursive && critical) return { level: 'confirm', reason: `Deletes everything under ${critical}, which would break the system or wipe your home folder.` };
    // Everyday deletes (rm -rf node_modules) get no warning; wiping the current folder does.
    if (recursive && force && targets.some((t) => t === '.' || t === '..' || t === '*' || t === './*' || t === '../*')) {
      return { level: 'caution', reason: 'Force-deletes everything in this folder recursively, without asking.' };
    }
    return null;
  }

  if (cmd === 'dd') {
    const of = args.find((a) => a.startsWith('of='))?.slice(3);
    if (of && BLOCK_DEVICE.test(of)) return { level: 'confirm', reason: `Writes raw data over the disk ${of}; everything on it is lost.` };
    return null;
  }

  if (/^mkfs(\.|$)/.test(cmd) || cmd === 'mkswap' || cmd === 'wipefs') {
    return { level: 'confirm', reason: `${cmd} erases the file system on ${targets[targets.length - 1] ?? 'the target device'}.` };
  }
  if (cmd === 'shred' && targets.some((t) => BLOCK_DEVICE.test(t))) return { level: 'confirm', reason: 'Overwrites a whole disk.' };
  if ((cmd === 'fdisk' || cmd === 'sfdisk' || cmd === 'parted' || cmd === 'gdisk') && !has(/-l|--list/)) {
    return { level: 'caution', reason: `${cmd} changes partition tables; a mistake can make disks unreadable.` };
  }

  if ((cmd === 'chmod' || cmd === 'chown' || cmd === 'chgrp') && has(/(^|\s)-[a-zA-Z]*R|--recursive/)) {
    const critical = targets.find((t) => CRITICAL_POSIX.test(t));
    if (critical) return { level: 'confirm', reason: `Recursively changes ownership/permissions of ${critical}; this can make the system unbootable or insecure.` };
  }

  if (['shutdown', 'reboot', 'halt', 'poweroff'].includes(cmd) || (cmd === 'init' && /^[06]$/.test(targets[0] ?? '')) || (cmd === 'systemctl' && /^(poweroff|reboot|halt|kexec)$/.test(targets[0] ?? ''))) {
    if (cmd === 'shutdown' && has(/(^|\s)-c\b/)) return null;
    return { level: 'confirm', reason: 'Shuts down or restarts this machine (and ends everyone’s sessions on a server).' };
  }

  if (cmd === 'git') {
    const sub = targets[0];
    if (sub === 'push' && has(/(^|\s)(-f|--force)(\s|$)/)) return { level: 'caution', reason: 'Force-push overwrites the remote branch; others’ commits there can be lost. --force-with-lease is safer.' };
    if (sub === 'reset' && has(/--hard/)) return { level: 'caution', reason: 'Discards all uncommitted changes in tracked files.' };
    if (sub === 'clean' && has(/(^|\s)-[a-zA-Z]*f/)) return { level: 'caution', reason: 'Deletes untracked files for good.' };
    if (sub === 'checkout' && targets[1] === '.' ) return { level: 'caution', reason: 'Discards all unstaged changes.' };
    return null;
  }

  if (cmd === 'docker' && /^(system|volume|image|container)$/.test(targets[0] ?? '') && targets[1] === 'prune' && has(/(^|\s)(-a|--all|--volumes)/)) {
    return { level: 'caution', reason: 'Removes unused Docker data, including images or volumes you may want later.' };
  }
  if (cmd === 'kubectl' && targets[0] === 'delete' && (/^(ns|namespace|namespaces|all|nodes?|pv|persistentvolumes?)$/.test(targets[1] ?? '') || has(/--all(\s|$)/))) {
    return { level: 'caution', reason: 'Deletes cluster resources broadly; check the context and namespace first.' };
  }

  if (shell === 'powershell') return assessPowerShell(cmd, args, targets, has);
  if (cmd === 'format' && /^[A-Za-z]:$/.test(targets[0] ?? '')) return { level: 'confirm', reason: `Formats drive ${targets[0]}; everything on it is lost.` };
  return null;
}

function assessPowerShell(cmd: string, args: string[], targets: string[], has: (re: RegExp) => boolean): Danger | null {
  if (cmd === 'remove-item' || cmd === 'rm' || cmd === 'del' || cmd === 'rd' || cmd === 'rmdir' || cmd === 'ri' || cmd === 'erase') {
    const pathArg = args.findIndex((a) => /^-(path|literalpath)$/i.test(a));
    const paths = pathArg >= 0 ? [args[pathArg + 1]] : targets;
    const critical = paths.find((p) => p !== undefined && CRITICAL_WINDOWS.test(p));
    if (has(/-r(ecurse)?(\s|$)/i) && critical) return { level: 'confirm', reason: `Deletes everything under ${critical}; Windows or your user profile would be destroyed.` };
    if (/^(rd|rmdir)$/.test(cmd) && args.some((a) => /^\/s$/i.test(a)) && critical) return { level: 'confirm', reason: `Deletes everything under ${critical}.` };
    if (has(/-r(ecurse)?(\s|$)/i) && paths.some((p) => p === '*' || p === '.' || p === '.\\*' || p === './*')) {
      return { level: 'caution', reason: 'Deletes everything in this folder recursively; there is no Recycle Bin for this.' };
    }
    return null;
  }
  if (/^(format-volume|clear-disk|initialize-disk|remove-partition)$/.test(cmd)) return { level: 'confirm', reason: `${cmd} erases a disk or volume.` };
  if (cmd === 'format' && /^[A-Za-z]:$/.test(targets[0] ?? '')) return { level: 'confirm', reason: `Formats drive ${targets[0]}; everything on it is lost.` };
  if (cmd === 'diskpart') return { level: 'caution', reason: 'diskpart changes disks and partitions.' };
  if (cmd === 'vssadmin' && /^delete$/i.test(targets[0] ?? '')) return { level: 'confirm', reason: 'Deletes volume shadow copies (restore points and backups).' };
  if (/^(stop-computer|restart-computer)$/.test(cmd)) return { level: 'confirm', reason: 'Shuts down or restarts the computer.' };
  if (cmd === 'shutdown' && args.some((a) => /^[/-][srp]$/i.test(a))) return { level: 'confirm', reason: 'Shuts down or restarts the computer.' };
  if (cmd === 'set-executionpolicy' && args.some((a) => /^(unrestricted|bypass)$/i.test(a))) return { level: 'caution', reason: 'Lets any PowerShell script run, including unsigned ones from the internet.' };
  if (cmd === 'reg' && /^delete$/i.test(targets[0] ?? '') && /^HK(LM|EY_LOCAL_MACHINE)/i.test(targets[1] ?? '')) return { level: 'caution', reason: 'Deletes machine-wide registry keys.' };
  if (cmd === 'bcdedit' && args.some((a) => /^\/(set|delete|deletevalue)$/i.test(a))) return { level: 'caution', reason: 'Changes the Windows boot configuration.' };
  return null;
}

/** %SystemRoot%, %USERPROFILE% and friends, which cmd.exe expands before the command runs. */
const CMD_CRITICAL_VARIABLE = /^["']?%(systemroot|windir|systemdrive|homedrive|userprofile|programfiles(\(x86\))?|programdata)%\\?\*?["']?$/i;

/**
 * cmd.exe's own commands. Returns undefined when the command is not one of them (the shared rules for git,
 * docker, kubectl ... then apply), and null when it is one of them and is fine.
 */
function assessCmd(cmd: string, args: string[]): Danger | null | undefined {
  const switches = args.filter((a) => /^\/[A-Za-z?]/.test(a)).map((a) => a.toLowerCase());
  const targets = args.filter((a) => !/^\/[A-Za-z?]/.test(a));
  const critical = targets.find((t) => CRITICAL_WINDOWS.test(t) || CMD_CRITICAL_VARIABLE.test(t));
  const everything = targets.some((t) => t === '*' || t === '.' || t === '.\\' || t === '*.*' || t === '.\\*' || t === '.\\*.*');

  if (cmd === 'rd' || cmd === 'rmdir') {
    if (switches.includes('/s') && critical) return { level: 'confirm', reason: `Deletes everything under ${critical}; Windows or your user profile would be destroyed.` };
    if (switches.includes('/s') && switches.includes('/q') && everything) {
      return { level: 'caution', reason: 'Deletes this folder’s contents and subfolders without asking; there is no Recycle Bin for this.' };
    }
    return null;
  }
  if (cmd === 'del' || cmd === 'erase') {
    if (switches.includes('/s') && critical) return { level: 'confirm', reason: `Deletes files under ${critical}; Windows or your user profile would be destroyed.` };
    if (switches.includes('/s') && switches.includes('/q') && everything) {
      return { level: 'caution', reason: 'Deletes every file in this folder and its subfolders without asking; there is no Recycle Bin for this.' };
    }
    return null;
  }
  if (cmd === 'format') {
    const drive = targets.find((t) => /^[A-Za-z]:$/.test(t));
    return drive ? { level: 'confirm', reason: `Formats drive ${drive}; everything on it is lost.` } : null;
  }
  if (cmd === 'shutdown') {
    if (switches.includes('/a')) return null; // aborts a pending shutdown
    return switches.some((s) => /^\/[srpg]$/.test(s)) ? { level: 'confirm', reason: 'Shuts down or restarts the computer.' } : null;
  }
  if (cmd === 'diskpart') return { level: 'caution', reason: 'diskpart changes disks and partitions.' };
  if (cmd === 'vssadmin' && /^delete$/i.test(targets[0] ?? '')) return { level: 'confirm', reason: 'Deletes volume shadow copies (restore points and backups).' };
  if (cmd === 'cipher' && switches.some((s) => s.startsWith('/w'))) return { level: 'caution', reason: 'cipher /w overwrites all free space on a drive; it takes hours and slows the machine.' };
  if (cmd === 'reg' && /^delete$/i.test(targets[0] ?? '') && /^HK(LM|EY_LOCAL_MACHINE)/i.test(targets[1] ?? '')) {
    return { level: 'caution', reason: 'Deletes machine-wide registry keys.' };
  }
  if (cmd === 'bcdedit' && switches.some((s) => /^\/(set|delete|deletevalue)$/.test(s))) return { level: 'caution', reason: 'Changes the Windows boot configuration.' };
  if (cmd === 'taskkill' && switches.includes('/f') && targets.concat(args).some((t) => /^(explorer|winlogon|csrss|svchost|lsass|wininit|services)(\.exe)?$/i.test(t))) {
    return { level: 'caution', reason: 'Force-stops a core Windows process; the desktop or the whole system can stop working.' };
  }
  return undefined;
}
