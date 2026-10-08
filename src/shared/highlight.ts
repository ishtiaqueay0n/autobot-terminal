import { commandSegments, contextAt, toolName, type Word } from './tokenize';
import type { ShellKind } from './types';

/**
 * What a piece of a command line is, for colouring it. Command names have a type (what kind of program it is);
 * the rest of the line is coloured by what each word looks like.
 */
export type TokenRole =
  // The command word, by what kind of program it is.
  | 'cmd-read' // looks at things: ls, cat, grep, Get-ChildItem
  | 'cmd-change' // changes things: cp, mv, mkdir, chmod, Set-Content
  | 'cmd-danger' // destroys things: rm, dd, mkfs, shutdown, Remove-Item
  | 'cmd-priv' // sudo, su, runas
  | 'cmd-vcs' // git, svn
  | 'cmd-pkg' // package managers and build tools: apt, npm, pip, cargo, make
  | 'cmd-cloud' // containers and clouds: docker, kubectl, terraform, aws
  | 'cmd-net' // network: curl, ssh, ping, rsync
  | 'cmd-sys' // services and system: systemctl, journalctl, mount
  | 'cmd-shell' // shell built-ins and shells: cd, echo, export, bash
  | 'cmd-other'
  // The rest of the line.
  | 'keyword' // if, then, for, do ... and variable assignments' names
  | 'subcommand' // the word after git / docker / systemctl / npm ...
  | 'option' // -l, --force, /s
  | 'path'
  | 'url'
  | 'string' // quoted text
  | 'variable' // $HOME, %PATH%, ${x}
  | 'number'
  | 'operator' // | && ; > <
  | 'comment';

export interface Token {
  start: number;
  end: number;
  role: TokenRole;
}

const names = (s: string): string[] => s.split(/\s+/).filter(Boolean);

const CATEGORIES: Record<string, TokenRole> = {};
function add(role: TokenRole, list: string): void {
  for (const n of names(list)) CATEGORIES[n] = role;
}
add(
  'cmd-read',
  `ls dir ll la cat bat less more most head tail grep egrep fgrep rg ag ack find fd locate which where whereis whoami id
   uname hostname uptime date cal df du free ps pgrep top htop btop pwd stat file wc sort uniq cut tr awk diff cmp
   tree man info help type history env printenv lsblk lsof lscpu lsusb lspci readlink realpath basename dirname
   jq yq xxd hexdump strings column nl tac rev od md5sum sha1sum sha256sum cksum sha512sum tldr fzf watch
   gci gc gi gl gm gp gps gsv select where measure compare findstr more tasklist systeminfo ver vol tree`,
);
add(
  'cmd-change',
  `cp mv mkdir touch ln chmod chown chgrp tee tar zip unzip gzip gunzip xz unxz bzip2 7z 7za install patch truncate
   rename mv md copy move ren xcopy robocopy attrib sed vi vim nvim nano emacs code edit notepad ed ex cpio
   mktemp mkfifo setfacl chattr sync ni sc ac copy-item move-item new-item set-content add-content out-file`,
);
add('cmd-danger', 'rm rmdir del erase rd dd mkfs shred fdisk parted wipefs format diskpart shutdown reboot halt poweroff unlink srm');
add('cmd-priv', 'sudo su doas pkexec runas sudoedit');
add('cmd-vcs', 'git svn hg gh glab tig fossil bzr');
add(
  'cmd-pkg',
  `apt apt-get apt-cache aptitude dpkg dnf yum rpm zypper pacman yay snap flatpak brew winget choco scoop npm npx yarn
   pnpm bun deno node pip pip3 pipx pipenv poetry conda python python3 py cargo rustup rustc go gem bundle ruby composer
   php mvn gradle java javac dotnet nuget make cmake ninja gcc g++ clang tsc`,
);
add(
  'cmd-cloud',
  `docker docker-compose podman kubectl helm kind minikube k9s terraform tofu ansible ansible-playbook vagrant aws az
   gcloud gsutil oc skaffold istioctl flux argocd packer vault consul nomad`,
);
add(
  'cmd-net',
  `curl wget ssh scp sftp ssh-keygen ssh-add rsync ping ping6 traceroute tracert tracepath nslookup dig host nc ncat
   nmap telnet ftp ip ifconfig ipconfig netstat ss iptables nft firewall-cmd ufw nmcli route arp mtr whois tcpdump
   openssl certbot invoke-webrequest invoke-restmethod iwr irm`,
);
add(
  'cmd-sys',
  `systemctl service journalctl dmesg mount umount crontab at systemd-analyze loginctl timedatectl hostnamectl modprobe
   lsmod sysctl ulimit nice renice sc net reg wmic kill killall pkill taskkill chkconfig update-alternatives
   useradd userdel usermod passwd groupadd visudo setenforce getenforce semanage restorecon auditctl logrotate
   get-service start-service stop-service restart-service get-process stop-process`,
);
add(
  'cmd-shell',
  `cd pushd popd chdir echo printf export set setx unset alias unalias source . eval exec exit logout clear cls read
   declare local typeset return true false test [ [[ : umask wait jobs fg bg disown builtin command trap shift getopts
   bash zsh sh dash fish pwsh powershell cmd tmux screen write-host write-output set-location sl push-location
   pop-location rem title color pause call start`,
);

/** Tools whose first plain argument is a subcommand worth colouring. */
const SUBCOMMAND_TOOLS = new Set(
  names(`git docker docker-compose podman kubectl helm npm yarn pnpm cargo go pip pip3 apt apt-get dnf yum zypper pacman
   snap flatpak systemctl journalctl brew winget choco az aws gcloud terraform dotnet gh nmcli firewall-cmd ip rustup
   conda poetry svn hg tmux openssl ssh-add`),
);

const PS_READ = /^(get|select|where|measure|compare|format|out|write|test|find|search|show|read|resolve|sort|group|convertto|convertfrom|split|join|tee|foreach|debug|trace|wait|watch)-/i;
const PS_CHANGE = /^(set|new|add|copy|move|rename|import|export|enable|start|install|update|invoke|register|save|expand|compress|publish|grant|mount|push|pop|enter|exit|send|receive|connect|disconnect|checkpoint|restore|backup|build|sync|unblock|block|protect)-/i;
const PS_DANGER = /^(remove|stop|disable|clear|uninstall|restart|unregister|reset|revoke|suspend|deny|disconnect|dismount|initialize|format-volume)-/i;

/** What kind of program a command word is. */
export function commandCategory(word: string, shell: ShellKind): TokenRole {
  const tool = toolName(word, shell).toLowerCase();
  const known = CATEGORIES[tool];
  if (known) return known;
  if (shell === 'powershell' || tool.includes('-')) {
    if (PS_DANGER.test(tool)) return 'cmd-danger';
    if (PS_READ.test(tool)) return 'cmd-read';
    if (PS_CHANGE.test(tool)) return 'cmd-change';
  }
  return 'cmd-other';
}

const KEYWORDS = new Set(
  names(`if then else elif fi for while until do done case esac in function foreach switch try catch finally param
   return break continue goto not exist defined errorlevel equ neq lss leq gtr geq`),
);

const URL = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;
const NUMBER = /^[+-]?\d+(\.\d+)?([kmgtKMGT]i?[bB]?|%)?$/;
const VARIABLE = /^(\$\{?[A-Za-z_?@*#$!0-9]|\$\(|%[A-Za-z_][^%]*%|\$env:)/;

/** What a plain (non-option, non-command) word looks like. */
function wordRole(value: string, quote: Word['quote'], shell: ShellKind): TokenRole | null {
  if (quote) return 'string';
  if (URL.test(value)) return 'url';
  if (VARIABLE.test(value)) return 'variable';
  if (NUMBER.test(value)) return 'number';
  const windows = shell === 'powershell' || shell === 'cmd';
  if (/^(~|\.{1,2})([\\/]|$)/.test(value) || value.includes('/') || (windows && (/^[A-Za-z]:[\\/]/.test(value) || value.includes('\\')))) {
    return 'path';
  }
  return null;
}

/**
 * Colours for a command line: the command by its type, options, subcommands, paths, strings, variables, numbers,
 * operators and comments by what they look like. Needs no knowledge about the tools, so it can run on every
 * keystroke; unknown or mistyped words are the checker's business (underlines), not this one's.
 */
function highlightLine(text: string, shell: ShellKind): Token[] {
  const tokens: Token[] = [];
  const comment = commentStart(text, shell);
  const code = comment === -1 ? text : text.slice(0, comment);
  if (comment !== -1) tokens.push({ start: comment, end: text.length, role: 'comment' });

  const segments = commandSegments(code, shell);
  let covered = 0;
  for (const seg of segments) {
    // Operators and brackets between commands.
    operatorRuns(code, covered, seg.start, tokens);
    covered = seg.end;
    const part = code.slice(seg.start, seg.end);
    const ctx = contextAt(part, part.length, shell);
    const words = ctx.words.filter((w) => w.end > w.start);
    const commandIndex = ctx.commandIndex < ctx.words.length ? ctx.words.indexOf(ctx.words[ctx.commandIndex]) : -1;
    const commandWord = ctx.words[ctx.commandIndex];
    let afterOption = false;
    let sawSub = false;
    let prevEnd = 0;
    for (const w of words) {
      operatorRuns(part, prevEnd, w.start, tokens, seg.start);
      prevEnd = w.end;
      const abs = (n: number) => seg.start + n;
      const isCommand = commandWord !== undefined && w === commandWord && w.end > w.start;
      const before = commandWord !== undefined && words.indexOf(w) < words.indexOf(commandWord);
      if (w.redirect) {
        tokens.push({ start: abs(w.start), end: abs(w.end), role: 'path' });
        continue;
      }
      if (isCommand) {
        // fi, done and esac are where a command would be, but are part of the shell's syntax.
        const role = KEYWORDS.has(w.value.toLowerCase()) && !w.quote ? 'keyword' : commandCategory(w.value, shell);
        tokens.push({ start: abs(w.start), end: abs(w.end), role });
        continue;
      }
      if (before || (commandWord === undefined && commandIndex === -1)) {
        // sudo / env / time before the command, keywords, and VAR=value assignments.
        const assign = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(w.value);
        if (assign && !w.quote) {
          tokens.push({ start: abs(w.start), end: abs(w.start + assign[1].length), role: 'keyword' });
          const rest = w.value.slice(assign[0].length);
          const role = rest ? wordRole(rest, '', shell) : null;
          if (role) tokens.push({ start: abs(w.start + assign[0].length), end: abs(w.end), role });
        } else if (CATEGORIES[w.value.toLowerCase()] === 'cmd-priv') {
          tokens.push({ start: abs(w.start), end: abs(w.end), role: 'cmd-priv' });
        } else if (KEYWORDS.has(w.value.toLowerCase())) {
          tokens.push({ start: abs(w.start), end: abs(w.end), role: 'keyword' });
        } else if (w.value.startsWith('-')) {
          tokens.push({ start: abs(w.start), end: abs(w.end), role: 'option' });
        } else {
          const role = wordRole(w.value, w.quote, shell) ?? 'cmd-shell';
          tokens.push({ start: abs(w.start), end: abs(w.end), role });
        }
        continue;
      }

      const raw = part.slice(w.start, w.end);
      const optionStart = w.quote === '' && (w.value.startsWith('-') || (shell === 'cmd' && /^\/[A-Za-z?]/.test(w.value)));
      if (optionStart && w.value !== '-' && w.value !== '--') {
        // --name=value: the name is the option, the value is coloured by what it looks like.
        const eq = raw.indexOf('=');
        const colon = shell === 'cmd' ? raw.indexOf(':') : -1;
        const cut = eq > 0 ? eq : colon > 0 ? colon : -1;
        tokens.push({ start: abs(w.start), end: abs(cut === -1 ? w.end : w.start + cut + 1), role: 'option' });
        if (cut !== -1 && cut + 1 < raw.length) {
          const value = raw.slice(cut + 1);
          const q = value[0] === '"' || value[0] === "'" ? (value[0] as '"' | "'") : '';
          const role = wordRole(q ? value.slice(1, -1) : value, q, shell);
          if (role) tokens.push({ start: abs(w.start + cut + 1), end: abs(w.end), role });
        }
        afterOption = !raw.includes('=') && !(colon > 0);
        continue;
      }
      const tool = commandWord ? toolName(commandWord.value, shell).toLowerCase() : '';
      if (!sawSub && !afterOption && !w.quote && SUBCOMMAND_TOOLS.has(tool) && /^[A-Za-z][\w:.-]*$/.test(w.value) && !wordRole(w.value, '', shell)) {
        sawSub = true;
        tokens.push({ start: abs(w.start), end: abs(w.end), role: 'subcommand' });
        afterOption = false;
        continue;
      }
      afterOption = false;
      const role = wordRole(w.value, w.quote, shell);
      if (role) tokens.push({ start: abs(w.start), end: abs(w.end), role });
    }
    operatorRuns(part, prevEnd, part.length, tokens, seg.start);
  }
  operatorRuns(code, covered, code.length, tokens);
  return tokens.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Non-space characters between two offsets are operators and brackets: |, &&, ;, >, <, (, ), {, }. */
function operatorRuns(text: string, from: number, to: number, out: Token[], base = 0): void {
  const re = /\S+/g;
  const slice = text.slice(from, to);
  for (let m = re.exec(slice); m; m = re.exec(slice)) {
    out.push({ start: base + from + m.index, end: base + from + m.index + m[0].length, role: 'operator' });
  }
}

/** Where a comment starts (a # after whitespace or at the start, outside quotes), or -1. */
function commentStart(text: string, shell: ShellKind): number {
  if (shell === 'cmd') return -1;
  const escape = shell === 'powershell' ? '`' : '\\';
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === escape && quote === '"') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === escape) {
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return i;
    }
  }
  return -1;
}

/** Colours for a command line; each line of a multi-line text is coloured as its own command line. */
export function highlightCommand(text: string, shell: ShellKind): Token[] {
  if (!text.includes('\n')) return highlightLine(text, shell);
  const tokens: Token[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    for (const t of highlightLine(line, shell)) tokens.push({ ...t, start: t.start + offset, end: t.end + offset });
    offset += line.length + 1;
  }
  return tokens;
}
