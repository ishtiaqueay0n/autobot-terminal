/**
 * Knowledge base format: what Autobot knows about a command-line tool. Bundled specs (converted from
 * withfig/autocomplete), specs learned from local --help, and PowerShell introspection all use it.
 */

export type HelperId =
  | 'git.branches'
  | 'git.tags'
  | 'git.remotes'
  | 'docker.containers'
  | 'docker.images'
  | 'docker.networks'
  | 'docker.volumes'
  | 'kubectl.namespaces'
  | 'kubectl.contexts'
  | 'kubectl.pods'
  | 'npm.scripts'
  | 'make.targets'
  | 'ssh.hosts'
  | 'systemd.units';

export type PathTemplate = 'filepaths' | 'folders';

export interface KbSuggestion {
  name: string;
  description?: string;
}

export interface KbArg {
  name?: string;
  description?: string;
  optional?: boolean;
  variadic?: boolean;
  /** The rest of the line is another command (sudo, xargs, time ...). */
  isCommand?: boolean;
  templates?: PathTemplate[];
  suggestions?: KbSuggestion[];
  helpers?: HelperId[];
  dangerous?: boolean;
}

export interface KbOption {
  names: string[];
  description?: string;
  args?: KbArg[];
  /** Also valid on every subcommand below. */
  persistent?: boolean;
  repeatable?: boolean;
  required?: boolean;
  /** The value is attached with this separator (`--opt=value`) instead of being the next word. */
  separator?: string;
  dangerous?: boolean;
  hidden?: boolean;
  /** Confirmed by the installed tool itself (its --help, or PowerShell metadata). Set when sources are merged. */
  verified?: boolean;
}

export interface KbSpec {
  names: string[];
  description?: string;
  subcommands?: KbSpec[];
  options?: KbOption[];
  args?: KbArg[];
  /** This subcommand's details live in another spec file (big CLIs like aws are split). */
  loadSpec?: string;
  dangerous?: boolean;
  hidden?: boolean;
  /** Confirmed by the installed tool itself. Set when sources are merged. */
  verified?: boolean;
}

/** Where knowledge came from. Only local sources count as verified (red underline vs yellow, milestone 4). */
export type KbSource = 'fig' | 'help' | 'powershell';

export interface KbExample {
  text: string;
  command: string;
}

export interface KbTldrPage {
  description?: string;
  examples: KbExample[];
}

export interface KbIndex {
  version: number;
  generatedAt: string;
  /** Tool name → spec file (relative to the kb folder) and a one-line description. */
  fig: Record<string, { file: string; description?: string }>;
}
