import type { FixSuggestion, ShellKind } from '../../shared/types';
import { hasPackageMapping, installCommand, type PackageManager } from './packages';

export interface FailureContext {
  command: string;
  exitCode: number;
  /** The command's output as plain text (the last few KB). */
  output: string;
  shell: ShellKind;
  windows: boolean;
  pm: PackageManager | null;
  /** The nearest known command name for a typo, or null. */
  closestCommand(word: string): string | null;
  /** True for real tools Autobot knows (bundled knowledge): only those get an install suggestion. */
  knownTool(name: string): boolean;
}

const PY_PACKAGES: Record<string, string> = {
  cv2: 'opencv-python', yaml: 'pyyaml', PIL: 'pillow', sklearn: 'scikit-learn', bs4: 'beautifulsoup4',
  dotenv: 'python-dotenv', jwt: 'pyjwt', dateutil: 'python-dateutil', magic: 'python-magic', serial: 'pyserial',
  Crypto: 'pycryptodome', OpenSSL: 'pyopenssl', docx: 'python-docx', pptx: 'python-pptx', fitz: 'pymupdf',
};

/**
 * Reads what went wrong from a failed command's output and suggests the next step. Returns null when no
 * rule applies (Ctrl+C, unknown errors). Pure: no I/O.
 */
export function suggestFix(ctx: FailureContext): FixSuggestion | null {
  const { output, windows } = ctx;
  const cmd = ctx.command.trim();
  if (ctx.exitCode === 0 || ctx.exitCode === 130 || !cmd) return null;
  let m: RegExpExecArray | null;

  // git knows what you meant.
  m = /The most similar commands? (?:is|are)\s*\n\s*([\w-]+)/.exec(output);
  const badGit = /git: '([^']+)' is not a git command/.exec(output)?.[1];
  if (m && badGit && /^git\b/.test(cmd)) {
    return { title: `git doesn't know '${badGit}'. Did you mean '${m[1]}'?`, command: replaceWord(cmd, badGit, m[1]) };
  }
  m = /^\s*(git push --set-upstream \S+ \S+)\s*$/m.exec(output);
  if (m) return { title: 'This branch has no upstream branch yet.', detail: 'Push it and set the upstream:', command: m[1] };
  if (/^git push\b/.test(cmd) && /\[rejected\]|non-fast-forward|fetch first|tip of your current branch is behind/i.test(output)) {
    return { title: 'The remote has commits you do not have yet.', detail: 'Pull them first (your work is replayed on top), then push again:', command: 'git pull --rebase' };
  }

  // Command not found: a typo, or not installed.
  const missing =
    /(?:^|\n)(?:[\w./-]+: )?command not found: ([\w.+-]+)/.exec(output)?.[1] ?? // zsh: "zsh: command not found: foo"
    /(?:^|\n)(?:[\w./-]+: )?(?:line \d+: )?([\w.+-]+): command not found/.exec(output)?.[1] ?? // bash: "bash: foo: command not found"
    /Command '([\w.+-]+)' not found/.exec(output)?.[1] ??
    /The term '([^']+)' is not recognized as (?:the |a )?name of a cmdlet/.exec(output)?.[1] ??
    /'([^'\r\n]+)' is not recognized as an internal or external command/.exec(output)?.[1]; // cmd.exe
  if (missing || (ctx.exitCode === 127 && !windows) || (ctx.exitCode === 9009 && ctx.shell === 'cmd')) {
    const name = missing ?? cmd.split(/\s+/)[0];
    const typo = ctx.closestCommand(name);
    if (typo) return { title: `'${name}' is not a command. Did you mean '${typo}'?`, command: replaceWord(cmd, name, typo) };
    // The system's own command-not-found helper knows the exact package (Ubuntu, Fedora).
    const offered = /^\s*(sudo (?:apt|dnf|yum|snap|zypper)\s+install\s+\S+)/m.exec(output)?.[1];
    if (offered) return { title: `'${name}' is not installed.`, detail: 'Install it with:', command: offered.replace(/\s+/g, ' ') };
    // Otherwise only real tools get an install suggestion; a random typo does not.
    if (ctx.pm && /^[\w.+-]+$/.test(name) && (ctx.knownTool(name) || hasPackageMapping(name, ctx.pm))) {
      const install = installCommand(name, ctx.pm);
      return { title: `'${name}' is not installed.`, detail: install.startsWith('winget search') ? 'Look for it with:' : 'Install it with:', command: install };
    }
    return { title: `'${name}' is not a command here.` };
  }

  if (/running scripts is disabled on this system/i.test(output)) {
    return { title: 'PowerShell blocks scripts on this computer.', detail: 'Allow your own and signed scripts for your account:', command: 'Set-ExecutionPolicy -Scope CurrentUser RemoteSigned' };
  }

  // Permissions.
  if (!windows && /docker\.sock/.test(output) && /permission denied/i.test(output)) {
    return {
      title: "You don't have access to the Docker daemon.",
      detail: 'Add yourself to the docker group, then log out and back in (or run the command with sudo):',
      command: 'sudo usermod -aG docker $USER',
    };
  }
  if (!windows && !/^(sudo|doas)\b/.test(cmd) && /permission denied|operation not permitted|are you root|must be run as root|superuser privileges|requires root|EACCES|could not open lock file/i.test(output)) {
    return { title: 'This needs administrator rights.', detail: 'Run it again with sudo:', command: `sudo ${cmd}` };
  }
  if (windows && /access to the path .* is denied|requires elevation|run as administrator|access is denied|administrator privileges/i.test(output)) {
    return {
      title: 'This needs administrator rights.',
      detail: `Start Autobot with "Run as administrator", or run this command in an elevated ${ctx.shell === 'cmd' ? 'Command Prompt' : 'PowerShell'}.`,
    };
  }

  // Missing language packages.
  m = /No module named '?([\w.]+)'?/.exec(output);
  if (m) {
    const mod = m[1].split('.')[0];
    const pkg = PY_PACKAGES[mod] ?? mod;
    return { title: `Python module '${mod}' is not installed.`, command: windows ? `pip install ${pkg}` : `python3 -m pip install ${pkg}` };
  }
  if (/externally-managed-environment/.test(output)) {
    return { title: 'This Python belongs to the system package manager.', detail: 'Use a virtual environment for project packages:', command: 'python3 -m venv .venv && . .venv/bin/activate' };
  }
  m = /Cannot find module '((?:@[\w.-]+\/)?[\w.-]+)[^']*'/.exec(output);
  if (m && !m[1].startsWith('.')) return { title: `Node module '${m[1]}' is not installed.`, command: `npm install ${m[1]}` };

  // Busy port.
  m = /(?:EADDRINUSE|address already in use)\D{0,40}?(\d{2,5})\b|port (\d{2,5}) is already (?:in use|allocated)/i.exec(output);
  if (m) {
    const port = m[1] ?? m[2];
    return {
      title: `Port ${port} is already in use.`,
      detail: 'See which process holds it:',
      command: windows
        ? ctx.shell === 'cmd'
          ? `netstat -ano | findstr :${port}`
          : `Get-NetTCPConnection -LocalPort ${port} | Select-Object OwningProcess, State`
        : `sudo ss -ltnp 'sport = :${port}'`,
    };
  }

  if (/^(sudo\s+)?apt(-get)?\s+install\b/.test(cmd) && /unable to locate package/i.test(output)) {
    return { title: "apt doesn't know that package (yet).", detail: 'Refresh the package lists and try again:', command: 'sudo apt update' };
  }
  if (/could not resolve host|temporary failure in name resolution|name or service not known|no such host is known/i.test(output)) {
    return { title: "The host name couldn't be resolved.", detail: 'Check the address, and your network or DNS settings.' };
  }
  return null;
}

/** Replaces the first whole-word occurrence of `word` in a command line. */
export function replaceWord(line: string, word: string, replacement: string): string {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return line.replace(new RegExp(`(^|[\\s;|&(])${escaped}(?=$|[\\s;|&)])`), `$1${replacement}`);
}
