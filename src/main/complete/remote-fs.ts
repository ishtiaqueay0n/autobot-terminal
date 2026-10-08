/** Looks at the disk of another machine (an ssh session) through the questions in rpc.ts. */
export interface RemoteFs {
  /** What is in a folder, or null when it cannot be read (or nothing could be asked). */
  list(dir: string): Promise<RemoteEntry[] | null>;
  /** What a path is. 'unknown' when nothing could be asked, so callers say nothing rather than guess. */
  kind(path: string): Promise<'dir' | 'file' | 'missing' | 'unknown'>;
}

export interface RemoteEntry {
  name: string;
  isDir: boolean;
}

/** How long an answer is reused: a command may change the disk, so the cache is also cleared at every prompt. */
const CACHE_MS = 15_000;

/** Questions go through `ask` (op "ls" or "stat", argument a path; null when unanswered); answers are cached. */
export class CachedRemoteFs implements RemoteFs {
  private readonly lists = new Map<string, { at: number; value: RemoteEntry[] | null }>();
  private readonly kinds = new Map<string, { at: number; value: 'dir' | 'file' | 'missing' | 'unknown' }>();

  constructor(private readonly ask: (op: 'ls' | 'stat', arg: string) => Promise<string | null>) {}

  /** The disk may have changed (a command ran). */
  clear(): void {
    this.lists.clear();
    this.kinds.clear();
  }

  async list(dir: string): Promise<RemoteEntry[] | null> {
    const hit = this.lists.get(dir);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const answer = await this.ask('ls', dir);
    const value = answer === null ? null : parseListing(answer);
    // Not remembered when nothing could be asked: the next keystroke may find the shell idle.
    if (answer !== null) this.lists.set(dir, { at: Date.now(), value });
    return value;
  }

  async kind(path: string): Promise<'dir' | 'file' | 'missing' | 'unknown'> {
    const hit = this.kinds.get(path);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const answer = await this.ask('stat', path);
    const value = answer === null ? 'unknown' : parseKind(answer);
    if (value !== 'unknown') this.kinds.set(path, { at: Date.now(), value });
    return value;
  }
}

/** The reply to `ls`: "ok" and one name per line (folders end in "/"), or "no". */
export function parseListing(answer: string): RemoteEntry[] | null {
  const lines = answer.split('\n');
  if (lines[0] !== 'ok') return null;
  const entries: RemoteEntry[] = [];
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const isDir = line.endsWith('/');
    entries.push({ name: isDir ? line.slice(0, -1) : line, isDir });
  }
  return entries;
}

/** The reply to `stat`: d (folder), f (anything else that exists) or - (nothing). */
export function parseKind(answer: string): 'dir' | 'file' | 'missing' | 'unknown' {
  switch (answer.trim()) {
    case 'd':
      return 'dir';
    case 'f':
      return 'file';
    case '-':
      return 'missing';
    default:
      return 'unknown';
  }
}
