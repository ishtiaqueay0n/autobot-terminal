import { readFileSync } from 'node:fs';
import { hostPath, type EnvRef } from '../kb/exec';

export type PackageManager = 'apt' | 'dnf' | 'zypper' | 'pacman' | 'winget';

/** Commands whose package has a different name. Anything else installs under its own name. */
const APT: Record<string, string> = {
  ifconfig: 'net-tools', netstat: 'net-tools', route: 'net-tools', arp: 'net-tools',
  dig: 'dnsutils', nslookup: 'dnsutils', host: 'bind9-host',
  python: 'python-is-python3', pip: 'python3-pip', pip3: 'python3-pip', node: 'nodejs',
  rg: 'ripgrep', fd: 'fd-find', ag: 'silversearcher-ag', bat: 'bat',
  ssh: 'openssh-client', sshd: 'openssh-server', scp: 'openssh-client',
  gcc: 'build-essential', 'g++': 'build-essential', make: 'build-essential', cc: 'build-essential',
  docker: 'docker.io', '7z': 'p7zip-full', convert: 'imagemagick', ab: 'apache2-utils', htpasswd: 'apache2-utils',
  mysql: 'mysql-client', psql: 'postgresql-client', 'redis-cli': 'redis-tools', nc: 'netcat-openbsd',
  ip: 'iproute2', ss: 'iproute2', ping: 'iputils-ping', killall: 'psmisc', pstree: 'psmisc', fuser: 'psmisc',
  nmcli: 'network-manager', 'add-apt-repository': 'software-properties-common', mkfs: 'util-linux',
};
const DNF: Record<string, string> = {
  ifconfig: 'net-tools', netstat: 'net-tools', route: 'net-tools', arp: 'net-tools',
  dig: 'bind-utils', nslookup: 'bind-utils', host: 'bind-utils',
  python: 'python3', pip: 'python3-pip', pip3: 'python3-pip', node: 'nodejs',
  rg: 'ripgrep', ssh: 'openssh-clients', scp: 'openssh-clients', sshd: 'openssh-server',
  gcc: 'gcc', 'g++': 'gcc-c++', cc: 'gcc', make: 'make', docker: 'podman-docker', '7z': 'p7zip',
  convert: 'ImageMagick', ab: 'httpd-tools', htpasswd: 'httpd-tools', mysql: 'mysql', psql: 'postgresql',
  nc: 'nmap-ncat', ip: 'iproute', ss: 'iproute', ping: 'iputils', killall: 'psmisc', pstree: 'psmisc',
  fuser: 'psmisc', vim: 'vim-enhanced', nmcli: 'NetworkManager', 'firewall-cmd': 'firewalld', semanage: 'policycoreutils-python-utils',
};
/** winget package ids. Unknown commands get a "winget search" instead. */
const WINGET: Record<string, string> = {
  git: 'Git.Git', node: 'OpenJS.NodeJS.LTS', npm: 'OpenJS.NodeJS.LTS', npx: 'OpenJS.NodeJS.LTS',
  python: 'Python.Python.3.12', python3: 'Python.Python.3.12', pip: 'Python.Python.3.12', pwsh: 'Microsoft.PowerShell',
  code: 'Microsoft.VisualStudioCode', gh: 'GitHub.cli', jq: 'jqlang.jq', kubectl: 'Kubernetes.kubectl', helm: 'Helm.Helm',
  terraform: 'Hashicorp.Terraform', az: 'Microsoft.AzureCLI', aws: 'Amazon.AWSCLI', docker: 'Docker.DockerDesktop',
  go: 'GoLang.Go', rg: 'BurntSushi.ripgrep.MSVC', '7z': '7zip.7zip', vim: 'vim.vim', nvim: 'Neovim.Neovim',
  java: 'Microsoft.OpenJDK.21', dotnet: 'Microsoft.DotNet.SDK.8', cargo: 'Rustlang.Rustup', rustc: 'Rustlang.Rustup',
  rustup: 'Rustlang.Rustup', ffmpeg: 'Gyan.FFmpeg', wget: 'JernejSimoncic.Wget', make: 'GnuWin32.Make',
};

/** True when the package tables know where this command comes from. */
export function hasPackageMapping(command: string, pm: PackageManager): boolean {
  const table = pm === 'apt' ? APT : pm === 'dnf' ? DNF : pm === 'winget' ? WINGET : null;
  return Boolean(table && Object.prototype.hasOwnProperty.call(table, command));
}

/** The command that installs whatever provides `command`. */
export function installCommand(command: string, pm: PackageManager): string {
  switch (pm) {
    case 'apt':
      return `sudo apt install ${APT[command] ?? command}`;
    case 'dnf':
      return `sudo dnf install ${DNF[command] ?? command}`;
    case 'zypper':
      return `sudo zypper install ${command}`;
    case 'pacman':
      return `sudo pacman -S ${command}`;
    case 'winget':
      return WINGET[command] ? `winget install --id ${WINGET[command]} -e` : `winget search ${command}`;
  }
}

const cache = new Map<string, PackageManager | null>();

/** The system package manager in an environment, from /etc/os-release on Linux. */
export function packageManager(env: EnvRef): PackageManager | null {
  if (env.kind === 'windows') return 'winget';
  if (cache.has(env.id)) return cache.get(env.id)!;
  if (env.kind === 'ssh') return null; // only what the remote hook reported (rememberOsRelease)
  let pm: PackageManager | null = null;
  try {
    pm = packageManagerFromOsRelease(readFileSync(hostPath(env, '/etc/os-release'), 'utf8'));
  } catch {
    pm = null;
  }
  cache.set(env.id, pm);
  return pm;
}

export function packageManagerFromOsRelease(text: string): PackageManager | null {
  const field = (k: string) => new RegExp(`^${k}="?([^"\\n]*)"?`, 'm').exec(text)?.[1].toLowerCase() ?? '';
  const ids = `${field('ID')} ${field('ID_LIKE')}`;
  if (/\b(debian|ubuntu)\b/.test(ids)) return 'apt';
  if (/\b(rhel|fedora|centos|rocky|almalinux|ol|amzn)\b/.test(ids)) return 'dnf';
  if (/\b(suse|opensuse)\b/.test(ids)) return 'zypper';
  if (/\barch\b/.test(ids)) return 'pacman';
  return null;
}

const names = new Map<string, string>();

/** The os-release text a remote shell reported: this is all that is known about a machine reached over ssh. */
export function rememberOsRelease(env: EnvRef, text: string): void {
  cache.set(env.id, packageManagerFromOsRelease(text));
  names.set(env.id, /^PRETTY_NAME="?([^"\n]*)"?/m.exec(text)?.[1] || 'Linux');
}

/** A readable name of the operating system in an environment ("Ubuntu 24.04.1 LTS (WSL)", "Windows"). */
export function osName(env: EnvRef): string {
  if (env.kind === 'windows') return 'Windows';
  let name = names.get(env.id);
  if (name === undefined && env.kind === 'ssh') name = 'Linux';
  if (name === undefined) {
    try {
      const text = readFileSync(hostPath(env, '/etc/os-release'), 'utf8');
      name = /^PRETTY_NAME="?([^"\n]*)"?/m.exec(text)?.[1] || 'Linux';
    } catch {
      name = 'Linux';
    }
    if (env.kind === 'wsl') name += ' (WSL)';
    names.set(env.id, name);
  }
  return name;
}
