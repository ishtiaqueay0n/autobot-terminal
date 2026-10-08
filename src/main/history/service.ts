import { join } from 'node:path';
import { debugLog } from '../debug';
import { envForRemote, type EnvRef } from '../kb/exec';
import type { CommandResult } from '../session';
import { historyKey } from '../../shared/shell';
import type { HistoryKey, Settings, ShellKind } from '../../shared/types';
import { bashSource, importSource, psReadLineSource, zshSource, type HistorySource } from './importers';
import { HistoryStore, type Analyzer } from './store';

/** Builds the habit analyzer for an environment (the completion engine knows the tools there). */
export type AnalyzerFactory = (env: EnvRef) => Analyzer;

/**
 * Connects the history store to terminal sessions: records finished commands, remembers each tab's last
 * command for sequence suggestions, answers ghost-text and ↑ queries, and imports existing shell history.
 * If the database cannot be opened, everything degrades to "no history" instead of breaking the terminal.
 */
export class HistoryService {
  private readonly lastId = new Map<number, number | null>();
  /** The history key `lastId` belongs to: a tab that moves to another machine starts a new sequence there. */
  private readonly lastKey = new Map<number, HistoryKey>();
  private readonly envs = new Map<number, EnvRef>();
  private analyzerFor: AnalyzerFactory | null = null;

  private constructor(
    readonly store: HistoryStore | null,
    private readonly settings: () => Settings,
  ) {}

  static open(file: string, settings: () => Settings): HistoryService {
    try {
      return new HistoryService(new HistoryStore(file), settings);
    } catch (err) {
      console.error(`[history] could not open ${file}; history is disabled:`, err);
      return new HistoryService(null, settings);
    }
  }

  /** Enables learning your habits (flags, values, subcommands) from recorded and imported commands. */
  setAnalyzer(factory: AnalyzerFactory): void {
    this.analyzerFor = factory;
  }

  startSession(sessionId: number, shell: ShellKind, env: EnvRef): void {
    this.envs.set(sessionId, env);
    // A new tab continues from the last command you ran anywhere in this shell.
    this.lastId.set(sessionId, this.guard(() => this.store?.latestId(shell) ?? null, null));
    this.lastKey.set(sessionId, shell);
  }

  endSession(sessionId: number): void {
    this.lastId.delete(sessionId);
    this.lastKey.delete(sessionId);
    this.envs.delete(sessionId);
  }

  /** Commands run on another machine are filed under that machine (and analyzed with what is known of it). */
  recordFinished(sessionId: number, shell: ShellKind, result: CommandResult): void {
    const key = historyKey(shell, result.remote);
    const env = result.remote ? envForRemote(result.remote) : this.envs.get(sessionId);
    const analyze = env && this.analyzerFor ? this.analyzerFor(env) : undefined;
    const id = this.guard(
      () =>
        this.store?.record(
          {
            shell: key,
            command: result.command,
            cwd: result.cwd,
            exitCode: result.exitCode,
            startedAt: result.startedAt,
            durationMs: result.durationMs,
            previousId: this.previousId(sessionId, key),
          },
          analyze,
        ) ?? null,
      null,
    );
    if (id !== null) {
      this.lastId.set(sessionId, id);
      this.lastKey.set(sessionId, key);
    }
  }

  private previousId(sessionId: number, key: HistoryKey): number | null {
    return this.lastKey.get(sessionId) === key ? (this.lastId.get(sessionId) ?? null) : null;
  }

  suggest(sessionId: number, shell: HistoryKey, text: string, cwd: string | null): string | null {
    if (!this.settings().ghostText) return null;
    return this.guard(
      () => this.store?.suggest({ shell, prefix: text, cwd, previousId: this.previousId(sessionId, shell) }) ?? null,
      null,
    );
  }

  recent(shell: HistoryKey): string[] {
    return this.guard(() => this.store?.recent(shell) ?? [], []);
  }

  topTools(shell: HistoryKey, limit: number): string[] {
    return this.guard(() => this.store?.topTools(shell, limit).map((t) => t.tool) ?? [], []);
  }

  /** Imports the history files this machine has for its local shells (once each). Returns true if new. */
  async importLocal(platform: NodeJS.Platform = process.platform): Promise<boolean> {
    if (platform === 'win32') {
      const ps = psReadLineSource();
      return ps ? this.importOnce(ps, { id: 'windows', kind: 'windows' }) : false;
    }
    const env: EnvRef = { id: 'linux', kind: 'linux' };
    const bash = await this.importOnce(bashSource(), env);
    const zsh = await this.importOnce(zshSource(), env);
    return bash || zsh;
  }

  /** Imports a WSL distro's ~/.bash_history or ~/.zsh_history once its shell reports the home folder. */
  async importWsl(env: EnvRef, home: string, shell: ShellKind = 'bash'): Promise<boolean> {
    const file = (name: string) => join(`\\\\wsl.localhost\\${env.distro}`, ...home.split('/').filter(Boolean), name);
    return shell === 'zsh'
      ? this.importOnce(zshSource(file('.zsh_history'), `wsl-zsh:${env.distro}`), env)
      : this.importOnce(bashSource(file('.bash_history'), `wsl-bash:${env.distro}`), env);
  }

  close(): void {
    this.guard(() => this.store?.close(), undefined);
  }

  private async importOnce(source: HistorySource, env: EnvRef): Promise<boolean> {
    if (!this.store || !this.settings().importHistory) return false;
    try {
      const started = performance.now();
      const n = await importSource(this.store, source, this.analyzerFor?.(env));
      if (n > 0) debugLog(`history: imported ${n} entries from ${source.path} in ${Math.round(performance.now() - started)} ms`);
      return n > 0;
    } catch (err) {
      console.error(`[history] import of ${source.path} failed:`, err);
      return false;
    }
  }

  private guard<T>(fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (err) {
      console.error('[history]', err);
      return fallback;
    }
  }
}
