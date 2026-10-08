import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CompletionItem, ShellKind } from '../../shared/types';
import type { Word } from '../../shared/tokenize';
import type { RemoteFs } from './remote-fs';

export interface PathContext {
  shell: ShellKind;
  /** The shell's own path style: Windows (C:\...) or POSIX (/home/...). */
  windowsPaths: boolean;
  /** Current folder and home, as the shell sees them. */
  cwd: string | null;
  home: string | null;
  /** Maps a shell path to one this process can read. */
  toHost(path: string): string;
  /** Set when the shell runs on another machine (ssh): folders are listed there instead of on this disk. */
  remote?: RemoteFs;
}

type Entry = Pick<Dirent, 'name' | 'isDirectory' | 'isSymbolicLink'>;

const MAX_ENTRIES = 2000;

/**
 * Completes the word as a file or folder path, relative to the shell's current folder. Insert text keeps
 * what the user typed (including ~) and quotes or escapes names the way the shell needs.
 */
export async function completePath(word: Word, ctx: PathContext, foldersOnly: boolean): Promise<CompletionItem[]> {
  const value = word.value;
  const lastSep = Math.max(value.lastIndexOf('/'), ctx.windowsPaths ? value.lastIndexOf('\\') : -1);
  const dirPart = value.slice(0, lastSep + 1);
  const base = value.slice(lastSep + 1);
  const sep = ctx.windowsPaths ? (dirPart.includes('/') && !dirPart.includes('\\') ? '/' : '\\') : '/';

  const dir = resolveDir(dirPart, ctx);
  if (dir === null) return [];
  let entries: Entry[];
  if (ctx.remote) {
    const listed = await ctx.remote.list(dir);
    if (!listed) return [];
    entries = listed.slice(0, MAX_ENTRIES).map((e) => ({ name: e.name, isDirectory: () => e.isDir, isSymbolicLink: () => false }));
  } else {
    try {
      entries = (await readdir(ctx.toHost(dir), { withFileTypes: true })).slice(0, MAX_ENTRIES);
    } catch {
      return [];
    }
  }

  const fold = ctx.windowsPaths;
  const want = fold ? base.toLowerCase() : base;
  const items: CompletionItem[] = [];
  for (const e of entries) {
    const name = e.name;
    if (!(fold ? name.toLowerCase() : name).startsWith(want)) continue;
    if (name.startsWith('.') && !base.startsWith('.')) continue;
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) {
      try {
        isDir = (await stat(join(ctx.toHost(dir), name))).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (foldersOnly && !isDir) continue;
    const full = dirPart + name + (isDir ? sep : '');
    items.push({
      label: name + (isDir ? sep : ''),
      insert: quoteForShell(full, ctx.shell, word.quote, isDir),
      kind: isDir ? 'folder' : 'file',
      suffix: isDir ? '' : ' ',
    });
  }
  // Folders first, then alphabetical.
  items.sort((a, b) => (a.kind === b.kind ? a.label.localeCompare(b.label) : a.kind === 'folder' ? -1 : 1));
  return items;
}

function resolveDir(dirPart: string, ctx: PathContext): string | null {
  let d = dirPart;
  if (d === '' ) return ctx.cwd;
  if (d === '~' || d.startsWith('~/') || d.startsWith('~\\')) {
    if (!ctx.home) return null;
    d = ctx.home + d.slice(1);
  }
  const absolute = ctx.windowsPaths ? /^([A-Za-z]:[\\/]|\\\\)/.test(d) : d.startsWith('/');
  if (absolute) return d;
  if (!ctx.cwd) return null;
  return ctx.windowsPaths ? `${ctx.cwd.replace(/[\\/]+$/, '')}\\${d}` : `${ctx.cwd.replace(/\/+$/, '')}/${d}`;
}

const BASH_SPECIAL = /[ \t'"\\$`!&;|<>(){}*?#[\]]/g;

/** Renders a path the way the shell reads it, preserving an opening quote the user already typed. */
export function quoteForShell(path: string, shell: ShellKind, quote: Word['quote'], isDir: boolean): string {
  const close = isDir ? '' : quote;
  if (shell === 'cmd') {
    // cmd.exe has only double quotes, and inside them nothing needs escaping (a path cannot contain ").
    if (quote === '"') return `"${path}${close}`;
    return /[\s&()^,;=%!@]/.test(path) ? `"${path}${isDir ? '' : '"'}` : path;
  }
  if (quote === "'") return `'${shell === 'powershell' ? path.replace(/'/g, "''") : path.replace(/'/g, `'\\''`)}${close}`;
  if (quote === '"') return `"${shell === 'powershell' ? path.replace(/[`"$]/g, '`$&') : path.replace(/["\\$`]/g, '\\$&')}${close}`;
  if (shell === 'powershell') {
    return /[\s'"`$&(){}@;,|<>#]/.test(path) ? `'${path.replace(/'/g, "''")}${isDir ? '' : "'"}` : path;
  }
  return path.replace(BASH_SPECIAL, (c) => (c === '~' ? c : `\\${c}`));
}
