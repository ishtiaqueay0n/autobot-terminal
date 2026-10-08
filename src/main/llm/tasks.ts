import type { KbExample, KbOption, KbSpec } from '../../shared/kb-types';
import { SHELL_NAMES } from '../../shared/shell';
import type { FixSuggestion, ShellKind } from '../../shared/types';
import type { JsonRequest, ObjectSchema } from './client';

/**
 * What Autobot asks the AI, and how answers are checked before they are used. Answers are never trusted
 * as-is: lengths are capped, commands must be one line for the right tool, and option names the AI
 * mentions are only kept when they match what is known about the tool.
 */


const str = { type: 'string' } as const;

function object(properties: Record<string, unknown>): ObjectSchema {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

const EXAMPLES = { type: 'array', items: object({ command: str, description: str }) };

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const t = value.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object') : [];
}

/** The first word of a command line, compared the way the shell would. */
function startsWithTool(command: string, tool: string, fold: boolean): boolean {
  const first = command.trimStart().split(/\s+/)[0] ?? '';
  return fold ? first.toLowerCase() === tool.toLowerCase() : first === tool;
}

/** Examples: one line each, for this tool, at most `max`, using only `allowedOptions` when given. */
export function cleanExamples(value: unknown, tool: string, fold: boolean, max: number, allowedOptions?: Set<string>): KbExample[] {
  const out: KbExample[] = [];
  for (const e of list(value)) {
    const command = typeof e.command === 'string' ? e.command.trim() : '';
    if (!command || /[\r\n]/.test(command) || command.length > 300 || !startsWithTool(command, tool, fold)) continue;
    if (allowedOptions && !optionsKnown(command, allowedOptions, fold)) continue;
    out.push({ command, text: text(e.description, 160) });
    if (out.length >= max) break;
  }
  return out;
}

/** Every option-looking word in the command (outside {{placeholders}}) is a known option name. */
function optionsKnown(command: string, allowed: Set<string>, fold: boolean): boolean {
  const words = command.replace(/\{\{.*?\}\}/g, 'X').split(/\s+/).slice(1);
  for (const w of words) {
    if (!/^--?[A-Za-z]/.test(w)) continue;
    const name = w.split('=')[0];
    if (allowed.has(fold ? name.toLowerCase() : name)) continue;
    // Combined short flags (-la) count when every letter is a known flag.
    if (/^-[A-Za-z]{2,}$/.test(name) && [...name.slice(1)].every((c) => allowed.has(`-${c}`))) continue;
    return false;
  }
  return true;
}

/** All option names anywhere in a spec, for checking examples. */
export function optionNames(spec: KbSpec | null, fold: boolean): Set<string> {
  const names = new Set<string>();
  const visit = (node: KbSpec, depth: number) => {
    for (const o of node.options ?? []) for (const n of o.names) names.add(fold ? n.toLowerCase() : n);
    if (depth < 3) for (const s of node.subcommands ?? []) visit(s, depth + 1);
  };
  if (spec) visit(spec, 0);
  return names;
}

// ------------------------------------------------------------------------------------------- fix (Ctrl+.)

export interface FixInput {
  command: string;
  exitCode: number;
  /** End of the output, already redacted. */
  output: string;
  shell: ShellKind;
  os: string;
  packageManager: string | null;
}

const FIX_SYSTEM = `You help someone fix a terminal command that just failed. You get the shell, the operating system, the command, its exit code and the end of its output.

Call report_fix with:
- explanation: what went wrong and what to do about it, in one or two short sentences.
- command: one corrected command for the same shell, on a single line, that does what the person meant. Use an empty string when the fix is not a single command (for example editing a file) or when you cannot tell what they meant.

Prefer the smallest change to their command. Values shown as *** were hidden for privacy; keep *** where it appears.`;

export function fixRequest(input: FixInput): JsonRequest {
  const prompt = [
    `Shell: ${SHELL_NAMES[input.shell]}`,
    `Operating system: ${input.os}${input.packageManager ? ` (package manager: ${input.packageManager})` : ''}`,
    `Exit code: ${input.exitCode}`,
    'Command:',
    input.command,
    'End of the output:',
    input.output.trim() || '(no output)',
  ].join('\n');
  return {
    system: FIX_SYSTEM,
    prompt,
    answer: {
      name: 'report_fix',
      description: 'Report what went wrong with the command and a corrected command.',
      schema: object({ explanation: str, command: str }),
    },
    maxTokens: 1024,
    timeoutMs: 45_000,
  };
}

export function parseFix(value: unknown, failed: string): FixSuggestion | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const explanation = text(v.explanation, 400);
  let command = typeof v.command === 'string' ? v.command.trim() : '';
  if (/[\r\n]/.test(command) || command.length > 2000 || command === failed.trim()) command = '';
  if (!explanation && !command) return null;
  const fix: FixSuggestion = { title: explanation || 'Try this instead:', source: 'ai' };
  // A masked secret cannot be put back automatically: show the idea, not a command that would fail.
  if (command.includes('***')) fix.detail = `Suggested: ${command} (put your hidden value back in place of ***)`;
  else if (command) fix.command = command;
  return fix;
}

// ------------------------------------------------------------------------------------------- panel notes

export interface ExplainInput {
  tool: string;
  /** Subcommands typed after the tool. */
  path: string[];
  shell: ShellKind;
  os: string;
  /** Option names known for the command at `path` (a hint, so examples use real options). */
  knownOptions: string[];
}

const EXPLAIN_SYSTEM = `You write the help panel of a terminal for one command-line tool.

Call show_notes with:
- summary: what the tool (or the given subcommand) does, in one or two plain sentences.
- examples: three to six common, useful command lines for it, each with a short description. Write each command for the given shell and operating system, starting with the tool name, and put the parts the user must fill in inside double braces, like {{path/to/file}}.

Use only options you are sure exist. If you do not know the tool, return an empty summary and no examples.`;

export function explainRequest(input: ExplainInput): JsonRequest {
  const command = [input.tool, ...input.path].join(' ');
  const prompt = [
    `Command: ${command}`,
    `Shell: ${SHELL_NAMES[input.shell]}`,
    `Operating system: ${input.os}`,
    input.knownOptions.length ? `Options it accepts: ${input.knownOptions.slice(0, 60).join(' ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return {
    system: EXPLAIN_SYSTEM,
    prompt,
    answer: { name: 'show_notes', description: 'Show a summary and examples in the help panel.', schema: object({ summary: str, examples: EXAMPLES }) },
    maxTokens: 1500,
    timeoutMs: 45_000,
  };
}

export function parseExplain(value: unknown, tool: string, fold: boolean): { summary: string; examples: KbExample[] } | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const summary = text(v.summary, 400);
  const examples = cleanExamples(v.examples, tool, fold, 6);
  return summary || examples.length ? { summary, examples } : null;
}

// ------------------------------------------------------------------------------------------- background notes

/**
 * What the AI added about a tool. `spec` keeps descriptions (and, for tools nothing else knows, the
 * options and subcommands it named). Knowledge decides how much of it to use: for a tool known from local
 * help or the bundled data, only descriptions; options the AI names are never added there.
 */
export interface AiNotes {
  spec: KbSpec | null;
  examples: KbExample[];
  /** The AI could not identify the tool (do not ask again for a while). */
  unknown?: boolean;
}

export interface DescribeInput {
  tool: string;
  shell: ShellKind;
  os: string;
  /** What is known locally (bundled + learned). */
  spec: KbSpec;
}

const DESCRIBE_SYSTEM = `You document a command-line tool for a terminal's suggestions. Its options and subcommands were read from the tool installed on the user's machine; you add short descriptions and examples.

Call save_tool_notes with:
- description: what the tool does, in one sentence of at most 12 words, without a trailing period.
- options and subcommands: for each listed name you are sure about, a description of at most 10 words without a trailing period. Leave out names you are unsure of.
- examples: three to five common command lines using only the listed options, each with a short description. Start each with the tool name and put the parts the user must fill in inside double braces, like {{path/to/file}}.`;

const NAMED = { type: 'array', items: object({ name: str, description: str }) };

export function describeRequest(input: DescribeInput): JsonRequest {
  const options = (input.spec.options ?? []).filter((o) => !o.hidden).slice(0, 80);
  const subs = (input.spec.subcommands ?? []).filter((s) => !s.hidden).slice(0, 80);
  const prompt = [
    `Tool: ${input.tool}`,
    `Shell: ${SHELL_NAMES[input.shell]}`,
    `Operating system: ${input.os}`,
    input.spec.description ? `Known description: ${input.spec.description}` : '',
    options.length ? `Options: ${options.map((o) => o.names.join('|')).join(' ')}` : 'Options: (none known)',
    subs.length ? `Subcommands: ${subs.map((s) => s.names[0]).join(' ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return {
    system: DESCRIBE_SYSTEM,
    prompt,
    answer: {
      name: 'save_tool_notes',
      description: 'Save descriptions and examples for the tool.',
      schema: object({ description: str, options: NAMED, subcommands: NAMED, examples: EXAMPLES }),
    },
    maxTokens: 4000,
    timeoutMs: 60_000,
  };
}

export function parseDescribe(value: unknown, input: DescribeInput, fold: boolean): AiNotes | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const key = (n: string) => (fold ? n.toLowerCase() : n);
  const optionDescriptions = new Map(list(v.options).map((o) => [key(String(o.name ?? '')), text(o.description, 120)]));
  const subDescriptions = new Map(list(v.subcommands).map((s) => [key(String(s.name ?? '')), text(s.description, 120)]));
  // Only names the tool itself listed, with the AI's description.
  const options: KbOption[] = [];
  for (const o of input.spec.options ?? []) {
    const d = o.names.map((n) => optionDescriptions.get(key(n))).find(Boolean);
    if (d) options.push({ names: o.names, description: d });
  }
  const subcommands: KbSpec[] = [];
  for (const s of input.spec.subcommands ?? []) {
    const d = s.names.map((n) => subDescriptions.get(key(n))).find(Boolean);
    if (d) subcommands.push({ names: s.names, description: d });
  }
  const description = text(v.description, 120).replace(/\.$/, '');
  const examples = cleanExamples(v.examples, input.tool, fold, 5, optionNames(input.spec, fold));
  return { spec: { names: [input.tool], description: description || undefined, options, subcommands }, examples };
}

export interface ResearchInput {
  tool: string;
  shell: ShellKind;
  os: string;
  webSearch: boolean;
}

const RESEARCH_SYSTEM = `You document a command-line tool for a terminal's suggestions. Nothing about it is known locally.

If you are not certain what this tool is, look up its official documentation with web search when that is available. Call save_tool_notes with:
- known: false if you could not identify the tool with confidence; then leave the other fields empty.
- description: what the tool does, in one sentence of at most 12 words, without a trailing period.
- subcommands and options: the most commonly used ones, written exactly as typed (for example --output), each with a description of at most 10 words; say whether each option takes a value.
- examples: three to five common command lines, each with a short description. Start each with the tool name and put the parts the user must fill in inside double braces, like {{path/to/file}}.`;

export function researchRequest(input: ResearchInput): JsonRequest {
  return {
    system: RESEARCH_SYSTEM,
    prompt: [`Tool: ${input.tool}`, `Shell: ${SHELL_NAMES[input.shell]}`, `Operating system: ${input.os}`].join('\n'),
    answer: {
      name: 'save_tool_notes',
      description: 'Save what is known about the tool.',
      schema: object({
        known: { type: 'boolean' },
        description: str,
        subcommands: NAMED,
        options: { type: 'array', items: object({ names: { type: 'array', items: str }, description: str, takesValue: { type: 'boolean' } }) },
        examples: EXAMPLES,
      }),
    },
    maxTokens: 6000,
    webSearches: input.webSearch ? 3 : undefined,
    timeoutMs: 120_000,
  };
}

export function parseResearch(value: unknown, tool: string, fold: boolean): AiNotes | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.known === false) return { spec: null, examples: [], unknown: true };
  const options: KbOption[] = [];
  for (const o of list(v.options).slice(0, 80)) {
    const names = (Array.isArray(o.names) ? o.names : []).filter((n): n is string => typeof n === 'string' && /^--?[A-Za-z0-9][\w-]*$/.test(n));
    if (!names.length) continue;
    options.push({ names, description: text(o.description, 120) || undefined, args: o.takesValue === true ? [{ name: 'value' }] : undefined });
  }
  const subcommands: KbSpec[] = [];
  for (const s of list(v.subcommands).slice(0, 60)) {
    const name = typeof s.name === 'string' ? s.name.trim() : '';
    if (/^[A-Za-z0-9][\w.:-]*$/.test(name)) subcommands.push({ names: [name], description: text(s.description, 120) || undefined });
  }
  const description = text(v.description, 120).replace(/\.$/, '');
  const spec: KbSpec = { names: [tool], description: description || undefined, options, subcommands };
  const examples = cleanExamples(v.examples, tool, fold, 5, optionNames(spec, fold));
  if (!description && !options.length && !subcommands.length) return { spec: null, examples: [], unknown: true };
  return { spec, examples };
}
