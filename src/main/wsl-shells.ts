import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Which WSL distros have zsh. Looking for it means starting every distro (listing them does not), so a bash tab
 * reports it when it starts and the answer is remembered here; zsh tabs for those distros then show up in the
 * profile list from the next start on.
 */
export class WslShells {
  private readonly zsh = new Set<string>();

  constructor(private readonly file: string) {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as { zsh?: unknown };
      if (Array.isArray(data.zsh)) for (const d of data.zsh) if (typeof d === 'string') this.zsh.add(d);
    } catch {
      // No cache yet, or unreadable: start empty.
    }
  }

  zshDistros(): ReadonlySet<string> {
    return this.zsh;
  }

  /** Remembers that a distro has zsh. Returns true when that was new. */
  noteZsh(distro: string): boolean {
    if (this.zsh.has(distro)) return false;
    this.zsh.add(distro);
    try {
      writeFileSync(this.file, `${JSON.stringify({ zsh: [...this.zsh] })}\n`, 'utf8');
    } catch (err) {
      console.error('[wsl] could not save the list of distros with zsh:', err);
    }
    return true;
  }
}
