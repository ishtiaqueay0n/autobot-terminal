import { basename } from 'node:path';
import { parseHelp } from '../../shared/help-parse';
import type { BundledKb } from './bundled';
import { debugLog } from '../debug';
import { runIn, type EnvRef } from './exec';
import type { Knowledge } from './knowledge';
import { describePowerShellCommands, listPowerShellCommands } from './powershell';
import { isDenied, resolveExecutable } from './resolve';
import type { KnowledgeStore } from './store';

/** A failed or empty attempt is not retried for this long (unless the tool's version changes). */
const RETRY_AFTER_MS = 7 * 86_400_000;
/** PowerShell's command list is refreshed this often. */
const LIST_MAX_AGE_MS = 7 * 86_400_000;

/**
 * Learns tools from the machine itself, in the background, one at a time:
 * - native tools: parses `tool --help` (and `tool sub --help` for subcommands you use), safely resolved;
 * - PowerShell: reads cmdlet parameters, aliases and allowed values through Get-Command.
 * Everything is stored in knowledge.db, so each tool is learned once per environment.
 */
export class Learner {
  private readonly queue: { key: string; job: () => Promise<void> }[] = [];
  private readonly queued = new Set<string>();
  private running = false;
  private readonly versionChecked = new Set<string>();
  private readonly psInFlight = new Map<string, Promise<void>>();
  private readonly psLists = new Map<string, Promise<string[]>>();

  constructor(
    private readonly store: KnowledgeStore,
    private readonly knowledge: Knowledge,
    private readonly bundled: BundledKb,
  ) {}

  /** Called after a command ran: learn its tool (and the subcommand used) if they are new. */
  noteCommand(env: EnvRef, tool: string, subcommand: string | null): void {
    if (!/^[\w.+-]+$/.test(tool) || isDenied(tool)) return;
    // Subcommand help only for tools without a bundled spec: some tools (git on Windows) open a browser
    // for "sub --help", and bundled specs already cover their subcommands well.
    if (subcommand && /^[a-z][\w-]*$/.test(subcommand) && !this.bundled.has(tool)) {
      this.enqueue(`${env.id}\0${tool}\0${subcommand}`, () => this.learnHelp(env, tool, [subcommand]), true);
    }
    // What you just ran goes ahead of background pre-fetching.
    this.enqueue(`${env.id}\0${tool}`, () => this.learnHelp(env, tool, []), true);
  }

  /** Learns the most-used tools ahead of time (after a history import). */
  prefetch(env: EnvRef, tools: string[]): void {
    for (const tool of tools) {
      if (/^[\w.+-]+$/.test(tool) && !isDenied(tool)) this.enqueue(`${env.id}\0${tool}`, () => this.learnHelp(env, tool, []));
    }
  }

  /** Cmdlet/function/alias names for a PowerShell executable, from cache or a background listing. */
  powerShellCommands(exe: string): Promise<string[]> {
    const key = `ps:${basename(exe).toLowerCase()}`;
    let pending = this.psLists.get(key);
    if (!pending) {
      pending = (async () => {
        const cached = this.store.commandList(key);
        if (cached && Date.now() - cached.updatedAt < LIST_MAX_AGE_MS) return cached.names;
        const listed = await listPowerShellCommands(exe);
        if (!listed) return cached?.names ?? [];
        this.store.putCommandList(key, listed.names, listed.version);
        debugLog(`kb: ${listed.names.length} PowerShell commands from ${exe}`);
        return listed.names;
      })();
      this.psLists.set(key, pending);
    }
    return pending;
  }

  /**
   * Makes sure the parameters of these PowerShell commands are known; resolves when they are (or when the
   * lookup failed). Commands already learned are skipped, so this is cheap after the first time.
   */
  ensurePowerShell(exe: string, names: string[]): Promise<void> {
    const missing = [...new Set(names.map((n) => n.toLowerCase()))].filter(
      (n) => /^[\w.-]+$/.test(n) && !this.store.get('windows', n, '') && !this.recentlyTried('windows', n, ''),
    );
    if (missing.length === 0) return Promise.resolve();
    const key = missing.sort().join(',');
    let pending = this.psInFlight.get(key);
    if (!pending) {
      pending = (async () => {
        const specs = await describePowerShellCommands(exe, missing);
        for (const name of missing) {
          const spec = specs.get(name);
          if (spec) this.store.put('windows', name, '', 'powershell', spec, null);
          this.store.recordAttempt('windows', name, '', Boolean(spec));
          this.knowledge.invalidate('windows', name);
        }
        debugLog(`kb: described ${specs.size}/${missing.length} PowerShell commands`);
      })().finally(() => this.psInFlight.delete(key));
      this.psInFlight.set(key, pending);
    }
    return pending;
  }

  private enqueue(key: string, job: () => Promise<void>, urgent = false): void {
    if (this.queued.has(key)) {
      // Already waiting: move it to the front if it became urgent.
      const i = this.queue.findIndex((q) => q.key === key);
      if (urgent && i > 0) this.queue.unshift(...this.queue.splice(i, 1));
      return;
    }
    this.queued.add(key);
    if (urgent) this.queue.unshift({ key, job });
    else this.queue.push({ key, job });
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const { key, job } = this.queue.shift()!;
        try {
          await job();
        } catch (err) {
          console.error('[kb] learning failed:', err);
        }
        this.queued.delete(key);
      }
    } finally {
      this.running = false;
    }
  }

  private recentlyTried(env: string, tool: string, path: string): boolean {
    const last = this.store.lastAttempt(env, tool, path);
    return Boolean(last && Date.now() - last.triedAt < RETRY_AFTER_MS);
  }

  private async learnHelp(env: EnvRef, tool: string, path: string[]): Promise<void> {
    const key = path.join(' ');
    const existing = this.store.get(env.id, tool, key);
    if (existing?.source === 'powershell') return;

    // Once per app run, see whether a learned tool was upgraded; if so, learn it again.
    if (existing && path.length === 0) {
      const checkKey = `${env.id}\0${tool}`;
      if (this.versionChecked.has(checkKey)) return;
      this.versionChecked.add(checkKey);
      const exe = await resolveExecutable(env, tool);
      if (!exe) return;
      const version = await this.version(env, exe);
      if (!version || version === existing.version) return;
      debugLog(`kb: ${tool} changed version (${existing.version} -> ${version}); re-learning`);
      this.store.forget(env.id, tool);
    } else if (existing || this.recentlyTried(env.id, tool, key)) {
      return;
    }

    const exe = await resolveExecutable(env, tool);
    if (!exe) {
      this.store.recordAttempt(env.id, tool, key, false);
      return;
    }
    const version = path.length === 0 ? await this.version(env, exe) : null;
    let spec = null;
    // Classic Windows tools (ipconfig, xcopy, tasklist ...) print their options for /? and have no --help.
    for (const flag of env.kind === 'windows' ? ['--help', '-h', '/?'] : ['--help', '-h']) {
      const res = await runIn(env, exe, [...path, flag], { timeoutMs: 5000 });
      const text = res.stdout.length >= res.stderr.length ? res.stdout : res.stderr;
      if (text.trim().length < 20) continue;
      const parsed = parseHelp(path.length ? path[path.length - 1] : tool, text);
      if (parsed.options?.length || parsed.subcommands?.length) {
        spec = parsed;
        break;
      }
    }
    this.store.recordAttempt(env.id, tool, key, spec !== null);
    if (!spec) return;
    this.store.put(env.id, tool, key, 'help', spec, version);
    this.knowledge.invalidate(env.id, tool);
    debugLog(
      `kb: learned ${tool}${key ? ` ${key}` : ''} in ${env.id}: ${spec.options?.length ?? 0} options, ${spec.subcommands?.length ?? 0} subcommands`,
    );
  }

  private async version(env: EnvRef, exe: string): Promise<string | null> {
    const res = await runIn(env, exe, ['--version'], { timeoutMs: 3000, maxBytes: 4000 });
    if (res.code !== 0 || res.timedOut) return null;
    const line = (res.stdout || res.stderr).trim().split(/\r?\n/)[0];
    return line ? line.slice(0, 120) : null;
  }
}
