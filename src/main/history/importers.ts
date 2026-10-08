import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ShellKind } from '../../shared/types';
import type { Analyzer, HistoryStore } from './store';

/** Older entries than this are dropped on import; they rarely matter and slow nothing but the first start. */
const MAX_IMPORT = 20_000;

/** PSReadLine writes a multi-line command as lines ending in a backtick, except the last one. */
export function parsePsReadLineHistory(text: string): string[] {
  const entries: string[] = [];
  let pending: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.endsWith('`')) {
      pending.push(line.slice(0, -1));
      continue;
    }
    pending.push(line);
    const entry = pending.join('\n');
    pending = [];
    if (entry.trim()) entries.push(entry);
  }
  if (pending.length) entries.push(pending.join('\n'));
  return entries;
}

/** One command per line; "#<epoch>" lines are timestamps written when HISTTIMEFORMAT is set. */
export function parseBashHistory(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.trim() && !/^#\d{9,11}$/.test(line));
}

/**
 * zsh's history file: `: <epoch>:<seconds>;command` per entry with EXTENDED_HISTORY, plain commands otherwise.
 * A command that spans lines has a backslash at the end of every line but the last. zsh stores bytes outside
 * ASCII behind a marker byte (0x83, the next byte xor 32), so the file is read as latin1 text (one char per
 * byte) and decoded here.
 */
export function parseZshHistory(text: string): string[] {
  const entries: string[] = [];
  let pending: string[] = [];
  for (const raw of unmetafy(text).split('\n')) {
    const line = pending.length === 0 ? raw.replace(/^: \d+:\d+;/, '') : raw;
    if (line.endsWith('\\') && !line.endsWith('\\\\')) {
      pending.push(line.slice(0, -1));
      continue;
    }
    pending.push(line);
    const entry = pending.join('\n');
    pending = [];
    if (entry.trim()) entries.push(entry);
  }
  if (pending.length) entries.push(pending.join('\n'));
  return entries;
}

/** Undoes zsh's byte escaping of a latin1-decoded file and decodes the result as UTF-8. */
function unmetafy(latin1: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < latin1.length; i++) {
    const code = latin1.charCodeAt(i) & 0xff;
    bytes.push(code === 0x83 && i + 1 < latin1.length ? (latin1.charCodeAt(++i) & 0xff) ^ 0x20 : code);
  }
  return Buffer.from(bytes).toString('utf8');
}

export interface HistorySource {
  /** Unique key; a source is imported once. */
  key: string;
  path: string;
  shell: ShellKind;
  parse: (text: string) => string[];
  /** Read the file as latin1 (one char per byte) instead of UTF-8, for formats that need the raw bytes. */
  binary?: boolean;
}

export function psReadLineSource(appData = process.env.APPDATA): HistorySource | null {
  if (!appData) return null;
  const path = join(appData, 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt');
  return { key: `psreadline:${path}`, path, shell: 'powershell', parse: parsePsReadLineHistory };
}

export function bashSource(path = join(homedir(), '.bash_history'), keyPrefix = 'bash'): HistorySource {
  return { key: `${keyPrefix}:${path}`, path, shell: 'bash', parse: parseBashHistory };
}

/** ~/.zsh_history, or $ZDOTDIR/.zsh_history when the user keeps their zsh files elsewhere. */
export function zshSource(path = join(process.env.ZDOTDIR || homedir(), '.zsh_history'), keyPrefix = 'zsh'): HistorySource {
  return { key: `${keyPrefix}:${path}`, path, shell: 'zsh', parse: parseZshHistory, binary: true };
}

/** Imports a history file once. Missing files are not an error; returns the number of entries stored. */
export async function importSource(store: HistoryStore, source: HistorySource, analyze?: Analyzer): Promise<number> {
  if (store.isImported(source.key)) return 0;
  let text: string;
  let endTime: number;
  try {
    [text, endTime] = await Promise.all([readFile(source.path, source.binary ? 'latin1' : 'utf8'), stat(source.path).then((s) => s.mtimeMs)]);
  } catch {
    return 0;
  }
  const entries = source.parse(text).slice(-MAX_IMPORT);
  return store.importEntries(source.key, source.shell, entries, Math.floor(endTime), analyze);
}
