import type { KbArg, KbOption, KbSpec } from '../../shared/kb-types';

export interface SpecSource {
  root(tool: string): KbSpec | null;
  /** Expands a subcommand (split-out spec files, learned details) reached at `path`. */
  child(tool: string, path: string[], sub: KbSpec): KbSpec;
}

/** A fact about how a command was used, for ranking suggestions by your habits. */
export interface UsageEntry {
  /** sub:<path> | opt:<path> | val:<path>:<option> | pos:<path>:<n> */
  slot: string;
  value: string;
}

export interface WalkState {
  tool: string;
  node: KbSpec;
  /** Subcommand path walked so far, e.g. ["get"] for "kubectl get". */
  path: string[];
  /** Persistent options from parent commands, valid here too. */
  inherited: KbOption[];
  used: Set<KbOption>;
  /** The previous word was an option that takes a value: the current word is that value. */
  pending: KbOption | null;
  /** Positional arguments already given at this node. */
  positional: number;
  afterDoubleDash: boolean;
  usage: UsageEntry[];
}

/**
 * Walks the words after the command name (not including the word being typed) through the tool's spec.
 * `fold` makes matching case-insensitive and allows unique prefixes of option names, like PowerShell.
 * `slash` is cmd.exe: options look like /s and /a:d.
 */
export function walk(tool: string, args: string[], source: SpecSource, fold: boolean, slash = false): WalkState | null {
  const root = source.root(tool);
  if (!root) return null;
  const s: WalkState = {
    tool,
    node: root,
    path: [],
    inherited: [],
    used: new Set(),
    pending: null,
    positional: 0,
    afterDoubleDash: false,
    usage: [],
  };
  const where = () => s.path.join(' ');

  for (const word of args) {
    if (s.pending) {
      if (learnable(word)) s.usage.push({ slot: `val:${where()}:${s.pending.names[0]}`, value: word });
      s.pending = null;
      continue;
    }
    if (!s.afterDoubleDash && word === '--') {
      s.afterDoubleDash = true;
      continue;
    }
    if (!s.afterDoubleDash && isOptionWord(word, slash)) {
      const eq = slash ? word.search(/[:=]/) : word.indexOf('=');
      const name = eq > 0 ? word.slice(0, eq) : word;
      const opt = findOption(s, name, fold);
      if (opt) {
        s.used.add(opt);
        s.usage.push({ slot: `opt:${where()}`, value: opt.names[0] });
        if (eq > 0 && learnable(word.slice(eq + 1))) s.usage.push({ slot: `val:${where()}:${opt.names[0]}`, value: word.slice(eq + 1) });
        else if (takesValue(opt)) s.pending = opt;
        continue;
      }
      // Combined short flags: -la, -xzf (the last one may take the next word as its value).
      if (/^-[A-Za-z0-9]{2,}$/.test(word)) {
        const flags = [...word.slice(1)].map((c) => findOption(s, `-${c}`, false));
        if (flags.every(Boolean)) {
          for (const f of flags) {
            s.used.add(f!);
            s.usage.push({ slot: `opt:${where()}`, value: f!.names[0] });
          }
          const last = flags[flags.length - 1]!;
          if (takesValue(last)) s.pending = last;
        }
      }
      continue;
    }
    if (s.positional === 0 && s.node.subcommands?.length) {
      const sub = findByName(s.node.subcommands, word, fold);
      if (sub) {
        s.usage.push({ slot: `sub:${where()}`, value: sub.names[0] });
        s.inherited = [...s.inherited, ...(s.node.options ?? []).filter((o) => o.persistent)];
        s.path.push(sub.names[0]);
        s.node = source.child(tool, s.path, sub);
        continue;
      }
    }
    if (learnable(word)) s.usage.push({ slot: `pos:${where()}:${Math.min(s.positional, 3)}`, value: word });
    s.positional++;
  }
  return s;
}

/**
 * Values worth remembering as habits: short single tokens (namespaces, hosts, formats). Free text such as
 * commit messages is not a habit and would only clutter suggestions.
 */
function learnable(value: string): boolean {
  return value.length > 0 && value.length <= 60 && !/\s/.test(value);
}

/** The positional argument the next plain word fills, if the spec defines one. */
export function currentArg(s: WalkState): KbArg | null {
  const args = s.node.args;
  if (!args?.length) return null;
  if (s.positional < args.length) return args[s.positional];
  const last = args[args.length - 1];
  return last.variadic ? last : null;
}

export function takesValue(o: KbOption): boolean {
  return Boolean(o.args?.length && !o.args[0].optional && !o.separator);
}

export function isOptionWord(word: string, slash = false): boolean {
  if (slash) return /^\/[A-Za-z?][\w?:=,+-]*$/.test(word);
  return word.length > 1 && word.startsWith('-') && !/^-\d/.test(word);
}

/** All options valid at the current node: its own plus persistent ones from parents. */
export function availableOptions(s: WalkState): KbOption[] {
  return [...(s.node.options ?? []), ...s.inherited];
}

export function findOption(s: WalkState, name: string, fold: boolean): KbOption | null {
  const all = availableOptions(s);
  const eq = (a: string, b: string) => (fold ? a.toLowerCase() === b.toLowerCase() : a === b);
  const exact = all.find((o) => o.names.some((n) => eq(n, name)));
  if (exact || !fold) return exact ?? null;
  // PowerShell accepts any unique prefix of a parameter name.
  const lower = name.toLowerCase();
  const prefixed = all.filter((o) => o.names.some((n) => n.toLowerCase().startsWith(lower)));
  return prefixed.length === 1 ? prefixed[0] : null;
}

function findByName(subs: KbSpec[], word: string, fold: boolean): KbSpec | null {
  const w = fold ? word.toLowerCase() : word;
  return subs.find((s) => s.names.some((n) => (fold ? n.toLowerCase() : n) === w)) ?? null;
}
