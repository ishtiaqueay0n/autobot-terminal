import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Finds the current git branch for a directory by reading .git/HEAD directly (no git process, so it is
 * cheap enough to run on every prompt). Returns a short commit hash when HEAD is detached, null outside
 * a repository.
 */
export function findGitBranch(dir: string): string | null {
  let current = resolve(dir);
  for (;;) {
    const head = readHead(join(current, '.git'));
    if (head !== undefined) return head;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** undefined: no .git here; null: .git found but unreadable. */
function readHead(gitPath: string): string | null | undefined {
  let gitDir = gitPath;
  try {
    const st = statSync(gitPath);
    if (st.isFile()) {
      // Worktrees and submodules: ".git" is a file pointing at the real git dir.
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitPath, 'utf8'));
      if (!m) return null;
      gitDir = resolve(dirname(gitPath), m[1].trim());
    } else if (!st.isDirectory()) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  try {
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (ref) return ref[1];
    if (/^[0-9a-f]{7,}$/i.test(head)) return head.slice(0, 7);
    return null;
  } catch {
    return null;
  }
}
