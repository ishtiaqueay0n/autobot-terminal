import type { AiExplainResult, AiFixResult, AiStatus, Settings, ShellKind } from '../../shared/types';
import { foldsCase } from '../../shared/shell';
import { osName } from '../check/packages';
import { debugLog } from '../debug';
import type { EnvRef } from '../kb/exec';
import type { Knowledge } from '../kb/knowledge';
import type { KnowledgeStore } from '../kb/store';
import { AnthropicClient, OllamaClient, type LlmClient, type LlmError } from './client';
import type { KeyStore } from './keystore';
import {
  describeRequest,
  explainRequest,
  fixRequest,
  parseDescribe,
  parseExplain,
  parseFix,
  parseResearch,
  researchRequest,
  type AiNotes,
  type ExplainInput,
  type FixInput,
} from './tasks';

/** Notes about a tool (or the finding that the AI does not know it) are asked for again after this long. */
const NOTES_MAX_AGE_MS = 30 * 86_400_000;
const PANEL_CACHE_MS = 30 * 86_400_000;
/** Background requests wait this long after a command, so local --help learning has finished first. */
const AFTER_COMMAND_MS = 20_000;
const BETWEEN_REQUESTS_MS = 3_000;
/** Names that are scripts or paths are the user's own: never sent. */
const PRIVATE_NAME = /[\\/]|\.(sh|bash|zsh|ps1|psm1|py|rb|pl|js|bat|cmd)$/i;

export interface AiDeps {
  settings: () => Settings;
  keys: KeyStore;
  store: KnowledgeStore | null;
  knowledge: Knowledge;
  /** The program's path when the tool is a real program on PATH (not an alias, function or script). */
  resolve: (env: EnvRef, tool: string) => Promise<string | null>;
  makeClient?: (settings: Settings, apiKey: string | null) => LlmClient | null;
}

interface QueuedTool {
  env: EnvRef;
  shell: ShellKind;
  tool: string;
  notBefore: number;
}

function defaultClient(settings: Settings, apiKey: string | null): LlmClient | null {
  if (settings.llmProvider === 'ollama') return new OllamaClient(settings.ollamaUrl, settings.ollamaModel);
  if (settings.llmProvider === 'anthropic' && apiKey) return new AnthropicClient(apiKey, settings.llmModel);
  return null;
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * AI help, all of it optional: a fix for the last failed command when asked (Ctrl+.), notes in the
 * Ctrl+Space panel when turned on, and descriptions and examples for tools in the background, within a
 * daily request budget. Nothing here runs a command; suggestions go to the input line at most.
 */
export class AiService {
  private current: { signature: string; client: LlmClient | null } | null = null;
  private lastError: string | null = null;
  private readonly queue: QueuedTool[] = [];
  private readonly queued = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private working = false;
  private readonly explaining = new Map<string, Promise<AiExplainResult>>();

  constructor(private readonly deps: AiDeps) {}

  /** The configured client, or null when the AI is off or Claude has no key. */
  client(): LlmClient | null {
    const settings = this.deps.settings();
    const key = settings.llmProvider === 'anthropic' ? (this.deps.keys.get()?.key ?? null) : null;
    const signature = [settings.llmProvider, settings.llmModel, settings.ollamaUrl, settings.ollamaModel, key ?? ''].join('\0');
    if (this.current?.signature !== signature) {
      this.current = { signature, client: (this.deps.makeClient ?? defaultClient)(settings, key) };
      this.lastError = null;
    }
    return this.current.client;
  }

  status(): AiStatus {
    const settings = this.deps.settings();
    return {
      provider: settings.llmProvider,
      model: settings.llmProvider === 'ollama' ? settings.ollamaModel : settings.llmModel,
      keySource: this.deps.keys.get()?.source ?? null,
      canStoreKey: this.deps.keys.canStore(),
      ready: this.client() !== null,
      lastError: this.lastError,
    };
  }

  setKey(key: string): AiStatus {
    this.deps.keys.set(key);
    return this.status();
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    const client = this.client();
    if (!client) return { ok: false, message: this.notReady() };
    const res = await client.json({
      system: 'You check that a connection works.',
      prompt: 'Reply by calling confirm with ok set to true.',
      answer: {
        name: 'confirm',
        description: 'Confirm the connection works.',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
      },
      maxTokens: 200,
      timeoutMs: 30_000,
    });
    if (!res.ok) return { ok: false, message: this.failed(res.error) };
    this.lastError = null;
    return { ok: true, message: `${client.label} is working.` };
  }

  /** Ctrl+.: a fix for a failed command. `input` must already be redacted. */
  async fix(input: FixInput): Promise<AiFixResult> {
    const client = this.client();
    if (!client) return { ok: false, message: this.notReady() };
    const res = await client.json(fixRequest(input));
    if (!res.ok) return { ok: false, message: this.failed(res.error) };
    this.lastError = null;
    const fix = parseFix(res.value, input.command);
    return fix ? { ok: true, fix } : { ok: false, message: 'The AI did not find a fix.' };
  }

  /** Notes for the Ctrl+Space panel, cached per tool and subcommand. */
  explain(envId: string, input: ExplainInput): Promise<AiExplainResult> {
    const client = this.client();
    if (!client) return Promise.resolve({ ok: false, message: this.notReady() });
    const key = ['explain', envId, input.tool, input.path.join(' '), client.model].join('\0');
    const cached = this.deps.store?.aiCached(key, PANEL_CACHE_MS);
    if (cached) {
      try {
        return Promise.resolve({ ok: true, ...(JSON.parse(cached) as { summary: string; examples: [] }), cached: true });
      } catch {
        // Fall through and ask again.
      }
    }
    // The panel refreshes while typing; one request per key at a time.
    let pending = this.explaining.get(key);
    if (!pending) {
      pending = (async (): Promise<AiExplainResult> => {
        const res = await client.json(explainRequest(input));
        if (!res.ok) return { ok: false, message: this.failed(res.error) };
        this.lastError = null;
        const parsed = parseExplain(res.value, input.tool, foldsCase(input.shell));
        if (!parsed) return { ok: false, message: 'The AI has nothing to add here.' };
        this.deps.store?.putAiCache(key, JSON.stringify(parsed));
        return { ok: true, ...parsed, cached: false };
      })().finally(() => this.explaining.delete(key));
      this.explaining.set(key, pending);
    }
    return pending;
  }

  /** A tool was used: describe it in the background if what is known about it has gaps. */
  noteTool(env: EnvRef, shell: ShellKind, tool: string, delayMs = AFTER_COMMAND_MS): void {
    if (!this.learningOn() || !/^[\w.+-]+$/.test(tool) || PRIVATE_NAME.test(tool)) return;
    const id = `${env.id}\0${tool}`;
    if (this.queued.has(id)) return;
    this.queued.add(id);
    this.queue.push({ env, shell, tool, notBefore: Date.now() + delayMs });
    this.schedule(delayMs);
  }

  /** Your most-used tools, ahead of time. */
  prefetch(env: EnvRef, shell: ShellKind, tools: string[]): void {
    for (const tool of tools) this.noteTool(env, shell, tool, 0);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.queue.length = 0;
  }

  /** Whether the knowledge about a tool has gaps the AI could fill. */
  needsNotes(env: EnvRef, tool: string): boolean {
    const { knowledge } = this.deps;
    const entry = knowledge.aiNotesEntry(env.id, tool);
    if (entry && Date.now() - entry.createdAt < NOTES_MAX_AGE_MS) return false;
    const spec = knowledge.root(env.id, tool);
    if (!spec) return true;
    const hasExamples = Boolean(knowledge.bundled.page(tool, env.kind === 'windows' ? 'windows' : 'linux')?.examples.length);
    const undescribed = (spec.options ?? []).filter((o) => !o.hidden && !o.description).length;
    return !spec.description || !hasExamples || undescribed > 3;
  }

  private learningOn(): boolean {
    const s = this.deps.settings();
    return s.llmLearn && s.llmProvider !== 'off' && this.deps.store !== null;
  }

  private budgetLeft(): boolean {
    const store = this.deps.store;
    return Boolean(store) && store!.aiRequests(today()) < this.deps.settings().llmDailyLimit;
  }

  private schedule(delayMs: number): void {
    if (this.working) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.work(), Math.max(0, delayMs));
    this.timer.unref?.();
  }

  private async work(): Promise<void> {
    this.timer = null;
    this.working = true;
    try {
      while (this.queue.length) {
        const now = Date.now();
        const index = this.queue.findIndex((q) => q.notBefore <= now);
        if (index < 0) break;
        const [item] = this.queue.splice(index, 1);
        this.queued.delete(`${item.env.id}\0${item.tool}`);
        try {
          if (await this.describe(item)) await new Promise((r) => setTimeout(r, BETWEEN_REQUESTS_MS));
        } catch (err) {
          console.error('[ai] tool notes failed:', err);
        }
      }
    } finally {
      this.working = false;
    }
    if (this.queue.length) this.schedule(Math.min(...this.queue.map((q) => q.notBefore)) - Date.now());
  }

  /** Asks for notes about one tool; true when a request was made. */
  private async describe({ env, shell, tool }: QueuedTool): Promise<boolean> {
    const { knowledge, store } = this.deps;
    const client = this.client();
    if (!client || !store || !this.learningOn() || !this.budgetLeft() || !this.needsNotes(env, tool)) return false;
    const fold = foldsCase(shell);
    const os = osName(env);
    const source = knowledge.source(env.id, tool);
    const known = knowledge.root(env.id, tool);

    let notes: AiNotes | null;
    if (known && source && source !== 'ai') {
      // Known from the tool itself or the bundled data: the AI only adds descriptions and examples.
      const input = { tool, shell, os, spec: known };
      store.countAiRequest(today());
      const res = await client.json(describeRequest(input));
      if (!res.ok) return this.backgroundFailed(res.error);
      notes = parseDescribe(res.value, input, fold);
    } else {
      // Nothing local: only real programs are looked up, never aliases, functions or scripts.
      if (!(await this.deps.resolve(env, tool))) return false;
      store.countAiRequest(today());
      const webSearch = this.deps.settings().llmWebSearch && client.canSearch;
      const res = await client.json(researchRequest({ tool, shell, os, webSearch }));
      if (!res.ok) return this.backgroundFailed(res.error);
      notes = parseResearch(res.value, tool, fold);
    }
    this.lastError = null;
    store.putAiNotes(env.id, tool, notes ?? { spec: null, examples: [], unknown: true }, client.model);
    knowledge.invalidate(env.id, tool);
    debugLog(`ai: notes for ${tool} in ${env.id}: ${notes?.unknown ? 'unknown tool' : `${notes?.examples.length ?? 0} examples`}`);
    return true;
  }

  private backgroundFailed(error: LlmError): boolean {
    this.failed(error);
    // A rejected key or no connection affects every request: stop until something new comes in.
    if (error.kind === 'auth' || error.kind === 'network') {
      this.queue.length = 0;
      this.queued.clear();
    }
    return true;
  }

  private failed(error: LlmError): string {
    if (error.kind !== 'empty' && error.kind !== 'refused') this.lastError = error.message;
    debugLog(`ai: ${error.kind}: ${error.message}`);
    return error.message;
  }

  private notReady(): string {
    const s = this.deps.settings();
    if (s.llmProvider === 'off') return 'AI help is turned off (AI in the tab bar).';
    return 'Add a Claude API key first (AI in the tab bar).';
  }
}
