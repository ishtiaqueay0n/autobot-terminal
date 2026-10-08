import type { KbExample } from './kb-types';

export type ShellKind = 'bash' | 'zsh' | 'powershell' | 'cmd';

/**
 * What history and habits are filed under: the shell ("bash"), or for a shell reached over SSH the shell on that
 * machine ("bash@alice@prod-db"). Commands you run elsewhere never mix with your local ones.
 */
export type HistoryKey = string;

/** The machine a prompt belongs to when it is not this one (an ssh session with Autobot's helper loaded). */
export interface RemoteContext {
  /** user@host as the remote shell reports it. */
  host: string;
  shell: 'bash' | 'zsh';
}

/** Where the shell's paths live, used to map its cwd back to a path the main process can read. */
export type PathStyle = 'windows' | 'posix' | 'wsl';

export interface ShellProfile {
  id: string;
  name: string;
  kind: ShellKind;
  pathStyle: PathStyle;
  /** WSL distro name, only for pathStyle 'wsl'. */
  wslDistro?: string;
}

export interface Settings {
  fontFamily: string;
  fontSize: number;
  theme: 'dark' | 'light';
  /** Profile id to open in new tabs; null picks the first detected profile. */
  defaultProfile: string | null;
  scrollback: number;
  cursorBlink: boolean;
  /** Gray inline suggestion from history while typing. */
  ghostText: boolean;
  /** Import existing bash / PSReadLine history once, the first time each shell is seen. */
  importHistory: boolean;
  /** Open the suggestion dropdown automatically while typing (Tab and Ctrl+Space always work). */
  dropdown: boolean;
  /** Tools whose helpers may contact remote services for live values, e.g. ["kubectl"]. */
  networkHelpers: string[];
  /** Learn tools you use by reading their --help (safely: real binaries only, never denied tools). */
  learnTools: boolean;
  /** Underline mistakes while typing (unknown commands and options, missing paths, syntax). */
  errorChecks: boolean;
  /** Destructive commands (rm -rf /, mkfs, dd to a disk ...) need a second Enter. */
  dangerConfirm: boolean;
  /** AI help: Claude (needs an API key), a local Ollama model, or off. */
  llmProvider: LlmProvider;
  /** Claude model id. */
  llmModel: string;
  /** Ollama server and model, used when llmProvider is "ollama". */
  ollamaUrl: string;
  ollamaModel: string;
  /** Let the AI describe your tools and their options in the background. Only tool and option names are sent. */
  llmLearn: boolean;
  /** For tools with no local help, let Claude search the web (billed per search). */
  llmWebSearch: boolean;
  /** An AI section in the Ctrl+Space panel. */
  llmPanel: boolean;
  /** At most this many background AI requests per day. */
  llmDailyLimit: number;
  /** Suggestions inside ssh sessions: ask each time, always on, or never (bash and zsh tabs). */
  sshIntegration: SshIntegration;
  /** Colour the command line by what each word is (command type, options, paths, strings ...), also in scrollback. */
  colorCommands: boolean;
  /** Colour what commands print by its words and shape (errors, warnings, paths, addresses, numbers, diffs ...). */
  colorOutput: boolean;
}

export type SshIntegration = 'ask' | 'on' | 'off';

export type LlmProvider = 'anthropic' | 'ollama' | 'off';

/** What the AI settings dialog shows; the API key itself never leaves the main process. */
export interface AiStatus {
  provider: LlmProvider;
  model: string;
  /** Where the Claude API key comes from. */
  keySource: 'keychain' | 'env' | null;
  /** The OS can store a key encrypted (Keychain, DPAPI, libsecret/kwallet). */
  canStoreKey: boolean;
  /** Requests can be made (provider configured, key present for Claude). */
  ready: boolean;
  /** The last request's error, if it failed (e.g. a rejected key). */
  lastError: string | null;
}

/** Ctrl+. result: a fix for the last failed command, or why there is none. */
export type AiFixResult = { ok: true; fix: FixSuggestion } | { ok: false; message: string };

/** The AI section of the Ctrl+Space panel. */
export type AiExplainResult =
  | { ok: true; summary: string; examples: KbExample[]; cached: boolean }
  | { ok: false; message: string };

export type DiagnosticCode =
  | 'unknown-command'
  | 'unknown-subcommand'
  | 'unknown-option'
  | 'missing-value'
  | 'missing-path'
  | 'syntax'
  | 'danger';

/** A problem found in the command line while typing. Errors are certain; warnings are likely. */
export interface Diagnostic {
  from: number;
  to: number;
  severity: 'error' | 'warning';
  code: DiagnosticCode;
  message: string;
  /** One-click correction: replaces the text between from and to. */
  fix?: { label: string; insert: string };
}

/** What to do after a command failed, shown above the input; `command` is offered as ghost text. */
export interface FixSuggestion {
  title: string;
  detail?: string;
  command?: string;
  /** Who suggested it: built-in rules (default) or the AI. */
  source?: 'rules' | 'ai';
}

export type CompletionKind = 'command' | 'subcommand' | 'option' | 'value' | 'file' | 'folder' | 'variable';

export interface CompletionItem {
  label: string;
  /** Replaces the text between `from` and `to`. */
  insert: string;
  kind: CompletionKind;
  description?: string;
  /** Short tag on the right: "yours", "verified", "branch" ... */
  detail?: string;
  /** Added after `insert` when accepted: a space, "=", or nothing for folders so completion continues. */
  suffix?: string;
  dangerous?: boolean;
}

export type CompletionReason = 'auto' | 'tab' | 'panel';

export interface CompletionResult {
  from: number;
  to: number;
  items: CompletionItem[];
  /** The command being completed, for the Ctrl+Space panel. */
  tool?: { name: string; description?: string; source: string | null };
  /** Examples for the tool (panel): from tldr-pages, or written by the AI when tldr has none. */
  examples?: KbExample[];
  examplesSource?: 'ai';
  /** Your recent commands with this tool (panel). */
  history?: string[];
  /** Knowledge was still loading (first use of a PowerShell command): ask again shortly. */
  retry?: boolean;
}

export type SessionEvent =
  | { type: 'data'; data: string }
  | { type: 'prompt'; exitCode: number; cwd: string; gitBranch: string | null; remote?: RemoteContext }
  /** A suggestion for the command that just failed (arrives shortly after its prompt). */
  | { type: 'fix'; command: string; fix: FixSuggestion }
  | { type: 'commandStart' }
  | { type: 'property'; key: string; value: string };

export interface SessionInfo {
  sessionId: number;
  profile: ShellProfile;
  /** Set on Windows so xterm.js matches ConPTY's reflow behavior. */
  windowsPty?: { backend: 'conpty'; buildNumber: number };
}

export interface AutobotApi {
  platform: string;
  listProfiles(): Promise<ShellProfile[]>;
  createSession(profileId: string | null, cols: number, rows: number): Promise<SessionInfo>;
  write(sessionId: number, data: string): void;
  /** Runs a command from the input editor; `record` stores it in history once it finishes. */
  submit(sessionId: number, text: string, record: boolean): void;
  /** Ghost-text candidate (the full command) for the text typed so far, or null. */
  suggest(sessionId: number, text: string): Promise<string | null>;
  /** Recent distinct commands for this session's shell, newest first. */
  historyRecent(sessionId: number): Promise<string[]>;
  /** Suggestions for the word at `cursor`. */
  complete(sessionId: number, text: string, cursor: number, reason: CompletionReason): Promise<CompletionResult | null>;
  /** Problems in the command line. Words the cursor is still in are skipped unless `submit` is set. */
  check(sessionId: number, text: string, cursor: number, submit: boolean): Promise<Diagnostic[]>;
  resize(sessionId: number, cols: number, rows: number): void;
  kill(sessionId: number): void;
  onSessionEvents(listener: (sessionId: number, events: SessionEvent[]) => void): () => void;
  onSessionExit(listener: (sessionId: number, exitCode: number) => void): () => void;
  getSettings(): Promise<Settings>;
  onSettingsChanged(listener: (settings: Settings) => void): () => void;
  /** Ctrl+.: ask the AI to fix the tab's last failed command. */
  aiFix(sessionId: number): Promise<AiFixResult>;
  /** AI notes for the command being typed (the Ctrl+Space panel's AI section). */
  aiExplain(sessionId: number, text: string, cursor: number): Promise<AiExplainResult>;
  aiStatus(): Promise<AiStatus>;
  /** Stores the Claude API key encrypted by the OS; an empty string removes it. */
  aiSetKey(key: string): Promise<{ ok: boolean; message?: string; status: AiStatus }>;
  /** Sends a tiny request to check the configuration. */
  aiTest(): Promise<{ ok: boolean; message: string }>;
  /** Changes settings.json (only the given fields). */
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  readClipboard(): Promise<string>;
  writeClipboard(text: string): void;
  openExternal(url: string): void;
}
