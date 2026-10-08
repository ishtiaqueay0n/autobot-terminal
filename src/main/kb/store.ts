import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { KbSource, KbSpec } from '../../shared/kb-types';
import type { AiNotes } from '../llm/tasks';

export interface LearnedEntry {
  spec: KbSpec;
  source: KbSource;
  version: string | null;
  learnedAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS learned (
  env TEXT NOT NULL,
  tool TEXT NOT NULL,
  path TEXT NOT NULL,
  source TEXT NOT NULL,
  spec TEXT NOT NULL,
  version TEXT,
  learned_at INTEGER NOT NULL,
  PRIMARY KEY (env, tool, path)
);
CREATE TABLE IF NOT EXISTS attempts (
  env TEXT NOT NULL,
  tool TEXT NOT NULL,
  path TEXT NOT NULL,
  tried_at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  PRIMARY KEY (env, tool, path)
);
CREATE TABLE IF NOT EXISTS command_lists (
  env TEXT PRIMARY KEY,
  names TEXT NOT NULL,
  version TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_notes (
  env TEXT NOT NULL,
  tool TEXT NOT NULL,
  notes TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (env, tool)
);
CREATE TABLE IF NOT EXISTS ai_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_usage (
  day TEXT PRIMARY KEY,
  requests INTEGER NOT NULL
);
`;

/**
 * What Autobot has learned on this machine (knowledge.db): specs parsed from local --help and PowerShell
 * introspection, per environment ("windows", "linux", "wsl:Ubuntu") because the installed tools differ.
 */
export class KnowledgeStore {
  private readonly db: DatabaseSync;
  private readonly stmt: Record<string, StatementSync>;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
    this.stmt = {
      get: this.db.prepare('SELECT spec, source, version, learned_at FROM learned WHERE env = ? AND tool = ? AND path = ?'),
      put: this.db.prepare(`
        INSERT INTO learned (env, tool, path, source, spec, version, learned_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (env, tool, path) DO UPDATE SET source = excluded.source, spec = excluded.spec,
          version = excluded.version, learned_at = excluded.learned_at`),
      dropTool: this.db.prepare('DELETE FROM learned WHERE env = ? AND tool = ?'),
      attempt: this.db.prepare(`
        INSERT INTO attempts (env, tool, path, tried_at, ok) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (env, tool, path) DO UPDATE SET tried_at = excluded.tried_at, ok = excluded.ok`),
      lastAttempt: this.db.prepare('SELECT tried_at, ok FROM attempts WHERE env = ? AND tool = ? AND path = ?'),
      getList: this.db.prepare('SELECT names, version, updated_at FROM command_lists WHERE env = ?'),
      putList: this.db.prepare(`
        INSERT INTO command_lists (env, names, version, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (env) DO UPDATE SET names = excluded.names, version = excluded.version, updated_at = excluded.updated_at`),
      learnedTools: this.db.prepare("SELECT DISTINCT tool FROM learned WHERE env = ? AND path = ''"),
      getNotes: this.db.prepare('SELECT notes, model, created_at FROM ai_notes WHERE env = ? AND tool = ?'),
      putNotes: this.db.prepare(`
        INSERT INTO ai_notes (env, tool, notes, model, created_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (env, tool) DO UPDATE SET notes = excluded.notes, model = excluded.model, created_at = excluded.created_at`),
      getCache: this.db.prepare('SELECT value, created_at FROM ai_cache WHERE key = ?'),
      putCache: this.db.prepare(`
        INSERT INTO ai_cache (key, value, created_at) VALUES (?, ?, ?)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`),
      getUsage: this.db.prepare('SELECT requests FROM ai_usage WHERE day = ?'),
      addUsage: this.db.prepare(`
        INSERT INTO ai_usage (day, requests) VALUES (?, 1)
        ON CONFLICT (day) DO UPDATE SET requests = requests + 1`),
    };
  }

  get(env: string, tool: string, path: string): LearnedEntry | null {
    const row = this.stmt.get.get(env, tool, path) as
      | { spec: string; source: KbSource; version: string | null; learned_at: number }
      | undefined;
    if (!row) return null;
    try {
      return { spec: JSON.parse(row.spec) as KbSpec, source: row.source, version: row.version, learnedAt: row.learned_at };
    } catch {
      return null;
    }
  }

  put(env: string, tool: string, path: string, source: KbSource, spec: KbSpec, version: string | null): void {
    this.stmt.put.run(env, tool, path, source, JSON.stringify(spec), version, Date.now());
  }

  /** Forgets everything learned about a tool (e.g. after its version changed). */
  forget(env: string, tool: string): void {
    this.stmt.dropTool.run(env, tool);
  }

  recordAttempt(env: string, tool: string, path: string, ok: boolean): void {
    this.stmt.attempt.run(env, tool, path, Date.now(), ok ? 1 : 0);
  }

  lastAttempt(env: string, tool: string, path: string): { triedAt: number; ok: boolean } | null {
    const row = this.stmt.lastAttempt.get(env, tool, path) as { tried_at: number; ok: number } | undefined;
    return row ? { triedAt: row.tried_at, ok: row.ok === 1 } : null;
  }

  commandList(env: string): { names: string[]; version: string | null; updatedAt: number } | null {
    const row = this.stmt.getList.get(env) as { names: string; version: string | null; updated_at: number } | undefined;
    return row ? { names: JSON.parse(row.names) as string[], version: row.version, updatedAt: row.updated_at } : null;
  }

  putCommandList(env: string, names: string[], version: string | null): void {
    this.stmt.putList.run(env, JSON.stringify(names), version, Date.now());
  }

  learnedTools(env: string): string[] {
    return (this.stmt.learnedTools.all(env) as { tool: string }[]).map((r) => r.tool);
  }

  /** What the AI added about a tool (see llm/tasks.ts), with when and by which model. */
  aiNotes(env: string, tool: string): { notes: AiNotes; model: string; createdAt: number } | null {
    const row = this.stmt.getNotes.get(env, tool) as { notes: string; model: string; created_at: number } | undefined;
    if (!row) return null;
    try {
      return { notes: JSON.parse(row.notes) as AiNotes, model: row.model, createdAt: row.created_at };
    } catch {
      return null;
    }
  }

  putAiNotes(env: string, tool: string, notes: AiNotes, model: string): void {
    this.stmt.putNotes.run(env, tool, JSON.stringify(notes), model, Date.now());
  }

  /** A cached AI answer (panel notes), or null when missing or older than `maxAgeMs`. */
  aiCached(key: string, maxAgeMs: number): string | null {
    const row = this.stmt.getCache.get(key) as { value: string; created_at: number } | undefined;
    return row && Date.now() - row.created_at < maxAgeMs ? row.value : null;
  }

  putAiCache(key: string, value: string): void {
    this.stmt.putCache.run(key, value, Date.now());
  }

  /** Background AI requests made on a day ("2026-10-04"). */
  aiRequests(day: string): number {
    return (this.stmt.getUsage.get(day) as { requests: number } | undefined)?.requests ?? 0;
  }

  countAiRequest(day: string): void {
    this.stmt.addUsage.run(day);
  }

  close(): void {
    this.db.close();
  }
}
