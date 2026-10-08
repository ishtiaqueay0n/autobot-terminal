import { readdirSync } from 'node:fs';
import { delimiter } from 'node:path';

const MAX_AGE_MS = 5 * 60_000;
let cache: { at: number; names: string[] } | null = null;

/** Forgets the cached PATH listing (after something was installed). */
export function resetWindowsPathCommands(): void {
  cache = null;
}

/** Programs on the Windows PATH (by PATHEXT), without extensions, for command-name completion. */
export function windowsPathCommands(): string[] {
  if (cache && Date.now() - cache.at < MAX_AGE_MS) return cache.names;
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';').filter(Boolean);
  exts.push('.ps1');
  const seen = new Map<string, string>();
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      const dot = f.lastIndexOf('.');
      if (dot <= 0 || !exts.includes(f.slice(dot).toLowerCase())) continue;
      const name = f.slice(0, dot);
      const key = name.toLowerCase();
      if (!seen.has(key)) seen.set(key, name);
    }
  }
  cache = { at: Date.now(), names: [...seen.values()] };
  return cache.names;
}
