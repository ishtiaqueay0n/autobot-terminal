import { existsSync, mkdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { Settings } from '../shared/types';

export const DEFAULT_SETTINGS: Settings = {
  fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, 'DejaVu Sans Mono', 'Ubuntu Mono', 'Liberation Mono', monospace",
  fontSize: 14,
  theme: 'dark',
  defaultProfile: null,
  scrollback: 10000,
  cursorBlink: true,
  ghostText: true,
  importHistory: true,
  dropdown: true,
  networkHelpers: [],
  learnTools: true,
  errorChecks: true,
  dangerConfirm: true,
  llmProvider: 'anthropic',
  llmModel: 'claude-haiku-4-5',
  ollamaUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'llama3.1',
  llmLearn: true,
  llmWebSearch: true,
  llmPanel: false,
  llmDailyLimit: 40,
  sshIntegration: 'ask',
  colorCommands: true,
  colorOutput: true,
};

/** Merges user values over the defaults, dropping anything with the wrong type or out of range. */
export function normalizeSettings(raw: unknown): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return s;
  const r = raw as Record<string, unknown>;
  if (typeof r.fontFamily === 'string' && r.fontFamily.trim()) s.fontFamily = r.fontFamily;
  if (typeof r.fontSize === 'number' && r.fontSize >= 6 && r.fontSize <= 72) s.fontSize = r.fontSize;
  if (r.theme === 'dark' || r.theme === 'light') s.theme = r.theme;
  if (typeof r.defaultProfile === 'string' || r.defaultProfile === null) s.defaultProfile = r.defaultProfile;
  if (typeof r.scrollback === 'number' && r.scrollback >= 0 && r.scrollback <= 1_000_000) {
    s.scrollback = Math.floor(r.scrollback);
  }
  if (typeof r.cursorBlink === 'boolean') s.cursorBlink = r.cursorBlink;
  if (typeof r.ghostText === 'boolean') s.ghostText = r.ghostText;
  if (typeof r.importHistory === 'boolean') s.importHistory = r.importHistory;
  if (typeof r.dropdown === 'boolean') s.dropdown = r.dropdown;
  if (Array.isArray(r.networkHelpers)) s.networkHelpers = r.networkHelpers.filter((x): x is string => typeof x === 'string');
  if (typeof r.learnTools === 'boolean') s.learnTools = r.learnTools;
  if (typeof r.errorChecks === 'boolean') s.errorChecks = r.errorChecks;
  if (typeof r.dangerConfirm === 'boolean') s.dangerConfirm = r.dangerConfirm;
  if (r.llmProvider === 'anthropic' || r.llmProvider === 'ollama' || r.llmProvider === 'off') s.llmProvider = r.llmProvider;
  if (typeof r.llmModel === 'string' && /^[\w.:-]{1,100}$/.test(r.llmModel)) s.llmModel = r.llmModel;
  if (typeof r.ollamaUrl === 'string' && /^https?:\/\/\S+$/.test(r.ollamaUrl)) s.ollamaUrl = r.ollamaUrl.replace(/\/+$/, '');
  if (typeof r.ollamaModel === 'string' && /^[\w./:-]{1,100}$/.test(r.ollamaModel)) s.ollamaModel = r.ollamaModel;
  if (typeof r.llmLearn === 'boolean') s.llmLearn = r.llmLearn;
  if (typeof r.llmWebSearch === 'boolean') s.llmWebSearch = r.llmWebSearch;
  if (typeof r.llmPanel === 'boolean') s.llmPanel = r.llmPanel;
  if (r.sshIntegration === 'ask' || r.sshIntegration === 'on' || r.sshIntegration === 'off') s.sshIntegration = r.sshIntegration;
  if (typeof r.colorCommands === 'boolean') s.colorCommands = r.colorCommands;
  if (typeof r.colorOutput === 'boolean') s.colorOutput = r.colorOutput;
  if (typeof r.llmDailyLimit === 'number' && r.llmDailyLimit >= 0 && r.llmDailyLimit <= 1000) {
    s.llmDailyLimit = Math.floor(r.llmDailyLimit);
  }
  return s;
}

export class SettingsStore {
  readonly file: string;
  private readonly dir: string;
  private current: Settings;
  private watcher: FSWatcher | null = null;
  private listener: ((settings: Settings) => void) | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;

  constructor(dir: string) {
    this.dir = dir;
    this.file = join(dir, 'settings.json');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!existsSync(this.file)) {
      writeFileSync(this.file, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`, 'utf8');
    }
    this.current = this.read() ?? { ...DEFAULT_SETTINGS };
  }

  get(): Settings {
    return this.current;
  }

  /** Calls the listener whenever the file is saved with new values. */
  watch(listener: (settings: Settings) => void): void {
    this.listener = listener;
    this.watcher?.close();
    // Watch the folder, not the file: many editors save by replacing the file, which ends a file watch.
    this.watcher = watch(this.dir, (_event, name) => {
      if (name && name !== 'settings.json') return;
      // Editors often write in several steps; wait for them to finish.
      if (this.reloadTimer) clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => {
        const next = this.read();
        // Invalid JSON mid-edit keeps the last good settings.
        if (next && JSON.stringify(next) !== JSON.stringify(this.current)) {
          this.current = next;
          listener(next);
        }
      }, 150);
    });
  }

  /**
   * Changes the given fields in settings.json, keeping everything else in the file (including keys this
   * version does not know). Invalid values are dropped by normalization, as when the file is edited by hand.
   */
  update(patch: Partial<Settings>): Settings {
    let raw: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
    } catch {
      // Unreadable file: start from the current settings.
      raw = { ...this.current };
    }
    for (const [key, value] of Object.entries(patch)) if (key in DEFAULT_SETTINGS) raw[key] = value;
    const next = normalizeSettings(raw);
    writeFileSync(this.file, `${JSON.stringify(raw, null, 2)}
`, 'utf8');
    if (JSON.stringify(next) !== JSON.stringify(this.current)) {
      this.current = next;
      this.listener?.(next);
    }
    return next;
  }

  dispose(): void {
    this.watcher?.close();
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
  }

  private read(): Settings | null {
    try {
      return normalizeSettings(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch (err) {
      console.error(`[settings] could not read ${this.file}:`, err);
      return null;
    }
  }
}
