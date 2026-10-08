import { existsSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { closest } from '../shared/fuzzy';
import { redact, redactOutput } from '../shared/redact';
import { baseShell, foldsCase } from '../shared/shell';
import { contextAt, splitCommands, toolName } from '../shared/tokenize';
import type {
  AiExplainResult,
  AiFixResult,
  CompletionReason,
  CompletionResult,
  Diagnostic,
  FixSuggestion,
  RemoteContext,
  SessionEvent,
  Settings,
  ShellKind,
} from '../shared/types';
import { Checker, type CheckSession } from './check/checker';
import { suggestFix } from './check/fixes';
import { osName, packageManager, rememberOsRelease } from './check/packages';
import { CompletionEngine, type CompletionSession } from './complete/engine';
import { Helpers } from './complete/helpers';
import { CachedRemoteFs } from './complete/remote-fs';
import { debugLog } from './debug';
import { isHookFile, isPlainHome } from './hook-files';
import type { HistoryService } from './history/service';
import { BundledKb } from './kb/bundled';
import { CMD_BUILTIN_NAMES } from './kb/cmd-builtins';
import { resetWindowsPathCommands, windowsPathCommands } from './kb/commands';
import { envForProfile, envForRemote, hostPath, runIn, type EnvRef } from './kb/exec';
import { Knowledge } from './kb/knowledge';
import { Learner } from './kb/learn';
import { resolveExecutable } from './kb/resolve';
import { KnowledgeStore } from './kb/store';
import { AiService } from './llm/ai';
import type { KeyStore } from './llm/keystore';
import type { ResolvedProfile } from './profiles';
import type { CommandResult, PtySession } from './session';

/** What is known about the machine at the other end of an ssh session (only what its shell reported). */
interface RemoteFacts {
  context: RemoteContext;
  env: EnvRef;
  home: string | null;
  commands: string[];
  variables: string[];
  /** Folder listings and path lookups, asked of the remote shell. */
  fs: CachedRemoteFs;
}

/** The remote hook's reports that arrive before its first prompt says which machine they are about. */
interface StagedRemote {
  home: string | null;
  commands: string[];
  variables: string[];
  os: string | null;
}

const b64 = (text: string): string => Buffer.from(text, 'base64').toString('utf8');
const nameList = (text: string): string[] => [...new Set(text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))];

interface SessionFacts {
  profile: ResolvedProfile;
  env: EnvRef;
  home: string | null;
  /** Names reported by the shell hook: compgen -c (bash) or aliases + functions (PowerShell). */
  commands: string[];
  /** The hook's command list has arrived (until then, unknown-command checks are skipped). */
  commandsLoaded: boolean;
  variables: string[];
  /** The shell has shown its first prompt. */
  ready: boolean;
  /** The last command that failed in this tab, until one succeeds (for Ctrl+.). */
  lastFailure: CommandResult | null;
  /** Set while the tab shows the prompt of a shell on another machine (an ssh session). */
  remote: RemoteFacts | null;
  staged: StagedRemote | null;
  /** Asks the remote shell something (see rpc.ts); set once the tab's session exists. */
  ask: (op: 'ls' | 'stat', arg: string) => Promise<string | null>;
}

/** Output lines sent with a Ctrl+. request. */
const FIX_OUTPUT_LINES = 50;
const FIX_OUTPUT_CHARS = 6000;

/** After one of these succeeds, new commands may exist: the command list is refreshed. */
const INSTALLERS = new Set([
  'apt', 'apt-get', 'dnf', 'yum', 'zypper', 'pacman', 'snap', 'flatpak', 'pip', 'pip3', 'pipx', 'npm', 'pnpm', 'yarn',
  'cargo', 'go', 'gem', 'brew', 'winget', 'choco', 'scoop', 'install-module', 'install-package', 'install-psresource',
]);

/**
 * The assistant side of the terminal: knowledge base, background learning, live helpers and completion.
 * One instance for the app; tabs register with startSession and feed it their shell events.
 */
export class Assistant {
  /** Called with a WSL distro name when a bash tab there reports that zsh is installed. */
  onWslZsh: ((distro: string) => void) | null = null;
  readonly engine: CompletionEngine;
  readonly ai: AiService;
  private readonly checker: Checker;
  private readonly learner: Learner | null;
  private readonly knowledgeStore: KnowledgeStore | null;
  private readonly sessions = new Map<number, SessionFacts>();
  /** PowerShell cmdlet/function/alias names per executable, once the background listing finished. */
  private readonly psCommands = new Map<string, string[]>();

  constructor(
    kbDir: string,
    userData: string,
    private readonly settings: () => Settings,
    private readonly history: HistoryService,
    private readonly powershellExe: string | null,
    keys: KeyStore,
  ) {
    const bundled = new BundledKb(kbDir);
    let store: KnowledgeStore | null = null;
    try {
      store = new KnowledgeStore(join(userData, 'knowledge.db'));
    } catch (err) {
      console.error('[kb] knowledge.db could not be opened; learning is disabled:', err);
    }
    this.knowledgeStore = store;
    const knowledge = new Knowledge(bundled, store);
    this.learner = store ? new Learner(store, knowledge, bundled) : null;
    const helpers = new Helpers((tool) => this.settings().networkHelpers.includes(tool));
    this.engine = new CompletionEngine({ knowledge, helpers, history: () => history.store });
    this.checker = new Checker({ source: (env, shell) => this.engine.source(env, shell), knowledge, history: () => history.store });
    history.setAnalyzer((env) => (key, line) => this.engine.analyze(env, baseShell(key), line));
    this.ai = new AiService({ settings, keys, store, knowledge, resolve: resolveExecutable });
  }

  startSession(id: number, profile: ResolvedProfile): void {
    this.sessions.set(id, {
      profile,
      env: envForProfile(profile),
      home: null,
      commands: [],
      commandsLoaded: profile.kind === 'cmd',
      variables: [],
      ready: false,
      lastFailure: null,
      remote: null,
      staged: null,
      ask: () => Promise.resolve(null),
    });
  }

  /** Connects a tab to the function that asks its shell questions (the session is created after startSession). */
  bindSession(id: number, ask: (op: 'ls' | 'stat', arg: string) => Promise<string | null>): void {
    const facts = this.sessions.get(id);
    if (facts) facts.ask = ask;
  }

  endSession(id: number): void {
    this.sessions.delete(id);
  }

  /** Shell properties from the hook: home folder, and the files listing command and variable names. */
  onEvents(id: number, events: SessionEvent[]): void {
    const facts = this.sessions.get(id);
    if (!facts) return;
    for (const ev of events) {
      if (ev.type === 'prompt') this.promptArrived(facts, ev.remote);
      if (ev.type === 'prompt' && !facts.ready) {
        // Background work starts only once the shell is up: starting another console process while
        // ConPTY creates the tab's console stalls that for seconds.
        facts.ready = true;
        if (facts.profile.kind === 'powershell') void this.loadPowerShellCommands(facts.profile.executable);
      }
      if (ev.type !== 'property') continue;
      if (ev.key.startsWith('Remote')) {
        this.stageRemote(facts, ev.key, ev.value);
      } else if (ev.key === 'Home') {
        facts.home = ev.value;
        if (facts.env.kind === 'wsl' && isPlainHome(ev.value)) void this.afterWslHome(facts.env, ev.value, facts.profile.kind);
      } else if (ev.key === 'Zsh') {
        // A bash tab in a WSL distro found zsh there: offer a zsh tab for it from the next start on.
        if (facts.env.kind === 'wsl' && facts.env.distro) this.onWslZsh?.(facts.env.distro);
      } else if (ev.key === 'Commands' || ev.key === 'Variables') {
        void this.readNameFile(facts, ev.value).then((names) => {
          if (ev.key === 'Commands') {
            facts.commands = names;
            facts.commandsLoaded = names.length > 0;
          } else facts.variables = names;
        });
      }
    }
  }

  /** A prompt arrived: say which machine it belongs to (the remote hook reports its details just before the first one). */
  private promptArrived(facts: SessionFacts, remote: RemoteContext | undefined): void {
    if (!remote) {
      facts.remote = null;
      facts.staged = null;
      return;
    }
    const fs = () => new CachedRemoteFs((op, arg) => facts.ask(op, arg));
    const staged = facts.staged;
    facts.staged = null;
    if (staged) {
      const env = envForRemote(remote);
      if (staged.os) rememberOsRelease(env, staged.os);
      facts.remote = { context: remote, env, home: staged.home, commands: staged.commands, variables: staged.variables, fs: fs() };
    } else if (facts.remote?.context.host === remote.host) {
      facts.remote.context = remote;
      facts.remote.fs.clear(); // a command may have changed the disk
    } else {
      facts.remote = { context: remote, env: envForRemote(remote), home: null, commands: [], variables: [], fs: fs() };
    }
  }

  private stageRemote(facts: SessionFacts, key: string, value: string): void {
    const staged = (facts.staged ??= { home: null, commands: [], variables: [], os: null });
    try {
      if (key === 'RemoteHome') staged.home = value;
      else if (key === 'RemoteCommands') staged.commands = nameList(b64(value));
      else if (key === 'RemoteVariables') staged.variables = nameList(b64(value));
      else if (key === 'RemoteOs') staged.os = b64(value);
    } catch {
      // A garbled report is the same as none.
    }
  }

  /**
   * What the tab's shell is: the one on the other machine while an ssh session shows its prompt (nothing here
   * touches this machine's disk or runs programs for it), otherwise the local shell.
   */
  private view(facts: SessionFacts, on: RemoteContext | null): { shell: ShellKind; env: EnvRef; home: string | null; remote: RemoteFacts | null } {
    const r = on && facts.remote?.context.host === on.host ? facts.remote : null;
    return r
      ? { shell: r.context.shell, env: r.env, home: r.home, remote: r }
      : { shell: facts.profile.kind, env: facts.env, home: facts.home, remote: null };
  }

  /**
   * After a command ran: learn the tools it used, refresh the command list after installs, and work out a
   * fix when it failed (delivered through `onFix`, shortly after the prompt).
   */
  commandFinished(id: number, result: CommandResult, onFix: (fix: FixSuggestion) => void): void {
    const facts = this.sessions.get(id);
    if (!facts) return;
    // A command run over ssh belongs to that machine. Nothing is learned from it here, but its failures get fixes.
    const v = this.view(facts, result.remote ?? null);
    if (result.remote && !v.remote) return;
    const shell = v.shell;
    const tools: string[] = [];
    for (const part of splitCommands(result.command, shell)) {
      const ctx = contextAt(part, part.length, shell);
      const words = ctx.words.filter((w) => w.value);
      const cmd = words[ctx.commandIndex]?.value;
      if (!cmd) continue;
      const tool = toolName(cmd, shell);
      tools.push(tool);
      if (!this.learner || result.exitCode === 127 || v.remote) continue;
      const sub = words.slice(ctx.commandIndex + 1).find((w) => !w.value.startsWith('-'))?.value ?? null;
      // PowerShell metadata comes from Get-Command (nothing is run); --help learning can be turned off.
      if (shell === 'powershell' && this.isPowerShellCommand(facts, tool)) {
        void this.learner.ensurePowerShell(facts.profile.executable, [tool]);
      } else if (this.settings().learnTools) {
        this.learner.noteCommand(facts.env, tool, sub);
      }
    }

    if (result.exitCode === 0) {
      facts.lastFailure = null;
      // Tools that just worked are real and in use: worth describing (only names are sent).
      if (!v.remote) for (const tool of tools) if (this.aiMayDescribe(facts, tool)) this.ai.noteTool(facts.env, shell, tool);
    } else if (result.exitCode !== 130) {
      facts.lastFailure = result;
    }

    if (!v.remote && result.exitCode === 0 && tools.some((t) => INSTALLERS.has(t.toLowerCase()))) void this.refreshCommands(facts);
    if (result.exitCode !== 0 && result.exitCode !== 130 && this.settings().errorChecks) {
      void this.computeFix(facts, v, result).then((fix) => fix && onFix(fix));
    }
  }

  /** Ctrl+.: asks the AI about the tab's last failed command (redacted: secrets masked, home as ~). */
  aiFix(id: number): Promise<AiFixResult> {
    const facts = this.sessions.get(id);
    const failed = facts?.lastFailure;
    if (!facts || !failed) return Promise.resolve({ ok: false, message: 'No failed command to fix in this tab.' });
    const v = this.view(facts, failed.remote ?? null);
    const outLines = redactOutput(failed.output, v.home).split(/\r?\n/);
    while (outLines.length && !outLines[outLines.length - 1].trim()) outLines.pop();
    const output = outLines.slice(-FIX_OUTPUT_LINES).join('\n').slice(-FIX_OUTPUT_CHARS);
    return this.ai.fix({
      command: redact(failed.command).text,
      exitCode: failed.exitCode,
      output,
      shell: v.shell,
      os: osName(v.env),
      packageManager: packageManager(v.env),
    });
  }

  /** AI notes about the command at the cursor, for the Ctrl+Space panel (when turned on). */
  aiExplain(session: PtySession, text: string, cursor: number): Promise<AiExplainResult> {
    const facts = this.sessions.get(session.id);
    if (!facts) return Promise.resolve({ ok: false, message: 'This tab is closed.' });
    if (!this.settings().llmPanel) return Promise.resolve({ ok: false, message: 'The AI panel section is turned off.' });
    if (facts.remote) return Promise.resolve({ ok: false, message: 'AI notes are not available inside ssh sessions.' });
    const at = this.engine.commandAt(facts.env, facts.profile.kind, text, cursor);
    if (!at || !/^[\w.+-]+$/.test(at.tool)) return Promise.resolve({ ok: false, message: 'Type a command to get AI notes about it.' });
    return this.ai.explain(facts.env.id, {
      tool: at.tool,
      path: at.path,
      shell: facts.profile.kind,
      os: osName(facts.env),
      knownOptions: at.options,
    });
  }

  /**
   * Only programs and built-in PowerShell commands are described: names of your own functions and
   * aliases (PowerShell lists them separately) stay on this machine.
   */
  private aiMayDescribe(facts: SessionFacts, tool: string): boolean {
    if (facts.profile.kind !== 'powershell' || !this.isPowerShellCommand(facts, tool)) return true;
    const builtIn = this.psCommands.get(facts.profile.executable);
    return Boolean(builtIn?.some((n) => n.toLowerCase() === tool));
  }

  /** Problems in a command line, for underlines while typing (empty when checks are turned off). */
  check(session: PtySession, text: string, cursor: number, submit: boolean): Promise<Diagnostic[]> {
    const facts = this.sessions.get(session.id);
    if (!facts || !this.settings().errorChecks) return Promise.resolve([]);
    return this.checker.check(this.checkSession(facts, this.view(facts, facts.remote?.context ?? null), session.currentCwd), text, cursor, submit);
  }

  private checkSession(facts: SessionFacts, v: ReturnType<Assistant['view']>, cwd: string | null): CheckSession {
    return { shell: v.shell, env: v.env, cwd, home: v.home, commands: () => this.commandList(facts, v), remoteFs: v.remote?.fs };
  }

  /** Every command name the tab's shell can run, or null while that is not known yet. */
  private commandList(facts: SessionFacts, v: ReturnType<Assistant['view']>): string[] | null {
    if (v.remote) return v.remote.commands.length > 0 ? v.remote.commands : null;
    if (facts.profile.kind === 'cmd') return [...CMD_BUILTIN_NAMES, ...windowsPathCommands()];
    if (!facts.commandsLoaded) return null;
    if (facts.profile.kind !== 'powershell') return facts.commands;
    const ps = this.psCommands.get(facts.profile.executable);
    return ps ? [...facts.commands, ...ps, ...windowsPathCommands()] : null;
  }

  private async computeFix(facts: SessionFacts, v: ReturnType<Assistant['view']>, result: CommandResult): Promise<FixSuggestion | null> {
    const list = this.commandList(facts, v);
    const fold = foldsCase(v.shell);
    let fix = suggestFix({
      command: result.command,
      exitCode: result.exitCode,
      output: result.output,
      shell: v.shell,
      windows: v.env.kind === 'windows',
      pm: packageManager(v.env),
      closestCommand: (word) => (list ? closest(word, list, { fold }) : null),
      knownTool: (name) => this.engine.knowsTool(name),
    });
    if (!fix) {
      // No message we recognize: maybe a mistyped option or subcommand the checker can correct.
      const diags = await this.checker.check(this.checkSession(facts, v, result.cwd), result.command, result.command.length, true);
      const d = diags.find((x) => x.fix && /^unknown-/.test(x.code));
      if (d?.fix) {
        fix = { title: d.message, command: result.command.slice(0, d.from) + d.fix.insert + result.command.slice(d.to) };
      }
    }
    if (fix) debugLog(`fix: ${fix.title}`);
    return fix;
  }

  /** New programs may exist after an install: add them to the tab's command list. */
  private async refreshCommands(facts: SessionFacts): Promise<void> {
    if (facts.env.kind === 'windows') {
      resetWindowsPathCommands();
      if (facts.profile.kind === 'powershell') {
        this.psCommands.delete(facts.profile.executable);
        void this.loadPowerShellCommands(facts.profile.executable);
      }
      return;
    }
    const script = "PATH=$(printf '%s' \"$PATH\" | tr ':' '\\n' | grep -v '^/mnt/' | paste -sd: -); compgen -c";
    const res = await runIn(facts.env, 'bash', ['-c', script], { timeoutMs: 20_000 });
    if (res.code !== 0) return;
    const names = new Set(facts.commands);
    for (const n of res.stdout.split('\n')) if (n.trim()) names.add(n.trim());
    facts.commands = [...names];
    debugLog(`kb: command list refreshed (${facts.commands.length} names)`);
  }

  complete(session: PtySession, text: string, cursor: number, reason: CompletionReason): Promise<CompletionResult | null> {
    const facts = this.sessions.get(session.id);
    if (!facts) return Promise.resolve(null);
    if (reason === 'auto' && !this.settings().dropdown) return Promise.resolve(null);
    const exe = facts.profile.executable;
    const v = this.view(facts, facts.remote?.context ?? null);
    const s: CompletionSession = {
      shell: v.shell,
      env: v.env,
      cwd: session.currentCwd,
      home: v.home,
      remoteFs: v.remote?.fs,
      commands: () => {
        if (v.remote) return v.remote.commands;
        if (facts.profile.kind === 'cmd') return [...CMD_BUILTIN_NAMES, ...windowsPathCommands()];
        if (facts.profile.kind === 'powershell') return [...facts.commands, ...(this.psCommands.get(exe) ?? []), ...windowsPathCommands()];
        return facts.commands;
      },
      variables: () => (v.remote ? v.remote.variables : facts.variables),
      ensurePowerShell:
        !v.remote && facts.profile.kind === 'powershell' && this.learner
          ? (tool) => (this.isPowerShellCommand(facts, tool) ? this.learner!.ensurePowerShell(exe, [tool]) : Promise.resolve())
          : undefined,
    };
    return this.engine.complete(s, text, cursor, reason);
  }

  /**
   * Learns your most-used tools ahead of time (once per tool; later starts only check for upgrades).
   * Runs a while after startup so it never competes with opening the first tab.
   */
  prefetchLocal(): void {
    if (!this.learner || !this.settings().learnTools) return;
    // AI notes for the same tools, a while later (after local learning, so the AI sees the real options).
    setTimeout(() => this.aiPrefetch(), 60_000).unref?.();
    if (process.platform === 'win32') {
      const top = this.topTools(['powershell', 'cmd'], 30);
      const exe = this.powershellExe;
      if (exe) {
        void this.loadPowerShellCommands(exe).then((names) => {
          const set = new Set(names.map((n) => n.toLowerCase()));
          const cmdlets = top.filter((t) => set.has(t.toLowerCase()));
          if (cmdlets.length) void this.learner!.ensurePowerShell(exe, cmdlets);
          this.learner!.prefetch({ id: 'windows', kind: 'windows' }, top.filter((t) => !set.has(t.toLowerCase())));
        });
      }
    } else {
      this.learner.prefetch({ id: 'linux', kind: 'linux' }, this.topTools(['bash', 'zsh'], 20));
    }
  }

  /** The most-used tools across several shells, most used first, without repeats. */
  private topTools(kinds: ShellKind[], limit: number): string[] {
    return [...new Set(kinds.flatMap((k) => this.history.topTools(k, limit)))].slice(0, limit);
  }

  private aiPrefetch(): void {
    if (process.platform === 'win32') {
      const exe = this.powershellExe;
      const builtIn = new Set((exe ? (this.psCommands.get(exe) ?? []) : []).map((n) => n.toLowerCase()));
      // PowerShell's own commands, and programs (a user's function or alias is in neither list).
      const tools = this.topTools(['powershell', 'cmd'], 30).filter((t) => builtIn.has(t.toLowerCase()) || !t.includes('-'));
      this.ai.prefetch({ id: 'windows', kind: 'windows' }, 'powershell', tools);
    } else {
      this.ai.prefetch({ id: 'linux', kind: 'linux' }, 'bash', this.topTools(['bash', 'zsh'], 20));
    }
  }

  close(): void {
    this.ai.dispose();
    this.knowledgeStore?.close();
  }

  private async afterWslHome(env: EnvRef, home: string, shell: ShellKind): Promise<void> {
    await this.history.importWsl(env, home, shell);
    if (this.settings().learnTools) this.learner?.prefetch(env, this.history.topTools(shell, 20));
  }

  private isPowerShellCommand(facts: SessionFacts, tool: string): boolean {
    const names = this.psCommands.get(facts.profile.executable);
    // Until the listing is in, Verb-Noun names are a safe bet.
    return names ? names.some((n) => n.toLowerCase() === tool) || facts.commands.some((n) => n.toLowerCase() === tool) : tool.includes('-');
  }

  private loadPowerShellCommands(exe: string): Promise<string[]> {
    if (!this.learner) return Promise.resolve([]);
    return this.learner.powerShellCommands(exe).then((names) => {
      this.psCommands.set(exe, names);
      return names;
    });
  }

  private async readNameFile(facts: SessionFacts, shellPath: string): Promise<string[]> {
    // The path comes from a marker, which any program (or remote machine) can print: read and delete only the
    // files the hooks write, never whatever a marker names.
    if (!isHookFile(shellPath)) {
      debugLog(`kb: ignored a name list at ${shellPath.slice(0, 80)}`);
      return [];
    }
    const file = hostPath(facts.env, shellPath);
    try {
      // The bash hook writes the command list in the background; wait for it to appear.
      for (let waited = 0; !existsSync(file) && waited < 30_000; waited += 500) {
        await new Promise((r) => setTimeout(r, 500));
      }
      const text = await readFile(file, 'utf8');
      void unlink(file).catch(() => {});
      const names = [...new Set(text.replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean))];
      debugLog(`kb: ${names.length} names from ${shellPath}`);
      return names;
    } catch {
      return [];
    }
  }
}
