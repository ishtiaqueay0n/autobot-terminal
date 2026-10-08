import { randomBytes } from 'node:crypto';
import type { IPty } from 'node-pty';
import { debugLog } from './debug';
import { findGitBranch } from './git';
import { pty } from './node-pty';
import { launchSpec, type ResolvedProfile, type SshLaunch } from './profiles';
import { RemoteRpc } from './rpc';
import { CmdEchoFilter } from '../shared/cmd-echo';
import { MarkerParser } from '../shared/markers';
import { toHostPath } from '../shared/paths';
import { encodeSubmission } from '../shared/submit';
import { stripAnsi } from '../shared/ansi';
import type { RemoteContext, SessionEvent } from '../shared/types';

export interface CommandResult {
  command: string;
  /** Folder the command was started in (as the shell reports it). */
  cwd: string | null;
  exitCode: number;
  startedAt: number;
  durationMs: number;
  /** The end of what the command printed, as plain text (for fix suggestions). */
  output: string;
  /** Set when the command ran on another machine, in an ssh session with Autobot's helper loaded. */
  remote?: RemoteContext;
}

interface Pending {
  command: string;
  cwd: string | null;
  startedAt: number;
  remote?: RemoteContext;
}

/** Output kept per running command: enough for error messages, bounded for long-running ones. */
const CAPTURE_MAX = 32_000;
const CAPTURE_KEEP = 16_000;

export interface PtySessionOptions {
  id: number;
  profile: ResolvedProfile;
  shellDir: string;
  /** How the ssh wrapper behaves in this tab (bash, zsh and PowerShell tabs). */
  ssh?: SshLaunch;
  cols: number;
  rows: number;
  onEvents: (events: SessionEvent[]) => void;
  onExit: (exitCode: number) => void;
  /** Called (before the prompt event is delivered) when a submitted command finishes. */
  onCommandFinished?: (result: CommandResult) => void;
}

/**
 * One shell process behind a PTY. Output is split into plain data and shell markers, kept in order, and
 * delivered in batches (one per event-loop turn) to keep IPC traffic down.
 */
export class PtySession {
  readonly id: number;
  readonly profile: ResolvedProfile;
  private readonly proc: IPty;
  private readonly parser = new MarkerParser();
  /** cmd.exe echoes the exit-code hook that is appended to every line; this blanks it out. */
  private readonly echoFilter: CmdEchoFilter | null;
  private queue: SessionEvent[] = [];
  private flushScheduled = false;
  private exited = false;
  private sawPrompt = false;
  private cwd: string | null = null;
  private pending: Pending | null = null;
  /** A command of this machine (ssh) that is still running underneath the remote session's own prompts. */
  private outer: Pending | null = null;
  private captured = '';
  /** The machine the shell at the last prompt runs on, when it is not this one. */
  private remote: RemoteContext | null = null;
  /** From a remote marker: applies to the next prompt. */
  private nextRemote: RemoteContext | null = null;
  private atPrompt = false;
  private readonly rpc: RemoteRpc;
  /** Goes into the shell's environment; the ssh wrapper's "always" and "never" must carry it to count. */
  private readonly sshToken = randomBytes(12).toString('hex');
  /** Input that arrived while a question to the remote shell was open; sent when it is answered. */
  private deferred: (() => void)[] = [];

  constructor(private readonly opts: PtySessionOptions) {
    this.id = opts.id;
    this.profile = opts.profile;
    this.echoFilter = opts.profile.kind === 'cmd' ? new CmdEchoFilter() : null;
    const spec = launchSpec(opts.profile, opts.shellDir, opts.ssh && { ...opts.ssh, token: this.sshToken });
    this.rpc = new RemoteRpc(
      (text) => this.proc.write(text),
      () => this.atPrompt && this.remote !== null && !this.exited,
      () => this.runDeferred(),
    );
    this.proc = pty.spawn(spec.file, spec.args, {
      name: 'xterm-256color',
      cols: clampSize(opts.cols, 80),
      rows: clampSize(opts.rows, 24),
      cwd: spec.cwd,
      env: spec.env,
      // The Windows 10 inbox ConPTY drops our OSC markers; node-pty's bundled one passes them.
      useConptyDll: process.platform === 'win32',
    });
    debugLog(`session ${this.id}: spawned ${spec.file}`);
    this.proc.onData((data) => this.handleData(data));
    this.proc.onExit(({ exitCode }) => {
      this.exited = true;
      this.rpc.dispose();
      this.enqueue([{ type: 'data', data: (this.echoFilter?.flush() ?? '') + this.parser.flush() }]);
      this.flush();
      opts.onExit(exitCode);
    });
  }

  /** The folder the shell reported at its last prompt. */
  get currentCwd(): string | null {
    return this.cwd;
  }

  /** The machine the tab is connected to over ssh (null: this one). */
  get remoteContext(): RemoteContext | null {
    return this.remote;
  }

  /**
   * Asks the shell on the other end of an ssh session something (see rpc.ts): `ls` lists a folder, `stat` says
   * what a path is. Null when there is no answer: not connected, busy with a command, or no helper over there.
   */
  askRemote(op: 'ls' | 'stat', arg: string): Promise<string | null> {
    return this.atPrompt && this.remote && !this.exited ? this.rpc.request(op, arg) : Promise.resolve(null);
  }

  write(data: string): void {
    if (this.exited) return;
    if (this.rpc.busy) this.deferred.push(() => this.proc.write(data));
    else this.proc.write(data);
  }

  /** Sends extra events to the window in order with the shell's own (e.g. a fix after its prompt). */
  emit(events: SessionEvent[]): void {
    this.enqueue(events);
  }

  /**
   * Sends a command typed in the input editor. With `record`, its exit code and duration are reported via
   * onCommandFinished when the next prompt arrives.
   */
  submit(text: string, record: boolean): void {
    if (this.exited) return;
    if (this.rpc.busy) {
      this.deferred.push(() => this.submit(text, record));
      return;
    }
    this.rpc.cancelQueued();
    this.atPrompt = false;
    this.pending =
      record && text.trim() ? { command: text, cwd: this.cwd, startedAt: Date.now(), ...(this.remote ? { remote: this.remote } : {}) } : null;
    this.captured = '';
    this.proc.write(encodeSubmission(text, this.profile.kind));
  }

  private runDeferred(): void {
    for (const run of this.deferred.splice(0)) run();
  }

  resize(cols: number, rows: number): void {
    if (this.exited) return;
    try {
      this.proc.resize(clampSize(cols, 80), clampSize(rows, 24));
    } catch {
      // The process can exit between the check and the resize.
    }
  }

  kill(): void {
    if (this.exited) return;
    this.exited = true;
    this.rpc.dispose();
    try {
      this.proc.kill();
    } catch {
      // Already gone.
    }
  }

  private handleData(data: string): void {
    const events: SessionEvent[] = [];
    for (const item of this.parser.push(this.echoFilter ? this.echoFilter.push(data) : data)) {
      if (this.rpc.busy) {
        // A question to the remote shell is open: what it prints (the echo, its prompt) is not for the screen.
        const marker = item.type === 'marker' ? item.marker : null;
        if (marker?.kind === 'reply') this.rpc.reply(marker.id, marker.data);
        else if (marker?.kind === 'remote') this.nextRemote = { host: marker.host, shell: marker.shell };
        if (marker?.kind !== 'prompt') continue;
        if (this.nextRemote) {
          // The remote shell's own prompt, the end of the exchange.
          this.nextRemote = null;
          this.rpc.prompt();
          continue;
        }
        // A prompt of this machine: the connection ended while the question was open. Nobody is left to answer.
        this.rpc.reset();
        this.runDeferred();
      }
      if (item.type === 'data') {
        events.push({ type: 'data', data: item.data });
        if (this.pending) {
          this.captured += item.data;
          if (this.captured.length > CAPTURE_MAX) this.captured = this.captured.slice(-CAPTURE_KEEP);
        }
        continue;
      }
      const m = item.marker;
      if (m.kind === 'prompt') {
        if (!this.sawPrompt) debugLog(`session ${this.id}: first prompt`);
        this.sawPrompt = true;
        this.cwd = m.cwd;
        const remote = this.nextRemote;
        this.nextRemote = null;
        this.moveTo(remote);
        this.atPrompt = true;
        this.finishPending(m.exitCode);
        events.push({
          type: 'prompt',
          exitCode: m.exitCode,
          cwd: m.cwd,
          // Git branches are read from this machine's disk; over ssh there is nothing to read.
          gitBranch: remote ? null : this.gitBranch(m.cwd),
          ...(remote ? { remote } : {}),
        });
        this.rpc.pump();
      } else if (m.kind === 'commandStart') {
        this.atPrompt = false;
        this.rpc.cancelQueued();
        events.push({ type: 'commandStart' });
      } else if (m.kind === 'remote') {
        this.nextRemote = { host: m.host, shell: m.shell };
      } else if (m.kind === 'reply') {
        // An answer nobody waits for any more (it came too late).
      } else if (m.key === 'SshChoice') {
        // "on:<token>" or "off:<token>": anything else is text some program printed, not the wrapper's answer.
        const [choice, token] = m.value.split(':');
        if ((choice === 'on' || choice === 'off') && token === this.sshToken) events.push({ type: 'property', key: m.key, value: choice });
      } else {
        events.push({ type: 'property', key: m.key, value: m.value });
      }
    }
    this.enqueue(events);
  }

  /**
   * The prompt that just arrived belongs to another machine than the last one (an ssh session started or ended).
   * The ssh command itself keeps running underneath the remote prompts, and finishes when this machine's prompt
   * is back; commands typed on the remote side are not its business.
   */
  private moveTo(next: RemoteContext | null): void {
    const prev = this.remote;
    if (prev?.host === next?.host && prev?.shell === next?.shell) return;
    if (next && !prev) {
      this.outer = this.pending;
      this.pending = null;
    } else if (!next && prev) {
      this.pending = this.outer;
      this.outer = null;
    } else {
      this.pending = null;
    }
    this.captured = '';
    this.remote = next;
    this.rpc.reset();
  }

  private finishPending(exitCode: number): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    const output = stripAnsi(this.captured).slice(-8000);
    this.captured = '';
    try {
      this.opts.onCommandFinished?.({ ...p, exitCode, durationMs: Date.now() - p.startedAt, output });
    } catch (err) {
      // History is a nice-to-have; never let it break the terminal.
      console.error('[session] recording command failed:', err);
    }
  }

  private gitBranch(cwd: string): string | null {
    try {
      return findGitBranch(toHostPath(cwd, this.profile));
    } catch {
      return null;
    }
  }

  private enqueue(events: SessionEvent[]): void {
    for (const ev of events) {
      const last = this.queue[this.queue.length - 1];
      if (ev.type === 'data') {
        if (!ev.data) continue;
        if (last && last.type === 'data') {
          last.data += ev.data;
          continue;
        }
      }
      this.queue.push(ev);
    }
    if (!this.flushScheduled && this.queue.length > 0) {
      this.flushScheduled = true;
      setImmediate(() => this.flush());
    }
  }

  private flush(): void {
    this.flushScheduled = false;
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    this.opts.onEvents(batch);
  }
}

function clampSize(n: number, fallback: number): number {
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 1000) : fallback;
}
