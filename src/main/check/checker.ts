import { readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { RemoteFs } from '../complete/remote-fs';
import { join } from 'node:path';
import { assessDanger } from '../../shared/danger';
import { closest } from '../../shared/fuzzy';
import type { KbArg, KbSpec } from '../../shared/kb-types';
import { foldsCase } from '../../shared/shell';
import { syntaxIssues } from '../../shared/syntax';
import { commandSegments, contextAt, findCommand, toolName, type Word } from '../../shared/tokenize';
import type { Diagnostic, ShellKind } from '../../shared/types';
import { findGitDir } from '../complete/helpers';
import { availableOptions, findOption, isOptionWord, takesValue, type SpecSource, type WalkState } from '../complete/walker';
import type { HistoryStore } from '../history/store';
import { hostPath, type EnvRef } from '../kb/exec';
import type { Knowledge } from '../kb/knowledge';

export interface CheckSession {
  shell: ShellKind;
  env: EnvRef;
  cwd: string | null;
  home: string | null;
  /** Command names available in this shell, or null while they are still loading (no command checks then). */
  commands(): string[] | null;
  /** Looks at the disk of the machine the shell runs on when that is not this one (ssh). */
  remoteFs?: RemoteFs;
}

export interface CheckerDeps {
  source(env: EnvRef, shell: ShellKind): SpecSource;
  knowledge: Knowledge;
  history(): HistoryStore | null;
}

/** Changing directory into something that does not exist always fails. */
const CD_TOOLS = new Set(['cd', 'pushd', 'chdir', 'set-location', 'sl', 'push-location']);
/** Tools whose path arguments are often new files or folders: missing paths are not flagged for them. */
const CREATES = new Set([
  'touch', 'mkdir', 'md', 'cp', 'copy', 'mv', 'move', 'ln', 'install', 'tee', 'wget', 'curl', 'git', 'tar', 'zip',
  'unzip', 'gzip', 'rsync', 'scp', 'sftp', 'nano', 'vi', 'vim', 'nvim', 'emacs', 'code', 'notepad', 'dd', 'ssh-keygen',
  'openssl', 'truncate', 'mktemp', 'new-item', 'ni', 'set-content', 'sc', 'add-content', 'ac', 'out-file',
  'export-csv', 'export-clixml', 'copy-item', 'cpi', 'move-item', 'mi', 'rename-item', 'ren', 'expand-archive',
  'compress-archive', 'start-transcript', 'docker', 'npm', 'npx', 'pip', 'pip3', 'python', 'python3', 'node',
]);
const PS_KEYWORDS = new Set([
  'if', 'elseif', 'else', 'foreach', 'for', 'while', 'do', 'until', 'switch', 'function', 'filter', 'param', 'begin',
  'process', 'end', 'try', 'catch', 'finally', 'throw', 'trap', 'return', 'break', 'continue', 'exit', 'class', 'enum',
  'using', 'data', 'dynamicparam', 'workflow', 'parallel', 'sequence', 'inlinescript', 'configuration',
]);

type Out = Diagnostic[];

/**
 * Finds problems in a command line while it is typed. Words the cursor is still in are left alone (they
 * are unfinished), unless the line is being submitted.
 */
export class Checker {
  constructor(private readonly deps: CheckerDeps) {}

  async check(s: CheckSession, text: string, cursor: number, submit: boolean): Promise<Diagnostic[]> {
    const out: Out = [];
    const pending: Promise<void>[] = [];
    const finished = (w: Word) => submit || cursor < w.start || cursor > w.end;

    for (const issue of syntaxIssues(text, s.shell)) out.push({ ...issue, severity: 'error', code: 'syntax' });

    for (const seg of commandSegments(text, s.shell)) {
      const segText = text.slice(seg.start, seg.end);
      const ctx = contextAt(segText, segText.length, s.shell);
      const words = ctx.words
        .filter((w) => w.value !== '' || w.quote !== '')
        .map((w) => ({ ...w, start: w.start + seg.start, end: w.end + seg.start }));
      if (!words.length) continue;

      for (const w of words) {
        if (w.redirect === 'in' && finished(w)) pending.push(this.pathCheck(s, w, 'error', 'any', out));
      }
      const ci = findCommand(words, s.shell);
      const cmd = words[ci];
      if (!cmd || cmd.redirect) continue;

      const danger = assessDanger(segText, s.shell);
      if (danger) {
        out.push({ from: cmd.start, to: seg.end, severity: danger.level === 'confirm' ? 'error' : 'warning', code: 'danger', message: danger.reason });
      }
      if (!finished(cmd)) continue;

      const known = this.commandIssue(s, cmd, out, pending);
      if (!known) continue;
      this.argIssues(s, toolName(cmd.value, s.shell), words.slice(ci + 1), finished, out, pending);
    }

    await Promise.all(pending);
    return out.sort((a, b) => a.from - b.from);
  }

  // ------------------------------------------------------------------------------------------- commands

  /** Checks the command name; returns false when it is unknown (its arguments are then not checked). */
  private commandIssue(s: CheckSession, w: Word, out: Out, pending: Promise<void>[]): boolean {
    const value = w.value;
    const fold = foldsCase(s.shell) || s.env.kind === 'windows';
    if (w.quote) return true;
    // cmd.exe expands %VARIABLES% before running anything, so what the word becomes is not known here.
    if (s.shell === 'cmd' && value.includes('%')) return true;
    if (/[\\/]/.test(value) || value.startsWith('.')) {
      if (value !== '.' && value !== '..') pending.push(this.pathCheck(s, w, 'error', 'file', out, 'No such file'));
      return true;
    }
    // Only plain names: not $variables, [types], 1..10 ranges, globs and the like.
    if (!/^[A-Za-z_][\w.+-]*$/.test(value)) return true;
    if (s.shell === 'powershell' && PS_KEYWORDS.has(value.toLowerCase())) return true;

    const list = s.commands();
    if (!list) return true;
    const name = toolName(value, s.shell);
    const eq = (a: string) => (fold ? a.toLowerCase() === value.toLowerCase() || a.toLowerCase() === name : a === value);
    if (list.some(eq)) return true;
    const history = this.deps.history();
    if (history?.usedSuccessfully(s.shell, value)) return true;

    const usage = new Map((history?.topTools(s.shell, 300) ?? []).map((t) => [fold ? t.tool.toLowerCase() : t.tool, t.count]));
    const suggestion = closest(value, list, { fold, rank: (c) => usage.get(fold ? c.toLowerCase() : c) ?? 0 });
    const installable = this.deps.knowledge.bundled.has(name);
    out.push({
      from: w.start,
      to: w.end,
      severity: 'error',
      code: 'unknown-command',
      message: suggestion
        ? `'${value}' is not a command. Did you mean '${suggestion}'?`
        : installable
          ? `'${value}' is not installed here.`
          : `'${value}' is not a command here.`,
      fix: suggestion ? { label: `Use '${suggestion}'`, insert: suggestion } : undefined,
    });
    return false;
  }

  // ------------------------------------------------------------------------------------------- arguments

  private argIssues(
    s: CheckSession,
    tool: string,
    args: Word[],
    finished: (w: Word) => boolean,
    out: Out,
    pending: Promise<void>[],
  ): void {
    const fold = foldsCase(s.shell);
    const slash = s.shell === 'cmd';
    if (CD_TOOLS.has(tool.toLowerCase())) {
      const target = args.find((w) => !isOptionWord(w.value, slash));
      if (target && finished(target)) pending.push(this.pathCheck(s, target, 'error', 'folder', out));
      return;
    }
    const root = this.deps.source(s.env, s.shell).root(tool);
    if (!root) return;

    const st: WalkState = { tool, node: root, path: [], inherited: [], used: new Set(), pending: null, positional: 0, afterDoubleDash: false, usage: [] };
    const creates = CREATES.has(tool.toLowerCase());
    let pendingWord: Word | null = null;
    const label = () => [tool, ...st.path].join(' ');

    for (const w of args) {
      const v = w.value;
      const isOpt = !st.afterDoubleDash && isOptionWord(v, slash);

      if (st.pending) {
        if (isOpt && finished(w) && !st.pending.args?.[0].optional) {
          out.push({
            from: pendingWord!.start,
            to: pendingWord!.end,
            severity: 'error',
            code: 'missing-value',
            message: `'${pendingWord!.value}' needs a value (${st.pending.args?.[0].name ?? 'value'}) before the next option.`,
          });
          st.pending = null;
        } else {
          const arg = st.pending.args?.[0];
          if (arg && finished(w) && !creates) this.valuePathCheck(s, arg, w, out, pending);
          st.pending = null;
          continue;
        }
      }

      if (!st.afterDoubleDash && v === '--') {
        st.afterDoubleDash = true;
        continue;
      }

      if (isOpt) {
        const sepAt = fold ? v.search(/[:=]/) : v.indexOf('=');
        const name = sepAt > 0 ? v.slice(0, sepAt) : v;
        const opt = findOption(st, name, fold);
        if (opt) {
          if (sepAt < 0 && takesValue(opt)) {
            st.pending = opt;
            pendingWord = w;
          }
          continue;
        }
        if (!v.startsWith('--') && /^-[A-Za-z0-9]/.test(v)) {
          // -n5 (value attached to a short option) or -la (combined short flags).
          const first = findOption(st, v.slice(0, 2), false);
          if (first && takesValue(first)) continue;
          const flags = [...v.slice(1)].map((c) => findOption(st, `-${c}`, false));
          if (flags.every(Boolean)) {
            const last = flags[flags.length - 1]!;
            if (takesValue(last)) {
              st.pending = last;
              pendingWord = w;
            }
            continue;
          }
        }
        if (finished(w)) out.push(this.unknownOption(s, st, name, w, sepAt > 0 ? v.slice(sepAt) : '', label()));
        continue;
      }

      if (st.positional === 0 && st.node.subcommands?.length) {
        const sub = st.node.subcommands.find((x) => x.names.some((n) => (fold ? n.toLowerCase() === v.toLowerCase() : n === v)));
        if (sub) {
          st.inherited = [...st.inherited, ...(st.node.options ?? []).filter((o) => o.persistent)];
          st.path.push(sub.names[0]);
          st.node = this.deps.source(s.env, s.shell).child(tool, st.path, sub);
          continue;
        }
        if (!st.node.args?.length) {
          if (finished(w) && !this.isPluginOrAlias(s, tool, v)) out.push(this.unknownSubcommand(st.node, v, w, label(), fold));
          return; // the rest of the line belongs to something Autobot does not know
        }
      }

      const arg = positionalArg(st.node, st.positional);
      if (arg?.isCommand) return;
      if (arg && finished(w) && !creates) this.valuePathCheck(s, arg, w, out, pending);
      st.positional++;
    }
  }

  private unknownOption(s: CheckSession, st: WalkState, name: string, w: Word, rest: string, label: string): Diagnostic {
    const fold = foldsCase(s.shell);
    const options = availableOptions(st);
    const verifiedCount = options.filter((o) => o.verified).length;
    const sure = Boolean(st.node.verified) && (verifiedCount >= 3 || this.deps.knowledge.learnedSource(s.env.id, st.tool) === 'powershell');
    const names = options.filter((o) => !o.hidden).flatMap((o) => o.names);
    const suggestion = closest(name, names, { fold });
    return {
      from: w.start,
      to: w.start + name.length + (w.quote ? 1 : 0),
      severity: sure ? 'error' : 'warning',
      code: 'unknown-option',
      message: sure
        ? `'${name}' is not an option of ${label}.${suggestion ? ` Did you mean '${suggestion}'?` : ''}`
        : `'${name}' is not in what Autobot knows about ${label}; it may still be valid.${suggestion ? ` Did you mean '${suggestion}'?` : ''}`,
      fix: suggestion ? { label: `Use '${suggestion}'`, insert: suggestion + rest } : undefined,
    };
  }

  private unknownSubcommand(node: KbSpec, v: string, w: Word, label: string, fold: boolean): Diagnostic {
    const names = (node.subcommands ?? []).filter((x) => !x.hidden).flatMap((x) => x.names);
    const suggestion = closest(v, names, { fold });
    return {
      from: w.start,
      to: w.end,
      severity: 'warning',
      code: 'unknown-subcommand',
      message: `'${v}' is not a ${label} subcommand that Autobot knows.${suggestion ? ` Did you mean '${suggestion}'?` : ''}`,
      fix: suggestion ? { label: `Use '${suggestion}'`, insert: suggestion } : undefined,
    };
  }

  /** git aliases and tool plugins on PATH (git-lfs => "git lfs", kubectl-foo => "kubectl foo"). */
  private isPluginOrAlias(s: CheckSession, tool: string, word: string): boolean {
    if (s.commands()?.includes(`${tool}-${word}`)) return true;
    if (tool !== 'git' || s.env.kind === 'ssh') return false;
    const configs: string[] = [];
    if (s.home) configs.push(join(hostPath(s.env, s.home), '.gitconfig'));
    const gitDir = s.cwd ? findGitDir(hostPath(s.env, s.cwd)) : null;
    if (gitDir) configs.push(join(gitDir, 'config'));
    for (const file of configs) {
      try {
        if (gitAliases(readFileSync(file, 'utf8')).includes(word)) return true;
      } catch {
        // no config
      }
    }
    return false;
  }

  // ------------------------------------------------------------------------------------------- paths

  /** Checks a value that the spec says is a path, unless it can also be something else (a branch, a value). */
  private valuePathCheck(s: CheckSession, arg: KbArg, w: Word, out: Out, pending: Promise<void>[]): void {
    if (!arg.templates?.length || arg.helpers?.length || arg.suggestions?.length) return;
    const folders = arg.templates.includes('folders') && !arg.templates.includes('filepaths');
    pending.push(this.pathCheck(s, w, 'warning', folders ? 'folder' : 'any', out));
  }

  private async pathCheck(
    s: CheckSession,
    w: Word,
    severity: Diagnostic['severity'],
    kind: 'any' | 'file' | 'folder',
    out: Out,
    missingLabel?: string,
  ): Promise<void> {
    let v = w.value;
    // Globs, variables, URLs, key=value pairs and PowerShell drives (HKLM:, Env:) are not plain paths.
    if (!v || v === '-' || /[*?[\]{}$`]|:\/\/|=/.test(v) || /^[A-Za-z]{2,}:/.test(v)) return;
    const windowsPaths = s.env.kind === 'windows';
    if (v === '~' || v.startsWith('~/') || v.startsWith('~\\')) {
      if (!s.home) return;
      v = s.home + v.slice(1);
    }
    const absolute = windowsPaths ? /^([A-Za-z]:([\\/]|$)|\\\\)/.test(v) : v.startsWith('/');
    if (!absolute) {
      if (!s.cwd) return;
      v = windowsPaths ? `${s.cwd.replace(/[\\/]+$/, '')}\\${v}` : `${s.cwd.replace(/\/+$/, '')}/${v}`;
    }
    const found = await this.lookUp(s, v);
    if (found === 'unknown') return;
    if (found !== 'missing') {
      if (kind === 'folder' && found !== 'dir') {
        out.push({ from: w.start, to: w.end, severity, code: 'missing-path', message: `'${w.value}' is a file, not a folder.` });
      }
    } else {
      const what = missingLabel ?? (kind === 'folder' ? 'No such folder' : 'Not found');
      out.push({ from: w.start, to: w.end, severity, code: 'missing-path', message: `${what}: ${w.value}` });
    }
  }

  /** What a path is, here or (ssh) on the other machine; 'unknown' when it cannot be told. */
  private async lookUp(s: CheckSession, path: string): Promise<'dir' | 'file' | 'missing' | 'unknown'> {
    if (s.env.kind === 'ssh') return s.remoteFs ? s.remoteFs.kind(path) : 'unknown';
    try {
      return (await stat(hostPath(s.env, path))).isDirectory() ? 'dir' : 'file';
    } catch {
      return 'missing';
    }
  }
}

function positionalArg(node: KbSpec, index: number): KbArg | null {
  const args = node.args;
  if (!args?.length) return null;
  if (index < args.length) return args[index];
  const last = args[args.length - 1];
  return last.variadic ? last : null;
}

/** Alias names from the [alias] section of a git config file. */
export function gitAliases(config: string): string[] {
  const names: string[] = [];
  let inAlias = false;
  for (const line of config.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]/.exec(line);
    if (header) {
      inAlias = header[1].trim().toLowerCase() === 'alias';
      continue;
    }
    const m = inAlias ? /^\s*([\w-]+)\s*=/.exec(line) : null;
    if (m) names.push(m[1]);
  }
  return names;
}
