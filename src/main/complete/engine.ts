import type { KbArg } from '../../shared/kb-types';
import { contextAt, splitCommands, toolName, type Word } from '../../shared/tokenize';
import type { CompletionItem, CompletionReason, CompletionResult, ShellKind } from '../../shared/types';
import { foldsCase } from '../../shared/shell';
import { cmdBuiltin } from '../kb/cmd-builtins';
import type { HistoryStore, CommandAnalysis } from '../history/store';
import { hostPath, type EnvRef } from '../kb/exec';
import type { Knowledge } from '../kb/knowledge';
import type { Helpers } from './helpers';
import { completePath, quoteForShell, type PathContext } from './paths';
import type { RemoteFs } from './remote-fs';
import { availableOptions, currentArg, findOption, isOptionWord, walk, type SpecSource, type WalkState } from './walker';

/** What the engine needs to know about a terminal tab. */
export interface CompletionSession {
  shell: ShellKind;
  env: EnvRef;
  /** Folder and home as the shell reports them. */
  cwd: string | null;
  home: string | null;
  /** Command names available in this shell (PATH programs, aliases, functions, cmdlets). */
  commands: () => string[];
  variables: () => string[];
  /** Looks at the disk of the machine the shell runs on when that is not this one (ssh). */
  remoteFs?: RemoteFs;
  /** Makes sure PowerShell parameter metadata for a command is known (PowerShell tabs only). */
  ensurePowerShell?: (command: string) => Promise<void>;
}

export interface EngineDeps {
  knowledge: Knowledge;
  helpers: Helpers;
  history: () => HistoryStore | null;
}

const AUTO_LIMIT = 60;
const PANEL_LIMIT = 400;
const PS_WAIT_MS = 2500;

const POWERSHELL_VARIABLES = ['$_', '$PSItem', '$PSVersionTable', '$PWD', '$HOME', '$LASTEXITCODE', '$Error', '$null', '$true', '$false', '$args', '$input', '$Host', '$PROFILE', '$env:'];
/** Variables cmd.exe computes itself; the others come from the environment. */
const CMD_VARIABLES = ['CD', 'DATE', 'TIME', 'ERRORLEVEL', 'RANDOM', 'CMDCMDLINE', 'CMDEXTVERSION', 'HIGHESTNUMANODENUMBER'];

export class CompletionEngine {
  constructor(private readonly deps: EngineDeps) {}

  /** A spec source bound to one environment (walker interface). */
  source(env: EnvRef, shell: ShellKind): SpecSource {
    const { knowledge } = this.deps;
    return {
      // cmd.exe's own commands come first: `dir` there is not PowerShell's Get-ChildItem alias.
      root: (tool) => (shell === 'cmd' ? cmdBuiltin(tool) : null) ?? knowledge.root(env.id, tool),
      child: (tool, path, sub) => knowledge.child(env.id, tool, path, sub),
    };
  }

  /** One-line description of a tool for the dropdown and panel. */
  private describe(s: Pick<CompletionSession, 'env' | 'shell'>, tool: string): string | undefined {
    return (s.shell === 'cmd' ? cmdBuiltin(tool)?.description : undefined) ?? this.deps.knowledge.description(s.env.id, tool);
  }

  /** True when the bundled knowledge has this tool (it is a real, installable program). */
  knowsTool(name: string): boolean {
    return this.deps.knowledge.bundled.has(name);
  }

  /** What a finished command line teaches about your habits (for HistoryStore usage learning). */
  analyze(env: EnvRef, shell: ShellKind, line: string): CommandAnalysis[] {
    const out: CommandAnalysis[] = [];
    for (const part of splitCommands(line, shell)) {
      const ctx = contextAt(part, part.length, shell);
      const words = ctx.words.filter((w) => w.value !== '' || w.quote !== '');
      if (ctx.commandIndex < 0 || ctx.commandIndex >= words.length) continue;
      const tool = toolName(words[ctx.commandIndex].value, shell);
      const state = walk(tool, words.slice(ctx.commandIndex + 1).map((w) => w.value), this.source(env, shell), foldsCase(shell), shell === 'cmd');
      if (state && state.usage.length) out.push({ tool, usage: state.usage });
    }
    return out;
  }

  /** The command at the cursor: its tool, the subcommands typed after it and the options known there. */
  commandAt(env: EnvRef, shell: ShellKind, text: string, cursor: number): { tool: string; path: string[]; options: string[] } | null {
    const ctx = contextAt(text, cursor, shell);
    if (ctx.commandIndex < 0 || ctx.commandIndex >= ctx.words.length) return null;
    const toolWord = ctx.words[ctx.commandIndex].value;
    if (!toolWord || ctx.index === ctx.commandIndex) return toolWord ? { tool: toolName(toolWord, shell), path: [], options: [] } : null;
    const tool = toolName(toolWord, shell);
    const args = ctx.words.slice(ctx.commandIndex + 1, ctx.index).map((w) => w.value);
    const state = walk(tool, args, this.source(env, shell), foldsCase(shell), shell === 'cmd');
    if (!state) return { tool, path: [], options: [] };
    const options = [...(state.node.options ?? []), ...state.inherited].filter((o) => !o.hidden).flatMap((o) => o.names.slice(0, 1));
    return { tool, path: state.path, options };
  }

  async complete(s: CompletionSession, text: string, cursor: number, reason: CompletionReason): Promise<CompletionResult | null> {
    const ctx = contextAt(text, cursor, s.shell);
    const cur = ctx.words[ctx.index];
    const prefix = cur.value;
    const limit = reason === 'panel' ? PANEL_LIMIT : AUTO_LIMIT;
    const result = (items: CompletionItem[], from = cur.start): CompletionResult | null =>
      items.length || reason === 'panel' ? { from, to: cursor, items: items.slice(0, limit) } : null;

    if (s.shell === 'cmd' ? prefix.startsWith('%') : prefix.startsWith('$') && cur.quote !== "'") return result(this.variables(s, prefix));
    if (cur.redirect) return result(await this.paths(s, cur, false));

    if (ctx.index === ctx.commandIndex) {
      if (reason === 'auto' && !prefix) return null;
      if (/[\\/]/.test(prefix) || prefix.startsWith('.')) return result(await this.paths(s, cur, false));
      const commands = prefix || reason !== 'panel' ? this.commandItems(s, prefix) : [];
      // PowerShell: start fetching parameter metadata for the likely command while its name is typed.
      if (s.ensurePowerShell) for (const c of commands.slice(0, 3)) void s.ensurePowerShell(toolName(c.label, s.shell));
      const res = result(commands);
      if (res && reason === 'panel') {
        // Panel on a fresh line: your recent commands (matching what is typed so far).
        const fold = foldsCase(s.shell);
        const want = fold ? prefix.toLowerCase() : prefix;
        res.history = (this.deps.history()?.recent(s.shell, 500) ?? [])
          .filter((c) => (fold ? c.toLowerCase() : c).startsWith(want))
          .slice(0, 30);
      }
      return res;
    }

    const toolWord = ctx.words[ctx.commandIndex].value;
    const tool = toolName(toolWord, s.shell);
    let stillLoading = false;
    if (s.shell === 'powershell' && s.ensurePowerShell) {
      stillLoading = await Promise.race([
        s.ensurePowerShell(tool).then(() => false),
        new Promise<boolean>((r) => setTimeout(() => r(true), PS_WAIT_MS)),
      ]);
    }
    const args = ctx.words.slice(ctx.commandIndex + 1, ctx.index).map((w) => w.value);
    const fold = foldsCase(s.shell);
    const slash = s.shell === 'cmd';
    const state = walk(tool, args, this.source(s.env, s.shell), fold, slash);

    let items: CompletionItem[] = [];
    let from = cur.start;
    if (!state) {
      if (reason !== 'auto') items = await this.paths(s, cur, false);
    } else if (state.pending) {
      items = await this.valueItems(s, state, state.pending.args?.[0], `val:${state.path.join(' ')}:${state.pending.names[0]}`, cur, prefix);
    } else if (!state.afterDoubleDash && (isOptionWord(prefix, slash) || prefix === (slash ? '/' : '-'))) {
      const eq = slash ? prefix.search(/[:=]/) : prefix.indexOf('=');
      const opt = eq > 0 ? findOption(state, prefix.slice(0, eq), fold) : null;
      if (opt?.args?.length) {
        from = cur.start + (cur.quote ? 1 : 0) + eq + 1;
        const valueWord: Word = { ...cur, value: prefix.slice(eq + 1), start: from, quote: '' };
        items = await this.valueItems(s, state, opt.args[0], `val:${state.path.join(' ')}:${opt.names[0]}`, valueWord, valueWord.value);
      } else {
        items = this.optionItems(s, state, prefix);
      }
    } else {
      const subs = state.positional === 0 ? this.subcommandItems(s, state, prefix) : [];
      const arg = currentArg(state);
      const values = arg ? await this.valueItems(s, state, arg, `pos:${state.path.join(' ')}:${Math.min(state.positional, 3)}`, cur, prefix) : [];
      items = [...subs, ...values];
      if (!items.length && reason !== 'auto') items = await this.paths(s, cur, false);
    }

    if (stillLoading && !items.length) return { from, to: cursor, items: [], retry: true };
    const res = result(items, from);
    if (res && reason === 'panel') this.decoratePanel(res, s, tool, toolWord);
    return res;
  }

  // ------------------------------------------------------------------------------------------- item builders

  private commandItems(s: CompletionSession, prefix: string): CompletionItem[] {
    const fold = foldsCase(s.shell) || s.env.kind === 'windows';
    const want = fold ? prefix.toLowerCase() : prefix;
    const usage = new Map((this.deps.history()?.topTools(s.shell, 200) ?? []).map((t) => [fold ? t.tool.toLowerCase() : t.tool, t.count]));
    const seen = new Set<string>();
    const items: (CompletionItem & { score: number })[] = [];
    for (const name of s.commands()) {
      const key = fold ? name.toLowerCase() : name;
      if (seen.has(key) || !key.startsWith(want)) continue;
      seen.add(key);
      const description = this.describe(s, toolName(name, s.shell));
      const count = usage.get(key) ?? 0;
      items.push({
        label: name,
        insert: name,
        kind: 'command',
        description,
        detail: count ? 'yours' : undefined,
        suffix: ' ',
        // Your tools first, then documented ones, then short names (likely the base command), then A-Z.
        score: count * 1000 + (description ? 100 : 0) - name.length,
      });
    }
    return sortByScore(items);
  }

  private subcommandItems(s: CompletionSession, state: WalkState, prefix: string): CompletionItem[] {
    const subs = state.node.subcommands ?? [];
    const usage = this.usage(s, state.tool, `sub:${state.path.join(' ')}`);
    return rankMatching(
      subs.filter((x) => !x.hidden),
      (x) => x.names,
      prefix,
      foldsCase(s.shell),
      (x, name) => ({
        label: name,
        insert: name,
        kind: 'subcommand',
        description: x.description,
        detail: usage.get(x.names[0]) ? 'yours' : x.verified ? 'verified' : undefined,
        suffix: ' ',
        dangerous: x.dangerous,
      }),
      (x) => (usage.get(x.names[0]) ?? 0) * 10 + (x.verified ? 1 : 0),
    );
  }

  private optionItems(s: CompletionSession, state: WalkState, prefix: string): CompletionItem[] {
    const usage = this.usage(s, state.tool, `opt:${state.path.join(' ')}`);
    const options = availableOptions(state).filter((o) => (!o.hidden || o.names.some((n) => n === prefix)) && (o.repeatable || !state.used.has(o)));
    const longOnly = prefix.startsWith('--');
    return rankMatching(
      options,
      (o) => (longOnly ? o.names.filter((n) => n.startsWith('--')) : o.names),
      prefix,
      foldsCase(s.shell),
      (o, name) => ({
        label: name,
        insert: name,
        kind: 'option',
        description: o.description,
        detail: usage.get(o.names[0]) ? 'yours' : o.verified ? 'verified' : o.names.filter((n) => n !== name).join(', ') || undefined,
        suffix: o.separator && o.args?.length ? o.separator : ' ',
        dangerous: o.dangerous,
      }),
      (o) => (usage.get(o.names[0]) ?? 0) * 10 + (o.verified ? 1 : 0) + (o.required ? 2 : 0),
      // An option has several names; show the one that matches what was typed (long ones after "--").
      preferredName(prefix),
    );
  }

  private async valueItems(
    s: CompletionSession,
    state: WalkState,
    arg: KbArg | undefined,
    slot: string,
    word: Word,
    prefix: string,
  ): Promise<CompletionItem[]> {
    const fold = foldsCase(s.shell);
    const usage = this.usage(s, state.tool, slot);
    const byName = new Map<string, CompletionItem & { score: number }>();
    const add = (name: string, description: string | undefined, detail: string | undefined, score: number) => {
      const key = fold ? name.toLowerCase() : name;
      const existing = byName.get(key);
      if (existing) {
        existing.score = Math.max(existing.score, score);
        if (detail === 'yours') existing.detail = 'yours';
        return;
      }
      byName.set(key, {
        label: name,
        insert: quoteForShell(name, s.shell, word.quote, false),
        kind: 'value',
        description,
        detail,
        suffix: ' ',
        score,
      });
    };

    // Your own values for this slot come first.
    for (const [value, count] of usage) add(value, undefined, 'yours', count * 10);
    for (const sug of arg?.suggestions ?? []) add(sug.name, sug.description, undefined, 0);
    // Helpers (git branches, containers ...) look at this machine; they are no use for a shell on another one.
    if (arg?.helpers?.length && s.env.kind !== 'ssh') {
      const ctx = {
        env: s.env,
        cwd: s.cwd,
        cwdHost: s.cwd ? hostPath(s.env, s.cwd) : null,
        homeHost: s.home ? hostPath(s.env, s.home) : null,
      };
      const results = await Promise.all(arg.helpers.map((h) => this.deps.helpers.run(h, ctx)));
      for (const list of results) for (const sug of list) add(sug.name, sug.description, undefined, 1);
    }

    const want = fold ? prefix.toLowerCase() : prefix;
    let items = sortByScore([...byName.values()].filter((i) => (fold ? i.label.toLowerCase() : i.label).startsWith(want)));
    if (arg?.templates?.length) {
      const paths = await this.paths(s, word, !arg.templates.includes('filepaths'));
      items = [...items, ...paths];
    }
    return items;
  }

  private async paths(s: CompletionSession, word: Word, foldersOnly: boolean): Promise<CompletionItem[]> {
    const ctx: PathContext = {
      shell: s.shell,
      windowsPaths: s.env.kind === 'windows',
      cwd: s.cwd,
      home: s.home,
      toHost: (p) => hostPath(s.env, p),
      remote: s.remoteFs,
    };
    return completePath(word, ctx, foldersOnly);
  }

  private variables(s: CompletionSession, prefix: string): CompletionItem[] {
    if (s.shell === 'cmd') {
      const want = prefix.toLowerCase();
      const names = [...new Set([...CMD_VARIABLES, ...Object.keys(process.env)].map((v) => `%${v}%`))];
      // No trailing space: a variable is usually part of a longer path (%USERPROFILE%\Documents).
      return names
        .filter((n) => n.toLowerCase().startsWith(want))
        .sort((a, b) => a.length - b.length || a.localeCompare(b))
        .map((n) => ({ label: n, insert: n, kind: 'variable' as const, suffix: '' }));
    }
    const names =
      s.shell === 'powershell'
        ? [...POWERSHELL_VARIABLES, ...Object.keys(process.env).map((k) => `$env:${k}`)]
        : [...s.variables(), ...(s.env.kind === 'ssh' ? [] : Object.keys(process.env))].map((v) => `$${v}`);
    const fold = foldsCase(s.shell);
    const want = fold ? prefix.toLowerCase() : prefix;
    const seen = new Set<string>();
    return names
      .filter((n) => {
        const key = fold ? n.toLowerCase() : n;
        if (seen.has(key) || !key.startsWith(want)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.length - b.length || a.localeCompare(b))
      .map((n) => ({ label: n, insert: n, kind: 'variable' as const, suffix: n === '$env:' ? '' : ' ' }));
  }

  private usage(s: CompletionSession, tool: string, slot: string): Map<string, number> {
    try {
      return this.deps.history()?.usage(s.shell, tool, slot) ?? new Map();
    } catch {
      return new Map();
    }
  }

  private decoratePanel(res: CompletionResult, s: CompletionSession, tool: string, toolWord: string): void {
    const { knowledge } = this.deps;
    const builtin = s.shell === 'cmd' && cmdBuiltin(tool);
    res.tool = { name: toolWord, description: this.describe(s, tool), source: builtin ? 'builtin' : knowledge.source(s.env.id, tool) };
    const page = knowledge.bundled.page(tool, s.env.kind === 'windows' ? 'windows' : 'linux');
    if (page?.examples.length) {
      res.examples = page.examples;
    } else {
      const ai = knowledge.aiExamples(s.env.id, tool);
      if (ai.length) {
        res.examples = ai;
        res.examplesSource = 'ai';
      }
    }
    const fold = foldsCase(s.shell);
    const lead = fold ? `${toolWord.toLowerCase()} ` : `${toolWord} `;
    res.history = (this.deps.history()?.recent(s.shell, 2000) ?? [])
      .filter((c) => (fold ? c.toLowerCase() : c).startsWith(lead))
      .slice(0, 20);
  }
}

/**
 * Keeps items with a name starting with the prefix (case-insensitive when `fold`, otherwise exact-case
 * matches first and case-insensitive ones only if there are none), ranked by score, then spec order.
 */
function rankMatching<T>(
  entries: T[],
  names: (x: T) => string[],
  prefix: string,
  fold: boolean,
  make: (x: T, name: string) => CompletionItem,
  score: (x: T) => number,
  pick: (matching: string[]) => string = (m) => m[0],
): CompletionItem[] {
  const collect = (insensitive: boolean) => {
    const want = insensitive ? prefix.toLowerCase() : prefix;
    const out: { item: CompletionItem; score: number; order: number }[] = [];
    entries.forEach((x, order) => {
      const matching = names(x).filter((n) => (insensitive ? n.toLowerCase() : n).startsWith(want));
      if (matching.length) out.push({ item: make(x, pick(matching)), score: score(x), order });
    });
    return out;
  };
  let found = collect(fold);
  if (!fold && found.length === 0) found = collect(true);
  return found.sort((a, b) => b.score - a.score || a.order - b.order).map((f) => f.item);
}

function preferredName(prefix: string): (matching: string[]) => string {
  return (matching) => {
    if (prefix.startsWith('--')) return matching.find((n) => n.startsWith('--')) ?? matching[0];
    // With just "-" typed, show the long name (more readable); short names still match when typed.
    if (prefix === '-') return matching.find((n) => n.startsWith('--')) ?? matching[0];
    return [...matching].sort((a, b) => a.length - b.length)[0];
  };
}

function sortByScore<T extends CompletionItem & { score: number }>(items: T[]): CompletionItem[] {
  return items
    .sort((a, b) => b.score - a.score)
    .map(({ score: _score, ...item }) => item);
}
