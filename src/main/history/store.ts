import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { redact } from '../../shared/redact';
import { foldsCase } from '../../shared/shell';
import type { HistoryKey } from '../../shared/types';

export interface FinishedCommand {
  shell: HistoryKey;
  command: string;
  cwd: string | null;
  exitCode: number;
  startedAt: number;
  durationMs: number;
  /** Command id of the command run just before this one in the same tab, for sequence learning. */
  previousId: number | null;
}

/** What a command line says about your habits with a tool (from the completion walker). */
export interface CommandAnalysis {
  tool: string;
  usage: { slot: string; value: string }[];
}

/** Analyzes a stored (already redacted) command line: one entry per command in it whose tool is known. */
export type Analyzer = (shell: HistoryKey, command: string) => CommandAnalysis[];

export interface SuggestQuery {
  shell: HistoryKey;
  /** Text typed so far. Empty asks for the most likely next command after previousId. */
  prefix: string;
  cwd: string | null;
  previousId: number | null;
  now?: number;
}

interface CandidateRow {
  id: number;
  command: string;
  run_count: number;
  last_used: number;
}

/** Below this many observations, "what usually comes next" is a guess, not a habit. */
const MIN_TRANSITIONS = 2;
const MAX_CANDIDATES = 200;
const DAY_MS = 86_400_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS commands (
  id INTEGER PRIMARY KEY,
  shell TEXT NOT NULL,
  command TEXT NOT NULL,
  command_fold TEXT GENERATED ALWAYS AS (lower(command)) STORED,
  run_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  last_exit INTEGER,
  last_used INTEGER NOT NULL,
  redacted INTEGER NOT NULL DEFAULT 0,
  UNIQUE (shell, command)
);
CREATE INDEX IF NOT EXISTS commands_fold ON commands (shell, command_fold);
CREATE INDEX IF NOT EXISTS commands_recent ON commands (shell, last_used);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  command_id INTEGER NOT NULL REFERENCES commands (id),
  cwd TEXT,
  exit_code INTEGER,
  started_at INTEGER NOT NULL,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS runs_cwd ON runs (cwd, command_id);
CREATE TABLE IF NOT EXISTS transitions (
  prev_id INTEGER NOT NULL,
  next_id INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  last_used INTEGER NOT NULL,
  PRIMARY KEY (prev_id, next_id)
);
CREATE TABLE IF NOT EXISTS usage (
  shell TEXT NOT NULL,
  tool TEXT NOT NULL,
  slot TEXT NOT NULL,
  value TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  last_used INTEGER NOT NULL,
  PRIMARY KEY (shell, tool, slot, value)
);
CREATE TABLE IF NOT EXISTS imports (
  source TEXT PRIMARY KEY,
  imported_at INTEGER NOT NULL,
  entries INTEGER NOT NULL
);
`;

/**
 * Command history in SQLite (node:sqlite, built into Electron's Node). Every query is synchronous and
 * indexed; suggestions are answered in well under a millisecond for typical history sizes.
 *
 * Ranking for a typed prefix: the prefix filters, then commands run in the same folder win outright, then a
 * mix of frequency and recency decides. Commands whose last run failed and commands that needed redaction are
 * never suggested as ghost text.
 */
export class HistoryStore {
  private readonly db: DatabaseSync;
  private readonly stmt: Record<string, StatementSync>;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.stmt = {
      upsert: this.db.prepare(`
        INSERT INTO commands (shell, command, run_count, fail_count, last_exit, last_used, redacted)
        VALUES (:shell, :command, 1, :failed, :exit, :used, :redacted)
        ON CONFLICT (shell, command) DO UPDATE SET
          run_count = run_count + 1,
          fail_count = fail_count + excluded.fail_count,
          last_exit = CASE WHEN excluded.last_used >= last_used THEN excluded.last_exit ELSE last_exit END,
          last_used = max(last_used, excluded.last_used)
        RETURNING id`),
      run: this.db.prepare(
        'INSERT INTO runs (command_id, cwd, exit_code, started_at, duration_ms) VALUES (?, ?, ?, ?, ?)',
      ),
      transition: this.db.prepare(`
        INSERT INTO transitions (prev_id, next_id, count, last_used) VALUES (?, ?, 1, ?)
        ON CONFLICT (prev_id, next_id) DO UPDATE SET count = count + 1, last_used = max(last_used, excluded.last_used)`),
      prefixExact: this.db.prepare(`
        SELECT id, command, run_count, last_used FROM commands
        WHERE shell = ? AND command >= ? AND command < ? AND command <> ?
          AND redacted = 0 AND (last_exit IS NULL OR last_exit = 0)
        ORDER BY last_used DESC LIMIT ${MAX_CANDIDATES}`),
      prefixFold: this.db.prepare(`
        SELECT id, command, run_count, last_used FROM commands
        WHERE shell = ? AND command_fold >= ? AND command_fold < ? AND command_fold <> ?
          AND redacted = 0 AND (last_exit IS NULL OR last_exit = 0)
        ORDER BY last_used DESC LIMIT ${MAX_CANDIDATES}`),
      next: this.db.prepare(`
        SELECT c.command FROM transitions t JOIN commands c ON c.id = t.next_id
        WHERE t.prev_id = ? AND t.count >= ${MIN_TRANSITIONS}
          AND c.redacted = 0 AND (c.last_exit IS NULL OR c.last_exit = 0)
        ORDER BY t.count DESC, t.last_used DESC LIMIT 1`),
      recent: this.db.prepare(
        'SELECT command FROM commands WHERE shell = ? AND redacted = 0 ORDER BY last_used DESC LIMIT ?',
      ),
      imported: this.db.prepare('SELECT 1 FROM imports WHERE source = ?'),
      markImported: this.db.prepare('INSERT INTO imports (source, imported_at, entries) VALUES (?, ?, ?)'),
      latest: this.db.prepare('SELECT id FROM commands WHERE shell = ? ORDER BY last_used DESC LIMIT 1'),
      usage: this.db.prepare(`
        INSERT INTO usage (shell, tool, slot, value, count, last_used) VALUES (?, ?, ?, ?, 1, ?)
        ON CONFLICT (shell, tool, slot, value) DO UPDATE SET count = count + 1, last_used = max(last_used, excluded.last_used)`),
      usageFor: this.db.prepare(
        'SELECT value, count FROM usage WHERE shell = ? AND tool = ? AND slot = ? ORDER BY count DESC, last_used DESC LIMIT ?',
      ),
      top: this.db.prepare('SELECT command, run_count FROM commands WHERE shell = ? ORDER BY run_count DESC LIMIT 2000'),
    };
  }

  close(): void {
    this.db.close();
  }

  /**
   * Stores a finished command. Returns its id (for sequence learning), or null when it is not stored:
   * empty, or starting with a space (the "keep this out of history" convention).
   */
  record(entry: FinishedCommand, analyze?: Analyzer): number | null {
    if (!entry.command.trim() || entry.command.startsWith(' ')) return null;
    const { text, changed } = redact(entry.command.trimEnd());
    let id: number | null = null;
    this.transaction(() => {
      id = this.upsert(entry.shell, text, entry.exitCode, entry.startedAt, changed);
      this.stmt.run.run(id, entry.cwd, entry.exitCode, entry.startedAt, entry.durationMs);
      if (entry.previousId !== null && entry.previousId !== id) {
        this.stmt.transition.run(entry.previousId, id, entry.startedAt);
      }
      // Habits are learned from successful, secret-free commands only.
      if (analyze && !changed && entry.exitCode === 0) this.recordUsage(entry.shell, analyze(entry.shell, text), entry.startedAt);
    });
    return id;
  }

  /** How often each value was used in a slot (subcommand, option, option value ...) for a tool, most used first. */
  usage(shell: HistoryKey, tool: string, slot: string, limit = 50): Map<string, number> {
    const rows = this.stmt.usageFor.all(shell, tool, slot, limit) as { value: string; count: number }[];
    return new Map(rows.map((r) => [r.value, r.count]));
  }

  /**
   * True when a command starting with `name` once ran successfully in Autobot: an alias or function defined
   * later in a session is not in the startup command list, but it worked, so it exists.
   */
  usedSuccessfully(shell: HistoryKey, name: string): boolean {
    const fold = foldsCase(shell);
    const key = fold ? name.toLowerCase() : name;
    const col = fold ? 'command_fold' : 'command';
    const row = this.db
      .prepare(`SELECT 1 FROM commands WHERE shell = ? AND last_exit = 0 AND (${col} = ? OR (${col} >= ? AND ${col} < ?)) LIMIT 1`)
      .get(shell, key, `${key} `, `${key} \u{10FFFF}`);
    return row !== undefined;
  }

  /** Tools you run most, by the first word of your commands. */
  topTools(shell: HistoryKey, limit = 30): { tool: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const r of this.stmt.top.all(shell) as { command: string; run_count: number }[]) {
      const first = /^\s*(?:sudo\s+)?([\w.+-]+)/.exec(r.command)?.[1];
      if (first) counts.set(first, (counts.get(first) ?? 0) + r.run_count);
    }
    return [...counts.entries()]
      .map(([tool, count]) => ({ tool, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  private recordUsage(shell: HistoryKey, analyses: CommandAnalysis[], at: number): void {
    for (const a of analyses) {
      for (const u of a.usage) if (u.value.length <= 200) this.stmt.usage.run(shell, a.tool, u.slot, u.value, at);
    }
  }

  /** Best ghost-text candidate: the full command, or null. */
  suggest(q: SuggestQuery): string | null {
    if (!q.prefix) {
      if (q.previousId === null) return null;
      const row = this.stmt.next.get(q.previousId) as { command: string } | undefined;
      return row?.command ?? null;
    }
    // Commands are single-line for ghost text; PowerShell matches case-insensitively, like the shell.
    const fold = foldsCase(q.shell);
    const key = fold ? q.prefix.toLowerCase() : q.prefix;
    const stmt = fold ? this.stmt.prefixFold : this.stmt.prefixExact;
    const rows = stmt.all(q.shell, key, `${key}\u{10FFFF}`, key) as unknown as CandidateRow[];
    const candidates = rows.filter((r) => !r.command.includes('\n'));
    if (candidates.length === 0) return null;

    const cwdRuns = this.cwdRuns(q.cwd, candidates.map((r) => r.id));
    const now = q.now ?? Date.now();
    let best: CandidateRow | null = null;
    let bestScore = -Infinity;
    for (const row of candidates) {
      const score = scoreCandidate(row, cwdRuns.get(row.id) ?? 0, now);
      if (score > bestScore) {
        best = row;
        bestScore = score;
      }
    }
    return best?.command ?? null;
  }

  /** Most recent distinct commands, newest first (for ↑/↓). Includes failed commands, not redacted ones. */
  recent(shell: HistoryKey, limit = 500): string[] {
    return (this.stmt.recent.all(shell, limit) as { command: string }[]).map((r) => r.command);
  }

  /** Id of the newest command for a shell; seeds sequence suggestions in a fresh tab. */
  latestId(shell: HistoryKey): number | null {
    return (this.stmt.latest.get(shell) as { id: number } | undefined)?.id ?? null;
  }

  isImported(source: string): boolean {
    return this.stmt.imported.get(source) !== undefined;
  }

  /**
   * Imports another shell's history file once. Entries are oldest first; they get increasing timestamps
   * ending at `endTime` so recency ordering matches the file, and consecutive entries feed the sequence
   * table. Exit codes are unknown, so imported commands count as successful until they fail here.
   */
  importEntries(source: string, shell: HistoryKey, entries: string[], endTime: number, analyze?: Analyzer): number {
    if (this.isImported(source)) return 0;
    let stored = 0;
    this.transaction(() => {
      let previous: number | null = null;
      entries.forEach((raw, i) => {
        if (!raw.trim() || raw.startsWith(' ')) return;
        const { text, changed } = redact(raw.trimEnd());
        const used = endTime - (entries.length - i);
        const id = this.upsert(shell, text, null, used, changed);
        if (previous !== null && previous !== id) this.stmt.transition.run(previous, id, used);
        if (analyze && !changed) this.recordUsage(shell, analyze(shell, text), used);
        previous = id;
        stored++;
      });
      this.stmt.markImported.run(source, Date.now(), stored);
    });
    return stored;
  }

  private upsert(shell: HistoryKey, command: string, exitCode: number | null, used: number, redacted: boolean): number {
    const row = this.stmt.upsert.get({
      shell,
      command,
      failed: exitCode !== null && exitCode !== 0 ? 1 : 0,
      exit: exitCode,
      used,
      redacted: redacted ? 1 : 0,
    }) as { id: number };
    return row.id;
  }

  private cwdRuns(cwd: string | null, ids: number[]): Map<number, number> {
    const counts = new Map<number, number>();
    if (!cwd || ids.length === 0) return counts;
    const rows = this.db
      .prepare(
        `SELECT command_id AS id, COUNT(*) AS n FROM runs WHERE cwd = ? AND command_id IN (${ids.map(() => '?').join(',')}) GROUP BY command_id`,
      )
      .all(cwd, ...ids) as { id: number; n: number }[];
    for (const r of rows) counts.set(r.id, r.n);
    return counts;
  }

  private transaction(fn: () => void): void {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

/**
 * Strict tiers, as agreed in the design: anything run in this folder beats anything that was not. Within a
 * tier, more runs here, frequency (log scale, so a command run 100 times does not bury everything) and
 * recency (one-week decay) are blended.
 */
export function scoreCandidate(row: { run_count: number; last_used: number }, sameCwdRuns: number, now: number): number {
  const folderTier = sameCwdRuns > 0 ? 100 : 0;
  const folderRuns = Math.log2(1 + sameCwdRuns);
  const frequency = Math.log2(1 + row.run_count);
  const ageDays = Math.max(0, now - row.last_used) / DAY_MS;
  const recency = 3 * Math.exp(-ageDays / 7);
  return folderTier + folderRuns + frequency + recency;
}
