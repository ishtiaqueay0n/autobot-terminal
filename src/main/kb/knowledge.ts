import type { KbExample, KbOption, KbSource, KbSpec } from '../../shared/kb-types';
import type { BundledKb } from './bundled';
import type { KnowledgeStore } from './store';

/**
 * Merges what the bundled dataset says about a tool with what was learned from the tool installed here.
 * Learned entries are the source of truth: options and subcommands they confirm are marked `verified`,
 * and ones the dataset lacks are added. Bundled-only entries stay, unverified.
 */
export function mergeSpecs(base: KbSpec | null, learned: KbSpec | null): KbSpec | null {
  if (!learned) return base;
  const verify = <T extends KbSpec | KbOption>(x: T): T => ({ ...x, verified: true });
  if (!base) {
    return {
      ...learned,
      options: learned.options?.map(verify),
      subcommands: learned.subcommands?.map(verify),
      verified: true,
    };
  }

  const options = (base.options ?? []).map((o) => ({ ...o }));
  for (const lo of learned.options ?? []) {
    const match = options.find((o) => o.names.some((n) => lo.names.includes(n)));
    if (match) {
      match.verified = true;
      for (const n of lo.names) if (!match.names.includes(n)) match.names.push(n);
      if (!match.args && lo.args) match.args = lo.args;
    } else {
      options.push(verify(lo));
    }
  }

  const subcommands = (base.subcommands ?? []).map((s) => ({ ...s }));
  for (const ls of learned.subcommands ?? []) {
    const match = subcommands.find((s) => s.names.some((n) => ls.names.includes(n)));
    if (match) match.verified = true;
    else subcommands.push(verify(ls));
  }

  return {
    ...base,
    names: [...new Set([...base.names, ...learned.names])],
    description: base.description ?? learned.description,
    options,
    subcommands,
    args: base.args ?? learned.args,
    verified: true,
  };
}

/**
 * Fills in descriptions the AI wrote for options and subcommands that have none. Never adds entries:
 * what a tool accepts comes from the tool itself or the bundled data, not from the AI.
 */
export function addAiDescriptions(spec: KbSpec, notes: KbSpec | null | undefined): KbSpec {
  if (!notes) return spec;
  const texts = (entries: { names: string[]; description?: string }[] | undefined) => {
    const map = new Map<string, string>();
    for (const e of entries ?? []) if (e.description) for (const n of e.names) map.set(n.toLowerCase(), e.description);
    return map;
  };
  const optionText = texts(notes.options);
  const subText = texts(notes.subcommands);
  const fill = <T extends { names: string[]; description?: string }>(e: T, map: Map<string, string>): T => {
    if (e.description) return e;
    const d = e.names.map((n) => map.get(n.toLowerCase())).find(Boolean);
    return d ? { ...e, description: d } : e;
  };
  return {
    ...spec,
    description: spec.description ?? notes.description,
    options: spec.options?.map((o) => fill(o, optionText)),
    subcommands: spec.subcommands?.map((x) => fill(x, subText)),
  };
}

/** Where a tool's knowledge comes from, for the UI. */
export type ToolSource = 'bundled' | 'learned' | 'bundled+learned' | 'powershell' | 'ai';

/** Read access to merged specs, cached per environment, tool and subcommand path. */
export class Knowledge {
  private readonly cache = new Map<string, KbSpec | null>();

  constructor(
    readonly bundled: BundledKb,
    private readonly store: KnowledgeStore | null,
  ) {}

  root(env: string, tool: string): KbSpec | null {
    return this.cached(env, tool, '', () => {
      const merged = mergeSpecs(this.bundled.spec(tool), this.learned(env, tool, '')?.spec ?? null);
      const notes = this.notes(env, tool)?.spec;
      // Only for tools nothing else knows does the AI's spec stand on its own (unverified: yellow marks only).
      if (!merged) return notes ? { ...notes, verified: false } : null;
      return addAiDescriptions(merged, notes);
    });
  }

  /** Expands a subcommand reached at `path`: loads a split-out spec file and merges what was learned there. */
  child(env: string, tool: string, path: string[], sub: KbSpec): KbSpec {
    const key = path.join(' ');
    return (
      this.cached(env, tool, key, () => {
        let node: KbSpec = sub;
        if (sub.loadSpec) {
          const loaded = this.bundled.loadSpec(sub.loadSpec);
          if (loaded) node = { ...loaded, names: sub.names, description: sub.description ?? loaded.description, verified: sub.verified };
        }
        return mergeSpecs(node, this.learned(env, tool, key)?.spec ?? null);
      }) ?? sub
    );
  }

  source(env: string, tool: string): ToolSource | null {
    const learned = this.learned(env, tool, '');
    const bundled = this.bundled.has(tool);
    if (learned?.source === 'powershell') return 'powershell';
    if (learned && bundled) return 'bundled+learned';
    if (learned) return 'learned';
    if (bundled) return 'bundled';
    return this.notes(env, tool)?.spec ? 'ai' : null;
  }

  description(env: string, tool: string): string | undefined {
    return this.root(env, tool)?.description ?? this.bundled.description(tool);
  }

  /** Examples the AI wrote for a tool (shown when there is no tldr page). */
  aiExamples(env: string, tool: string): KbExample[] {
    return this.notes(env, tool)?.examples ?? [];
  }

  /** What the AI added about a tool, with its age (null if never asked). */
  aiNotesEntry(env: string, tool: string) {
    try {
      return this.store?.aiNotes(env, tool) ?? null;
    } catch {
      return null;
    }
  }

  learnedSource(env: string, tool: string): KbSource | null {
    return this.learned(env, tool, '')?.source ?? null;
  }

  /** Drops cached merges for a tool after something new was learned about it. */
  invalidate(env: string, tool: string): void {
    const prefix = `${env}\0${tool}\0`;
    for (const k of this.cache.keys()) if (k.startsWith(prefix)) this.cache.delete(k);
  }

  private notes(env: string, tool: string) {
    const entry = this.aiNotesEntry(env, tool);
    return entry && !entry.notes.unknown ? entry.notes : null;
  }

  private learned(env: string, tool: string, path: string) {
    try {
      return this.store?.get(env, tool, path) ?? null;
    } catch {
      return null;
    }
  }

  private cached(env: string, tool: string, path: string, make: () => KbSpec | null): KbSpec | null {
    const key = `${env}\0${tool}\0${path}`;
    if (this.cache.has(key)) return this.cache.get(key)!;
    const value = make();
    this.cache.set(key, value);
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
    return value;
  }
}
