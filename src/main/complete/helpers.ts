import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { HelperId, KbSuggestion } from '../../shared/kb-types';
import { runIn, type EnvRef } from '../kb/exec';

export interface HelperContext {
  env: EnvRef;
  /** Current folder as this process can read it. */
  cwdHost: string | null;
  /** Current folder as the shell sees it (commands run there). */
  cwd: string | null;
  /** Home folder as this process can read it. */
  homeHost: string | null;
}

interface HelperDef {
  /** Talks to a remote service (a cluster, a cloud): only runs when the user opted in for this tool. */
  network?: string;
  ttlMs: number;
  run(ctx: HelperContext): Promise<KbSuggestion[]> | KbSuggestion[];
}

const TIMEOUT_MS = 500;

/** Live values for arguments: git branches, docker containers, npm scripts... All read-only. */
export class Helpers {
  private readonly cache = new Map<string, { at: number; value: KbSuggestion[] }>();

  constructor(private readonly networkAllowed: (tool: string) => boolean) {}

  async run(id: HelperId, ctx: HelperContext): Promise<KbSuggestion[]> {
    const def = HELPERS[id];
    if (!def) return [];
    if (def.network && !this.networkAllowed(def.network)) return [];
    const key = `${id}\0${ctx.env.id}\0${ctx.cwd ?? ''}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < def.ttlMs) return hit.value;
    let value: KbSuggestion[] = [];
    try {
      value = await Promise.race([
        Promise.resolve(def.run(ctx)),
        new Promise<KbSuggestion[]>((r) => setTimeout(() => r([]), TIMEOUT_MS + 100)),
      ]);
    } catch {
      value = [];
    }
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }
}

// ------------------------------------------------------------------------------------------- git (files only)

/** The .git directory for a folder (following worktree/submodule ".git" files), or null. */
export function findGitDir(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, '.git');
    try {
      const st = statSync(candidate);
      if (st.isDirectory()) return candidate;
      if (st.isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(candidate, 'utf8'));
        if (m) return resolve(dir, m[1].trim());
      }
    } catch {
      // keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Ref names under refs/<kind>/ from loose files and packed-refs, newest-looking first is not knowable: sorted. */
export function gitRefs(gitDir: string, kind: 'heads' | 'tags' | 'remotes'): string[] {
  // Worktrees keep refs in the common dir.
  let common = gitDir;
  try {
    const c = readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
    if (c) common = resolve(gitDir, c);
  } catch {
    // not a worktree
  }
  const names = new Set<string>();
  const walk = (dir: string, prefix: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(join(dir, e.name), `${prefix}${e.name}/`);
      else names.add(`${prefix}${e.name}`);
    }
  };
  walk(join(common, 'refs', kind), '');
  try {
    for (const line of readFileSync(join(common, 'packed-refs'), 'utf8').split('\n')) {
      const m = new RegExp(`^[0-9a-f]{40}\\s+refs/${kind}/(.+)$`).exec(line.trim());
      if (m) names.add(m[1]);
    }
  } catch {
    // no packed refs
  }
  if (kind === 'remotes') for (const n of [...names]) if (n.endsWith('/HEAD')) names.delete(n);
  return [...names].sort();
}

function gitRemotes(gitDir: string): string[] {
  try {
    const config = readFileSync(join(gitDir, 'config'), 'utf8');
    return [...config.matchAll(/^\s*\[remote\s+"([^"]+)"\]/gm)].map((m) => m[1]);
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------------------------------- project files

function findUp(start: string, file: string): string | null {
  let dir = resolve(start);
  for (;;) {
    const p = join(dir, file);
    if (existsSync(p)) return p;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function npmScripts(cwd: string): KbSuggestion[] {
  const file = findUp(cwd, 'package.json');
  if (!file) return [];
  try {
    const scripts = (JSON.parse(readFileSync(file, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
    return Object.entries(scripts).map(([name, cmd]) => ({ name, description: String(cmd).slice(0, 120) }));
  } catch {
    return [];
  }
}

export function makeTargets(cwd: string): KbSuggestion[] {
  for (const name of ['GNUmakefile', 'makefile', 'Makefile']) {
    const file = join(cwd, name);
    if (!existsSync(file)) continue;
    const targets = new Set<string>();
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Za-z0-9][\w./-]*)\s*:(?!=)/.exec(line);
      if (m && !m[1].startsWith('.')) targets.add(m[1]);
    }
    return [...targets].map((name) => ({ name }));
  }
  return [];
}

export function sshHosts(homeHost: string): KbSuggestion[] {
  try {
    const config = readFileSync(join(homeHost, '.ssh', 'config'), 'utf8');
    const hosts = new Set<string>();
    for (const m of config.matchAll(/^\s*Host\s+(.+)$/gim)) {
      for (const h of m[1].split(/\s+/)) if (h && !/[*?!]/.test(h)) hosts.add(h);
    }
    return [...hosts].map((name) => ({ name }));
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------------------------------- commands

async function lines(ctx: HelperContext, file: string, args: string[]): Promise<string[]> {
  const res = await runIn(ctx.env, file, args, { timeoutMs: TIMEOUT_MS, cwd: ctx.env.kind === 'wsl' ? ctx.cwd : ctx.cwdHost, maxBytes: 200_000 });
  if (res.code !== 0) return [];
  return res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

const HELPERS: Record<HelperId, HelperDef> = {
  'git.branches': {
    ttlMs: 3000,
    run: (ctx) => {
      const g = ctx.cwdHost ? findGitDir(ctx.cwdHost) : null;
      if (!g) return [];
      return [
        ...gitRefs(g, 'heads').map((name) => ({ name, description: 'branch' })),
        ...gitRefs(g, 'remotes').map((name) => ({ name, description: 'remote branch' })),
      ];
    },
  },
  'git.tags': {
    ttlMs: 5000,
    run: (ctx) => {
      const g = ctx.cwdHost ? findGitDir(ctx.cwdHost) : null;
      return g ? gitRefs(g, 'tags').map((name) => ({ name, description: 'tag' })) : [];
    },
  },
  'git.remotes': {
    ttlMs: 5000,
    run: (ctx) => {
      const g = ctx.cwdHost ? findGitDir(ctx.cwdHost) : null;
      return g ? gitRemotes(g).map((name) => ({ name, description: 'remote' })) : [];
    },
  },
  'npm.scripts': { ttlMs: 3000, run: (ctx) => (ctx.cwdHost ? npmScripts(ctx.cwdHost) : []) },
  'make.targets': { ttlMs: 3000, run: (ctx) => (ctx.cwdHost ? makeTargets(ctx.cwdHost) : []) },
  'ssh.hosts': { ttlMs: 10000, run: (ctx) => (ctx.homeHost ? sshHosts(ctx.homeHost) : []) },
  'docker.containers': {
    ttlMs: 3000,
    run: async (ctx) =>
      (await lines(ctx, 'docker', ['ps', '-a', '--format', '{{.Names}}\t{{.Status}}'])).map((l) => {
        const [name, status] = l.split('\t');
        return { name, description: status };
      }),
  },
  'docker.images': {
    ttlMs: 5000,
    run: async (ctx) =>
      (await lines(ctx, 'docker', ['images', '--format', '{{.Repository}}:{{.Tag}}']))
        .filter((l) => !l.includes('<none>'))
        .map((name) => ({ name, description: 'image' })),
  },
  'docker.networks': {
    ttlMs: 5000,
    run: async (ctx) => (await lines(ctx, 'docker', ['network', 'ls', '--format', '{{.Name}}'])).map((name) => ({ name })),
  },
  'docker.volumes': {
    ttlMs: 5000,
    run: async (ctx) => (await lines(ctx, 'docker', ['volume', 'ls', '--format', '{{.Name}}'])).map((name) => ({ name })),
  },
  'systemd.units': {
    ttlMs: 10000,
    run: async (ctx) =>
      ctx.env.kind === 'windows'
        ? []
        : (await lines(ctx, 'systemctl', ['list-units', '--all', '--no-legend', '--plain', '--no-pager'])).map((l) => {
            const [name, , , , ...desc] = l.split(/\s+/);
            return { name, description: desc.join(' ') };
          }),
  },
  // Contexts come from the local kubeconfig; namespaces and pods need the cluster (opt-in).
  'kubectl.contexts': {
    ttlMs: 10000,
    run: async (ctx) => (await lines(ctx, 'kubectl', ['config', 'get-contexts', '-o', 'name'])).map((name) => ({ name, description: 'context' })),
  },
  'kubectl.namespaces': {
    network: 'kubectl',
    ttlMs: 10000,
    run: async (ctx) =>
      (await lines(ctx, 'kubectl', ['get', 'namespaces', '-o', 'name'])).map((l) => ({ name: l.replace(/^namespace\//, ''), description: 'namespace' })),
  },
  'kubectl.pods': {
    network: 'kubectl',
    ttlMs: 5000,
    run: async (ctx) => (await lines(ctx, 'kubectl', ['get', 'pods', '-o', 'name'])).map((l) => ({ name: l.replace(/^pod\//, ''), description: 'pod' })),
  },
};
