import type { EditorView } from '@codemirror/view';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal, type IDecoration, type IMarker } from '@xterm/xterm';
import { OutputColorizer } from '@shared/colorize';
import { assessDanger } from '@shared/danger';
import { fillExample } from '@shared/examples';
import { highlightCommand } from '@shared/highlight';
import { isIncomplete } from '@shared/incomplete';
import { baseName, shortenHome } from '@shared/paths';
import { paletteFor } from '@shared/palette';
import { foldsCase, isPosix } from '@shared/shell';
import type {
  AiExplainResult,
  AiFixResult,
  CompletionResult,
  Diagnostic,
  FixSuggestion,
  RemoteContext,
  SessionEvent,
  Settings,
  ShellKind,
  ShellProfile,
} from '@shared/types';
import { xtermTheme } from '../theme';
import { checks } from './checks';
import { commandColors, recolor } from './colors';
import { completion } from './completion';
import { createInputEditor, setEditorText, type Dropdown } from './editor';
import { ghostText, type Ghost } from './ghost';
import { routeSession } from './router';

/**
 * starting: shell booting, keys go to the PTY.
 * prompt:   the input editor owns the keyboard; xterm only shows output.
 * running:  from Enter until the next prompt marker; keys go straight to the program.
 * exited:   the shell process ended; Enter restarts it.
 */
export type Mode = 'starting' | 'prompt' | 'running' | 'exited';

export interface PaneState {
  mode: Mode;
  profile: ShellProfile | null;
  cwd: string | null;
  displayCwd: string;
  gitBranch: string | null;
  /** The machine the prompt belongs to when the tab is in an ssh session (null: this machine). */
  remote: RemoteContext | null;
  /** Exit code of the last command the user ran, null before the first one. */
  lastExitCode: number | null;
  runningCommand: string;
  shellLabel: string | null;
  /** Exit code of the shell process itself, once it has exited. */
  processExitCode: number | null;
  error: string | null;
  title: string;
  panel: PanelState;
  /** The most important problem in the line being typed (shown under the input). */
  hint: { severity: Diagnostic['severity']; message: string; fixLabel?: string } | null;
  /** A destructive command is waiting for a second Enter. */
  danger: { reason: string } | null;
  /** What to do about the command that just failed. */
  fix: FixSuggestion | null;
  /** A Ctrl+. request: waiting for the AI, or why it gave nothing. */
  aiRequest: { state: 'pending' } | { state: 'error'; message: string } | null;
  /** AI help is configured (shows the Ctrl+. hint after a failure). */
  aiReady: boolean;
}

export interface PanelEntry {
  section: 'suggestions' | 'examples' | 'history' | 'ai';
  label: string;
  description?: string;
  detail?: string;
  dangerous?: boolean;
  apply(view: EditorView): void;
}

/** The Ctrl+Space panel. */
export interface PanelState {
  open: boolean;
  loading: boolean;
  tool: CompletionResult['tool'] | null;
  entries: PanelEntry[];
  selected: number;
  /** The examples were written by the AI (no tldr page for the tool). */
  examplesFromAi: boolean;
  /** The AI section (when turned on): its summary, or a note while loading or when it has nothing. */
  ai: { loading: boolean; summary?: string; message?: string } | null;
}

const CLOSED_PANEL: PanelState = { open: false, loading: false, tool: null, entries: [], selected: 0, examplesFromAi: false, ai: null };

type PromptEvent = Extract<SessionEvent, { type: 'prompt' }>;

interface CommandMark {
  decoration: IDecoration | undefined;
  status: 'running' | 'ok' | 'fail';
}

export class TerminalController {
  readonly term: Terminal;
  /** Called when the shell process exits. */
  onExit: ((exitCode: number) => void) | null = null;

  private readonly fitAddon = new FitAddon();
  private editor: EditorView | null = null;
  private termEl: HTMLElement | null = null;
  private sessionId: number | null = null;
  private unroute: (() => void) | null = null;
  private state: PaneState;
  private readonly listeners = new Set<() => void>();
  private settings: Settings;
  private readonly ghost: Ghost;
  private readonly dropdown: Dropdown;
  private panelSeq = 0;
  private panelTimer = 0;
  /** The panel's AI section for a tool, kept while typing so it does not flicker. */
  private panelAi: { tool: string; state: NonNullable<PanelState['ai']>; entries: PanelEntry[] } | null = null;
  private aiSeq = 0;
  /** Latest checker result and the text it was for. */
  private diagnostics: { text: string; list: Diagnostic[] } = { text: '', list: [] };
  /** The exact command line already confirmed once (the next Enter runs it). */
  private armedDanger: string | null = null;
  /** Recent commands for this shell from the history database, newest first. */
  private recent: string[] = [];
  /** While browsing with ↑/↓: the matching entries and the position in them. */
  private browse: { entries: string[]; index: number; draft: string } | null = null;
  private promptMarker: IMarker | null = null;
  private currentMark: CommandMark | null = null;
  private home: string | null = null;
  /** The home folder of the machine at the other end of an ssh session. */
  private remoteHome: string | null = null;
  private active = false;
  private mounted = false;
  private disposed = false;
  private resizeObserver: ResizeObserver | null = null;
  private fitFrame = 0;

  constructor(
    private readonly profileId: string | null,
    settings: Settings,
  ) {
    this.settings = settings;
    this.ghost = ghostText({
      suggest: (text) => this.suggest(text),
      foldCase: () => foldsCase(this.kind),
    });
    this.dropdown = completion({
      query: (text, cursor, reason) =>
        this.sessionId === null || this.state.mode !== 'prompt' || this.state.panel.open
          ? Promise.resolve(null)
          : window.autobot.complete(this.sessionId, text, cursor, reason),
      foldCase: () => foldsCase(this.kind),
    });
    this.state = {
      mode: 'starting',
      profile: null,
      cwd: null,
      displayCwd: '',
      gitBranch: null,
      remote: null,
      lastExitCode: null,
      runningCommand: '',
      shellLabel: null,
      processExitCode: null,
      error: null,
      title: 'Starting…',
      panel: CLOSED_PANEL,
      hint: null,
      danger: null,
      fix: null,
      aiRequest: null,
      aiReady: false,
    };
    this.term = new Terminal({
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      scrollback: settings.scrollback,
      cursorBlink: settings.cursorBlink,
      theme: xtermTheme(settings.theme),
      allowProposedApi: true,
      // The editor owns the caret at a prompt; hide xterm's cursor whenever xterm is not focused.
      cursorInactiveStyle: 'none',
      rightClickSelectsWord: false,
    });
    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(new WebLinksAddon((_event, uri) => window.autobot.openExternal(uri)));
    this.term.onData((data) => {
      if (this.sessionId === null) return;
      // Text typed or pasted into the output area at a prompt belongs in the editor. Query replies
      // (cursor position, device attributes, focus) start with ESC and must still reach the shell.
      if (this.state.mode === 'prompt' && !data.startsWith('\x1b')) {
        this.insertIntoEditor(data.replace(/\r\n?/g, '\n'));
        return;
      }
      window.autobot.write(this.sessionId, data);
    });
    this.term.onResize(({ cols, rows }) => {
      if (this.sessionId !== null) window.autobot.resize(this.sessionId, cols, rows);
    });
    this.term.attachCustomKeyEventHandler((e) => this.handleTerminalKey(e));
  }

  // ------------------------------------------------------------------------------------ store API

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): PaneState => this.state;

  private update(patch: Partial<PaneState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  // ------------------------------------------------------------------------------------ lifecycle

  mount(termEl: HTMLElement, editorEl: HTMLElement): void {
    if (this.mounted) return;
    this.mounted = true;
    this.termEl = termEl;
    this.term.open(termEl);
    this.editor = createInputEditor(
      editorEl,
      {
        onSubmit: (text) => this.submit(text),
        isIncomplete: (text) => isIncomplete(text, this.kind),
        historyPrev: (current) => this.historyPrev(current),
        historyNext: () => this.historyNext(),
        onCtrlC: () => this.cancelOrCopy(),
        onClearScreen: () => this.clearScreen(),
        onTogglePanel: () => this.togglePanel(),
        panelKey: (key) => this.panelKey(key),
        onDocChange: () => this.onDocChange(),
        onEscape: () => this.onEscape(),
        onQuickFix: () => this.quickFix(),
        onAskAi: () => this.askAi(),
      },
      this.ghost,
      this.dropdown,
      [
        commandColors(
          () => this.kind,
          () => this.settings.colorCommands,
        ),
        checks({
          query: (text, cursor) =>
            this.sessionId === null || this.state.mode !== 'prompt'
              ? Promise.resolve([])
              : window.autobot.check(this.sessionId, text, cursor, false),
          onResult: (list, text) => this.onDiagnostics(list, text),
        }),
      ],
    );
    // Clicking the output (without selecting) returns the keyboard to the editor.
    termEl.addEventListener('mouseup', () => {
      if (this.state.mode === 'prompt' && !this.term.hasSelection()) this.editor?.focus();
    });
    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.resizeObserver.observe(termEl);
    this.fit();
    void this.start();
  }

  setActive(active: boolean): void {
    this.active = active;
    if (active) this.scheduleFit();
  }

  setAiReady(ready: boolean): void {
    if (ready !== this.state.aiReady) this.update({ aiReady: ready });
  }

  applySettings(settings: Settings): void {
    this.settings = settings;
    this.term.options.fontFamily = settings.fontFamily;
    this.term.options.fontSize = settings.fontSize;
    this.term.options.scrollback = settings.scrollback;
    this.term.options.cursorBlink = settings.cursorBlink;
    this.term.options.theme = xtermTheme(settings.theme);
    this.editor?.dispatch({ effects: recolor.of(null) });
    this.scheduleFit();
  }

  // ------------------------------------------------------------------------------------ Ctrl+Space panel

  togglePanel(): void {
    if (this.state.panel.open) {
      this.closePanel();
      return;
    }
    if (this.state.mode !== 'prompt' || !this.editor) return;
    this.update({ panel: { ...CLOSED_PANEL, open: true, loading: true } });
    void this.refreshPanel();
  }

  closePanel(): void {
    if (!this.state.panel.open) return;
    this.panelSeq++;
    this.panelAi = null;
    this.update({ panel: CLOSED_PANEL });
    this.editor?.focus();
  }

  pickPanel(index: number): void {
    const entry = this.state.panel.entries[index];
    if (!entry || !this.editor) return;
    this.closePanel();
    entry.apply(this.editor);
    this.editor.focus();
  }

  private panelKey(key: 'up' | 'down' | 'pageup' | 'pagedown' | 'accept' | 'close'): boolean {
    const panel = this.state.panel;
    if (!panel.open) return false;
    const last = panel.entries.length - 1;
    const move = (to: number) => this.update({ panel: { ...panel, selected: Math.max(0, Math.min(last, to)) } });
    if (key === 'close') this.closePanel();
    else if (key === 'accept') this.pickPanel(panel.selected);
    else if (key === 'up') move(panel.selected - 1);
    else if (key === 'down') move(panel.selected + 1);
    else if (key === 'pageup') move(panel.selected - 8);
    else move(panel.selected + 8);
    return true;
  }

  private schedulePanelRefresh(): void {
    if (!this.state.panel.open) return;
    window.clearTimeout(this.panelTimer);
    this.panelTimer = window.setTimeout(() => void this.refreshPanel(), 80);
  }

  private async refreshPanel(): Promise<void> {
    const editor = this.editor;
    if (!editor || this.sessionId === null) return;
    const seq = ++this.panelSeq;
    const text = editor.state.doc.toString();
    const cursor = editor.state.selection.main.head;
    let res: CompletionResult | null = null;
    try {
      res = await window.autobot.complete(this.sessionId, text, cursor, 'panel');
    } catch {
      res = null;
    }
    if (seq !== this.panelSeq || !this.state.panel.open) return;
    const toolName = res?.tool?.name ?? null;
    const wantAi = this.settings.llmPanel && toolName !== null;
    if (!wantAi || this.panelAi?.tool !== toolName) this.panelAi = null;
    const base = panelEntries(res);
    this.update({
      panel: {
        open: true,
        loading: false,
        tool: res?.tool ?? null,
        entries: [...base, ...(this.panelAi?.entries ?? [])],
        selected: 0,
        examplesFromAi: res?.examplesSource === 'ai',
        ai: wantAi ? (this.panelAi ? { ...this.panelAi.state, loading: true } : { loading: true }) : null,
      },
    });
    if (!wantAi || !toolName) return;

    let ai: AiExplainResult;
    try {
      ai = await window.autobot.aiExplain(this.sessionId, text, cursor);
    } catch {
      ai = { ok: false, message: 'The AI request failed.' };
    }
    if (seq !== this.panelSeq || !this.state.panel.open) return;
    const state = ai.ok ? { loading: false, summary: ai.summary || undefined } : { loading: false, message: ai.message };
    const entries: PanelEntry[] = ai.ok
      ? ai.examples.map((ex) => {
          const filled = fillExample(ex.command);
          return { section: 'ai', label: filled.text, description: ex.text, apply: (view) => replaceLine(view, filled.text, filled.select) };
        })
      : [];
    this.panelAi = { tool: toolName, state, entries };
    const panel = this.state.panel;
    this.update({ panel: { ...panel, entries: [...base, ...entries], ai: state } });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.clearTimeout(this.panelTimer);
    this.unroute?.();
    if (this.sessionId !== null) window.autobot.kill(this.sessionId);
    this.sessionId = null;
    this.resizeObserver?.disconnect();
    cancelAnimationFrame(this.fitFrame);
    this.editor?.destroy();
    this.term.dispose();
    this.listeners.clear();
  }

  /** Puts the keyboard where the current mode wants it. Call after the UI for the mode is rendered. */
  focus(): void {
    if (!this.active || this.disposed) return;
    if (this.state.mode === 'prompt') this.editor?.focus();
    else this.term.focus();
  }

  private get kind(): ShellKind {
    // Commands go to the shell that shows the prompt: over ssh, the one on the other machine.
    return this.state.remote?.shell ?? this.state.profile?.kind ?? 'bash';
  }

  private async start(): Promise<void> {
    this.update({ mode: 'starting', error: null, processExitCode: null, runningCommand: '' });
    try {
      const info = await window.autobot.createSession(this.profileId, this.term.cols, this.term.rows);
      if (this.disposed) {
        window.autobot.kill(info.sessionId);
        return;
      }
      if (info.windowsPty) this.term.options.windowsPty = info.windowsPty;
      this.sessionId = info.sessionId;
      this.update({ profile: info.profile, title: info.profile.name });
      this.unroute = routeSession(info.sessionId, {
        events: (events) => this.handleEvents(events),
        exit: (code) => this.handleExit(code),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': /, '') : String(err);
      this.update({ mode: 'exited', error: message, title: 'Error' });
      this.term.write(`\r\n\x1b[31mCould not start the shell: ${message}\x1b[0m\r\n`);
    }
  }

  // ------------------------------------------------------------------------------------ session events

  private handleEvents(events: SessionEvent[]): void {
    for (const ev of events) {
      switch (ev.type) {
        case 'data':
          this.term.write(this.colorize(ev.data));
          break;
        case 'prompt':
          // A command is over: nothing of its output colouring carries on.
          this.echoUntil = null;
          this.colorizer.reset();
          // Wait until everything before the marker has been parsed, so the cursor is on the prompt line.
          this.term.write('', () => {
            this.paintEcho();
            this.onPrompt(ev);
          });
          break;
        case 'property':
          if (ev.key === 'Home') this.home = ev.value;
          else if (ev.key === 'RemoteHome') this.remoteHome = ev.value;
          else if (ev.key === 'Shell') this.update({ shellLabel: ev.value });
          break;
        case 'commandStart':
          // What came before is the echo of the command line; the output starts here.
          this.echoUntil = null;
          this.term.write('', () => this.paintEcho());
          break;
        case 'fix':
          // Arrives right after the failed command's prompt; ignore it if something else ran since.
          this.term.write('', () => this.showFix(ev.command, ev.fix));
          break;
      }
    }
  }

  private lastSubmitted = '';

  private showFix(command: string, fix: FixSuggestion): void {
    if (this.disposed || this.state.mode !== 'prompt' || command !== this.lastSubmitted) return;
    this.update({ fix });
    // The fix command becomes the ghost text on the empty line: → takes it.
    if (this.editor && fix.command) this.ghost.refresh(this.editor);
  }

  private onDiagnostics(list: Diagnostic[], text: string): void {
    this.diagnostics = { text, list };
    // The hint line shows the most important problem; danger is shown by its own banner on Enter.
    const top = [...list].filter((d) => d.code !== 'danger' || d.severity === 'warning').sort((a, b) => rank(a) - rank(b))[0];
    const hint = top ? { severity: top.severity, message: top.message, fixLabel: top.fix?.label } : null;
    if (JSON.stringify(hint) !== JSON.stringify(this.state.hint)) this.update({ hint });
  }

  private onDocChange(): void {
    this.schedulePanelRefresh();
    // Editing the line withdraws a pending danger confirmation.
    if (this.state.danger) this.update({ danger: null });
    this.armedDanger = null;
    if (this.editor && this.editor.state.doc.length === 0 && this.state.hint) this.update({ hint: null });
  }

  private onEscape(): boolean {
    if (this.state.aiRequest) {
      this.aiSeq++;
      this.update({ aiRequest: null });
      return true;
    }
    if (this.state.danger) {
      this.armedDanger = null;
      this.update({ danger: null });
      return true;
    }
    if (this.state.fix) {
      this.update({ fix: null });
      if (this.editor) this.ghost.refresh(this.editor);
      return true;
    }
    return false;
  }

  /** Alt+Enter: apply the fix of the most important problem in the current line. */
  private quickFix(): boolean {
    const editor = this.editor;
    if (!editor) return false;
    const text = editor.state.doc.toString();
    if (this.diagnostics.text !== text) return false;
    const target = [...this.diagnostics.list].filter((d) => d.fix).sort((a, b) => rank(a) - rank(b))[0];
    if (!target?.fix) return false;
    editor.dispatch({ changes: { from: target.from, to: target.to, insert: target.fix.insert } });
    return true;
  }

  /** Ctrl+.: asks the AI how to fix the last failed command in this tab. The answer shows as the fix banner. */
  askAi(): boolean {
    if (this.state.mode !== 'prompt' || this.sessionId === null) return false;
    if (this.state.aiRequest?.state === 'pending') return true;
    const seq = ++this.aiSeq;
    const command = this.lastSubmitted;
    this.update({ aiRequest: { state: 'pending' }, fix: null });
    const done = (res: AiFixResult) => {
      if (seq !== this.aiSeq || this.disposed) return;
      // Something else ran meanwhile: the answer is about an older command.
      if (this.state.mode !== 'prompt' || command !== this.lastSubmitted) {
        this.update({ aiRequest: null });
        return;
      }
      if (!res.ok) {
        this.update({ aiRequest: { state: 'error', message: res.message } });
        return;
      }
      this.update({ aiRequest: null, fix: res.fix });
      if (this.editor && res.fix.command) this.ghost.refresh(this.editor);
    };
    window.autobot.aiFix(this.sessionId).then(done, () => done({ ok: false, message: 'The AI request failed.' }));
    return true;
  }

  /** Puts the suggested fix on the input line (the banner's "Use" button; → does the same via ghost text). */
  useFix(): void {
    const fix = this.state.fix;
    if (!fix?.command || !this.editor) return;
    setEditorText(this.editor, fix.command);
    this.update({ fix: null });
    this.editor.focus();
  }

  private onPrompt(ev: PromptEvent): void {
    if (this.disposed) return;
    if (this.currentMark) {
      this.currentMark.status = ev.exitCode === 0 ? 'ok' : 'fail';
      this.paintMark(this.currentMark);
      this.currentMark = null;
    }
    const ranCommand = this.state.mode === 'running' && this.state.runningCommand.trim() !== '';
    this.promptMarker?.dispose();
    this.promptMarker = this.term.registerMarker(0) ?? null;

    const displayCwd = shortenHome(ev.cwd, ev.remote ? this.remoteHome : this.home);
    const base = baseName(displayCwd) || (this.state.profile?.name ?? 'Shell');
    this.update({
      mode: 'prompt',
      cwd: ev.cwd,
      displayCwd,
      gitBranch: ev.gitBranch,
      remote: ev.remote ?? null,
      lastExitCode: ranCommand ? ev.exitCode : this.state.lastExitCode,
      runningCommand: '',
      title: ev.remote ? `${ev.remote.host.split('@').pop()}: ${base}` : base,
    });
    this.browse = null;
    void this.loadRecent();
    // Empty line: ask for the command that usually comes next.
    if (this.editor) this.ghost.refresh(this.editor);
  }

  private async loadRecent(): Promise<void> {
    if (this.sessionId === null) return;
    try {
      this.recent = await window.autobot.historyRecent(this.sessionId);
    } catch {
      // Keep the previous list.
    }
  }

  private suggest(text: string): Promise<string | null> {
    if (this.sessionId === null || this.state.mode !== 'prompt') return Promise.resolve(null);
    // A fix for the command that just failed beats history while it fits what is typed.
    const fixCommand = this.state.fix?.command;
    if (fixCommand && fixCommand.startsWith(text) && fixCommand !== text) return Promise.resolve(fixCommand);
    if (!this.settings.ghostText) return Promise.resolve(null);
    return window.autobot.suggest(this.sessionId, text);
  }

  private handleExit(exitCode: number): void {
    this.unroute?.();
    this.unroute = null;
    this.sessionId = null;
    this.promptMarker?.dispose();
    this.promptMarker = null;
    this.update({ mode: 'exited', processExitCode: exitCode, runningCommand: '' });
    this.term.write(`\r\n\x1b[2m[process exited with code ${exitCode} · press Enter to restart]\x1b[0m\r\n`);
    this.onExit?.(exitCode);
  }

  // ------------------------------------------------------------------------------------ input

  private submit(text: string): void {
    if (this.state.mode !== 'prompt' || this.sessionId === null || !this.editor) return;
    this.closePanel();
    // Destructive commands need a second Enter on exactly the same line.
    const danger = this.settings.dangerConfirm ? assessDanger(text, this.kind) : null;
    if (danger?.level === 'confirm' && this.armedDanger !== text) {
      this.armedDanger = text;
      this.update({ danger: { reason: danger.reason } });
      return;
    }
    this.armedDanger = null;
    this.lastSubmitted = text;
    this.aiSeq++;
    this.update({ danger: null, fix: null, hint: null, aiRequest: null });
    if (text.trim() && this.promptMarker) {
      this.expectEcho(text, this.promptMarker);
      this.currentMark = this.decorateCommand(this.promptMarker);
      this.promptMarker = null;
    } else {
      this.echoUntil = this.echoLines(text);
    }
    // Remember it locally right away, so ↑ finds it even before the database answers at the next prompt.
    // A leading space keeps a command out of history entirely.
    if (text.trim() && !text.startsWith(' ')) this.recent = [text, ...this.recent.filter((c) => c !== text)];
    this.browse = null;
    // Switch mode first so clearing the editor does not ask for a ghost suggestion.
    this.update({ mode: 'running', runningCommand: text });
    setEditorText(this.editor, '');
    this.term.scrollToBottom();
    window.autobot.submit(this.sessionId, text, true);
  }

  /** Runs a housekeeping command (e.g. clear) without recording it as the user's command. */
  private runQuiet(command: string): void {
    if (this.state.mode !== 'prompt' || this.sessionId === null) return;
    this.closePanel();
    this.echoUntil = this.echoLines(command);
    this.update({ mode: 'running', runningCommand: '' });
    window.autobot.submit(this.sessionId, command, false);
  }

  private clearScreen(): void {
    // A leading space keeps it out of bash and zsh history.
    this.runQuiet(isPosix(this.kind) ? ' clear' : this.kind === 'cmd' ? 'cls' : 'Clear-Host');
  }

  /**
   * ↑: older entries from the history database. With text already typed, only entries starting with it
   * (case-insensitive for PowerShell), like PSReadLine's history search.
   */
  private historyPrev(current: string): string | null {
    if (!this.browse) {
      const fold = foldsCase(this.kind);
      const key = fold ? current.toLowerCase() : current;
      const entries = this.recent.filter((c) => c !== current && (fold ? c.toLowerCase() : c).startsWith(key));
      this.browse = { entries, index: -1, draft: current };
    }
    if (this.browse.index + 1 >= this.browse.entries.length) return null;
    this.browse.index++;
    return this.browse.entries[this.browse.index];
  }

  /** ↓: newer entries, then back to what was typed before browsing. */
  private historyNext(): string | null {
    if (!this.browse) return null;
    this.browse.index--;
    if (this.browse.index < 0) {
      const draft = this.browse.draft;
      this.browse = null;
      return draft;
    }
    return this.browse.entries[this.browse.index];
  }

  /** Ctrl+C in the editor with nothing selected there: copy output selection, else drop the line. */
  private cancelOrCopy(): void {
    if (this.term.hasSelection()) {
      this.copyTerminalSelection();
      return;
    }
    if (this.editor) setEditorText(this.editor, '');
    this.browse = null;
  }

  private handleTerminalKey(e: KeyboardEvent): boolean {
    const mode = this.state.mode;
    if (e.type !== 'keydown') return mode === 'running' || mode === 'starting';

    const ctrlOnly = e.ctrlKey && !e.altKey && !e.metaKey;
    const key = e.key.toLowerCase();
    if (ctrlOnly && key === 'c' && (e.shiftKey || this.term.hasSelection())) {
      e.preventDefault();
      if (this.term.hasSelection()) this.copyTerminalSelection();
      return false;
    }
    if (ctrlOnly && key === 'v') {
      e.preventDefault();
      void this.paste();
      return false;
    }
    if (mode === 'prompt') {
      // Typing while the output has focus goes to the editor. Printable keys follow the focus change by
      // themselves; special keys (Enter, arrows, ...) are replayed so the editor's keymap sees them.
      if (!this.editor) return false;
      this.editor.focus();
      const printable = e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey;
      if (!printable) {
        e.preventDefault();
        this.editor.contentDOM.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: e.key,
            code: e.code,
            keyCode: e.keyCode,
            ctrlKey: e.ctrlKey,
            shiftKey: e.shiftKey,
            altKey: e.altKey,
            metaKey: e.metaKey,
            bubbles: true,
            cancelable: true,
          }),
        );
      }
      return false;
    }
    if (mode === 'exited') {
      if (e.key === 'Enter' && !this.disposed) void this.start();
      return false;
    }
    return true;
  }

  copy(): void {
    if (this.term.hasSelection()) {
      this.copyTerminalSelection();
      return;
    }
    const sel = this.editor?.state.selection.main;
    if (this.editor && sel && !sel.empty) {
      window.autobot.writeClipboard(this.editor.state.sliceDoc(sel.from, sel.to));
    }
  }

  async paste(): Promise<void> {
    const text = await window.autobot.readClipboard();
    if (!text) return;
    if (this.state.mode === 'prompt') {
      this.insertIntoEditor(text.replace(/\r\n?/g, '\n'));
    } else if (this.state.mode === 'running' || this.state.mode === 'starting') {
      // Honors bracketed paste mode when the running program asked for it.
      this.term.paste(text);
    }
  }

  private insertIntoEditor(text: string): void {
    if (!this.editor) return;
    this.editor.dispatch(this.editor.state.replaceSelection(text));
    this.editor.focus();
  }

  private copyTerminalSelection(): void {
    window.autobot.writeClipboard(this.term.getSelection());
    this.term.clearSelection();
  }

  // ------------------------------------------------------------------------------------ colours

  private readonly colorizer = new OutputColorizer();
  /**
   * Output that is still the shell echoing the command just sent, which is coloured as a command line (paintEcho)
   * and not as output: until the shell reports that the command started ('start': bash and zsh), or for this many
   * more lines (PowerShell and cmd report nothing).
   */
  private echoUntil: 'start' | number | null = null;
  /** The command line just sent and where its echo starts, to be coloured once the echo is on screen. */
  private echoPending: { text: string; kind: ShellKind; marker: IMarker; timer: number } | null = null;

  private echoLines(text: string): 'start' | number {
    return isPosix(this.kind) ? 'start' : text.split('\n').length;
  }

  /** Colours output by its words and shape, leaving the echo of the command line alone. */
  private colorize(data: string): string {
    if (!this.settings.colorOutput || this.echoUntil === 'start') return data;
    const palette = paletteFor(this.settings.theme);
    if (typeof this.echoUntil === 'number') {
      const wanted = this.echoUntil;
      let end = -1;
      let seen = 0;
      while (seen < wanted && (end = data.indexOf('\n', end + 1)) !== -1) seen++;
      if (seen < wanted) {
        this.echoUntil = wanted - seen;
        return data;
      }
      this.echoUntil = null;
      return data.slice(0, end + 1) + this.colorizer.push(data.slice(end + 1), palette);
    }
    return this.colorizer.push(data, palette);
  }

  private expectEcho(text: string, marker: IMarker): void {
    this.echoUntil = this.echoLines(text);
    if (!this.settings.colorCommands) return;
    if (this.echoPending) window.clearTimeout(this.echoPending.timer);
    // The shell reports the start of a command (commandStart) or its end (the prompt); for the shells that report
    // neither until the end, look a moment after sending.
    const timer = window.setTimeout(() => this.term.write('', () => this.paintEcho()), 200);
    this.echoPending = { text, kind: this.kind, marker, timer };
  }

  /**
   * Colours the command line as it was echoed into the scrollback. The echo starts at the row of the prompt; it is
   * only coloured when what is on screen is exactly the command that was sent (the shell's echo can differ: tabs,
   * wide characters, a redraw), cell for cell.
   */
  private paintEcho(): void {
    const p = this.echoPending;
    if (!p) return;
    window.clearTimeout(p.timer);
    this.echoPending = null;
    if (this.disposed || !this.settings.colorCommands || p.marker.isDisposed || p.marker.line < 0) return;
    const buf = this.term.buffer.active;
    const cols = this.term.cols;
    const lines: { row: number; offset: number; length: number }[] = [];
    let row = p.marker.line;
    let offset = 0;
    for (const line of p.text.split('\n')) {
      const first = buf.getLine(row);
      if (!first) return;
      let shown = first.translateToString(false);
      let rows = 1;
      while (shown.length < line.length && buf.getLine(row + rows)?.isWrapped) {
        shown += buf.getLine(row + rows)!.translateToString(false);
        rows++;
      }
      if (shown.trimEnd() !== line.trimEnd()) return;
      lines.push({ row, offset, length: line.length });
      row += rows;
      offset += line.length + 1;
    }
    const palette = paletteFor(this.settings.theme);
    const cursorRow = buf.baseY + buf.cursorY;
    for (const t of highlightCommand(p.text, p.kind)) {
      for (const l of lines) {
        const from = Math.max(t.start, l.offset) - l.offset;
        const to = Math.min(t.end, l.offset + l.length) - l.offset;
        for (let at = from; at < to; ) {
          const col = at % cols;
          const width = Math.min(to - at, cols - col);
          const marker = this.term.registerMarker(l.row + Math.floor(at / cols) - cursorRow);
          if (marker) this.term.registerDecoration({ marker, x: col, width, foregroundColor: palette[t.role] });
          at += width;
        }
      }
    }
  }

  // ------------------------------------------------------------------------------------ scrollback marks

  private decorateCommand(marker: IMarker): CommandMark {
    const mark: CommandMark = { decoration: undefined, status: 'running' };
    mark.decoration = this.term.registerDecoration({ marker, x: 0, width: this.term.cols, height: 1, layer: 'bottom' });
    mark.decoration?.onRender((el) => this.paintMark(mark, el));
    return mark;
  }

  private paintMark(mark: CommandMark, el: HTMLElement | undefined = mark.decoration?.element): void {
    if (!el) return;
    el.classList.add('cmd-mark');
    el.dataset.status = mark.status;
  }

  // ------------------------------------------------------------------------------------ sizing

  private scheduleFit(): void {
    cancelAnimationFrame(this.fitFrame);
    this.fitFrame = requestAnimationFrame(() => this.fit());
  }

  private fit(): void {
    if (this.disposed || !this.termEl || this.termEl.offsetWidth === 0 || this.termEl.offsetHeight === 0) return;
    try {
      this.fitAddon.fit();
    } catch {
      // Not measurable yet (fonts loading); the resize observer will retry.
    }
  }
}

function replaceLine(view: EditorView, text: string, select?: [number, number] | null): void {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: select ? { anchor: select[0], head: select[1] } : { anchor: text.length },
  });
}

/** Panel rows: suggestions for the word at the cursor, examples, then your history with the tool. */
function panelEntries(res: CompletionResult | null): PanelEntry[] {
  if (!res) return [];
  const entries: PanelEntry[] = res.items.map((item) => ({
    section: 'suggestions',
    label: item.label,
    description: item.description,
    detail: item.detail,
    dangerous: item.dangerous,
    apply: (view) => {
      const insert = item.insert + (item.suffix ?? '');
      const to = Math.min(res.to, view.state.doc.length);
      view.dispatch({ changes: { from: res.from, to, insert }, selection: { anchor: res.from + insert.length } });
    },
  }));
  for (const ex of res.examples ?? []) {
    const filled = fillExample(ex.command);
    entries.push({ section: 'examples', label: filled.text, description: ex.text, apply: (view) => replaceLine(view, filled.text, filled.select) });
  }
  for (const cmd of res.history ?? []) {
    entries.push({ section: 'history', label: cmd, apply: (view) => replaceLine(view, cmd) });
  }
  return entries;
}

/** Errors before warnings; among them, problems with a fix first, then left to right. */
function rank(d: Diagnostic): number {
  return (d.severity === 'error' ? 0 : 1000) + (d.fix ? 0 : 500) + d.from;
}
