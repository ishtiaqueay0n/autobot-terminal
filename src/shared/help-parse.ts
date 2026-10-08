import type { KbArg, KbOption, KbSpec } from './kb-types';

/**
 * Turns a tool's `--help` output into a spec: options (with whether they take a value) and subcommands.
 * Handles the common layouts: GNU (`-a, --all  text`), Go/cobra (`--format string  text`,
 * `--all-namespaces=false:`), Python argparse (`-o OUTPUT, --output OUTPUT`) and command lists under headers
 * like "Commands:" or "Available Commands:". Anything it does not recognize is ignored, so a strange help
 * page yields a smaller spec, never a wrong one.
 */
export function parseHelp(tool: string, text: string): KbSpec {
  const lines = text
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/.\x08/g, '')
    .split(/\r?\n/);
  const options = new Map<string, KbOption>();
  const subcommands = new Map<string, KbSpec>();
  let description: string | undefined;
  let section: 'commands' | 'options' | 'other' = 'other';
  let lastOption: KbOption | null = null;
  let lastIndent = 0;
  // Windows tools put the description under a "Description:" header, indented.
  let describing = false;

  for (const line of lines) {
    if (!line.trim()) {
      lastOption = null;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (isHeader(trimmed, indent)) {
      const h = trimmed.toLowerCase();
      if (/\b(commands?|subcommands?|actions)\b/.test(h) && !/\boptions?\b/.test(h)) section = 'commands';
      else if (/\b(options?|flags|arguments)\b/.test(h)) section = 'options';
      else section = 'other';
      lastOption = null;
      describing = /^description:?$/.test(h);
      continue;
    }

    const opt = parseOptionLine(line);
    if (opt) {
      for (const n of opt.names) if (!options.has(n)) options.set(n, opt);
      lastOption = opt;
      lastIndent = indent;
      continue;
    }

    // Description continuation for the previous option (deeper indent or a tab-indented block).
    if (lastOption && (indent > lastIndent + 2 || line.startsWith('\t'))) {
      if (!lastOption.description) lastOption.description = trimmed;
      else if (lastOption.description.length < 160) lastOption.description += ` ${trimmed}`;
      continue;
    }
    lastOption = null;

    // Command lists: anything under a commands header, plus git-style "   name     Description" lines.
    const strong = section !== 'options' && GIT_STYLE_COMMAND.test(line);
    if (section === 'commands' || strong) {
      const cmd = COMMAND_LINE.exec(line) ?? BARE_COMMAND_LINE.exec(line);
      if (cmd && cmd[1] !== tool) {
        const aliases = (cmd[2] ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (!subcommands.has(cmd[1])) {
          subcommands.set(cmd[1], clean({ names: [cmd[1], ...aliases], description: shorten(cmd[3]) }));
        }
        continue;
      }
    }

    // The first plain line is the description, but not a synopsis ("usage: ...", "tool [OPTIONS]...").
    const synopsis =
      /^usage\b/i.test(trimmed) ||
      trimmed === tool ||
      // Windows tools print the synopsis in capitals: "TASKLIST [/S system] [/FI filter] ...".
      (trimmed.toLowerCase().startsWith(`${tool.toLowerCase()} `) && /[[<{]|\.\.\.|\bOPTIONS\b|\bCOMMAND\b/.test(trimmed));
    if (!description && section === 'other' && (indent === 0 || describing) && !synopsis && /[a-z]/.test(trimmed)) {
      describing = false;
      description = shorten(trimmed);
    }
  }

  for (const o of options.values()) if (o.description) o.description = shorten(o.description);
  return clean({
    names: [tool],
    description,
    options: [...new Set(options.values())],
    subcommands: [...subcommands.values()],
  });
}

/** "Commands:", "Available Commands:", "List of Main Commands:", "OPTIONS". No wide gaps (those are rows). */
function isHeader(trimmed: string, indent: number): boolean {
  if (indent > 2 || trimmed.startsWith('-') || /\s{2,}/.test(trimmed)) return false;
  return (trimmed.endsWith(':') && trimmed.length <= 70) || /^[A-Z][A-Z ]{2,30}$/.test(trimmed);
}

const COMMAND_LINE = /^\s{0,8}([a-z][\w:.-]*)\*?((?:\s*,\s*[a-z][\w.-]*)*)(?:\s{2,}|\t+|\s+-\s+)(\S.*)$/;
const BARE_COMMAND_LINE = /^\s{1,8}([a-z][\w:.-]*)\*?\s*$/;
const GIT_STYLE_COMMAND = /^\s{2,4}[a-z][\w-]*\*?\s{3,}[A-Z]/;

const NAME = String.raw`(?:--?[A-Za-z0-9?][\w.-]*|/[A-Za-z?][\w-]*)`;
/**
 * A value placeholder: <x>, [x] (one level of nesting, e.g. [=[+]INTEGER]), UPPER, {a,b}, optionally
 * followed by "..." for repeatable values, or one lowercase type word after a single space (cobra).
 */
const VALUE = String.raw`(?:(?:[=\s]?(?:<[^>]+>|\[(?:[^\[\]]|\[[^\]]*\])+\]|[A-Z][A-Z0-9_-]*|\{[^}]+\})|\s[a-z][\w-]*)(?:\.\.\.)?)`;
/**
 * Names are separated by ", " / " | " (GNU, argparse) or a single space (systemd: "-M --machine=X"). The
 * description follows after 2+ spaces or a tab, or after one space when the value ends in ] or > (a
 * column that overflowed).
 */
const OPTION_LINE = new RegExp(
  String.raw`^\s{0,12}(${NAME}(?:${VALUE})?(?:(?:\s*[,|]\s*|\s)${NAME}(?:${VALUE})?)*)(=\S*?)?(:)?(?:\s{2,}|\t+|(?<=[\]>])\s(?=\S)|\s*$)(.*)$`,
);

function parseOptionLine(line: string): KbOption | null {
  const m = OPTION_LINE.exec(line);
  if (!m) return null;
  const spec = m[1];
  const names = [...spec.matchAll(new RegExp(NAME, 'g'))].map((x) => x[0]);
  // "-" alone, "--" and things like "/usr/bin" are not options.
  const valid = names.filter((n) => n.length > 1 && n !== '--' && !/^\/[a-z]+\//.test(n));
  if (valid.length === 0) return null;
  // Windows-style "/x" names only count when the line has no dash-style names.
  const dashed = valid.filter((n) => n.startsWith('-'));
  const finalNames = dashed.length ? dashed : valid;

  let takesValue = new RegExp(`${NAME}${VALUE}`).test(spec);
  // cobra's "--flag=default:" form: a boolean default means no value.
  const cobraDefault = m[2];
  if (cobraDefault !== undefined) takesValue = !/^=(true|false)$/.test(cobraDefault);
  const description = m[4]?.trim() || undefined;
  const option: KbOption = { names: finalNames, ...(description ? { description } : {}) };
  if (takesValue) option.args = [placeholderArg(spec)];
  return option;
}

function placeholderArg(spec: string): KbArg {
  // Prefer <name>, then an UPPERCASE word (even inside brackets: [=[+]INTEGER]), then [name], then a type word.
  const name = (
    /<([^>]+)>/.exec(spec)?.[1] ??
    /\b([A-Z][A-Z0-9_-]+)\b/.exec(spec)?.[1] ??
    /\[=?([^\]]+)\]/.exec(spec)?.[1] ??
    /\s([a-z][\w-]*)$/.exec(spec)?.[1] ??
    'value'
  ).toLowerCase();
  const arg: KbArg = { name };
  if (/\[/.test(spec)) arg.optional = true;
  if (/file|path|dir|folder/.test(name)) arg.templates = /dir|folder/.test(name) ? ['folders'] : ['filepaths'];
  return arg;
}

function shorten(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 180 ? `${t.slice(0, 179).trimEnd()}…` : t || undefined;
}

function clean<T extends object>(obj: T): T {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || (Array.isArray(v) && v.length === 0)) delete (obj as Record<string, unknown>)[k];
  }
  return obj;
}
