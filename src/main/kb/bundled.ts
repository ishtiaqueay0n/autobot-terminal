import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { KbIndex, KbSpec, KbTldrPage } from '../../shared/kb-types';

type TldrData = Record<string, Partial<Record<'common' | 'linux' | 'windows', KbTldrPage>>>;

const SPEC_CACHE_SIZE = 150;

/**
 * Read-only access to the knowledge base shipped with the app (resources/kb, built by scripts/build-kb.mjs).
 * Spec files are gunzipped on first use and kept in a small LRU cache.
 */
export class BundledKb {
  private readonly index: KbIndex | null;
  private readonly specs = new Map<string, KbSpec | null>();
  private tldr: TldrData | null | undefined;

  constructor(private readonly dir: string) {
    const file = join(dir, 'index.json');
    this.index = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as KbIndex) : null;
    if (!this.index) console.warn(`[kb] no bundled knowledge base at ${dir}; run "npm run kb"`);
  }

  get available(): boolean {
    return this.index !== null;
  }

  has(tool: string): boolean {
    return Boolean(this.index?.fig[tool]);
  }

  toolNames(): string[] {
    return this.index ? Object.keys(this.index.fig) : [];
  }

  description(tool: string): string | undefined {
    return this.index?.fig[tool]?.description;
  }

  /** Top-level spec for a tool, or null. */
  spec(tool: string): KbSpec | null {
    const entry = this.index?.fig[tool];
    return entry ? this.load(entry.file) : null;
  }

  /** A split-out subcommand spec referenced by `loadSpec` (e.g. "aws/s3"). */
  loadSpec(key: string): KbSpec | null {
    return this.load(`fig/${key}.json.gz`);
  }

  /** tldr examples: the platform page if there is one, else the common page. */
  page(tool: string, platform: 'linux' | 'windows'): KbTldrPage | null {
    const pages = this.tldrData()?.[tool];
    return pages?.[platform] ?? pages?.common ?? null;
  }

  private load(file: string): KbSpec | null {
    if (this.specs.has(file)) {
      const hit = this.specs.get(file)!;
      // Refresh LRU position.
      this.specs.delete(file);
      this.specs.set(file, hit);
      return hit;
    }
    let spec: KbSpec | null = null;
    try {
      spec = JSON.parse(gunzipSync(readFileSync(join(this.dir, ...file.split('/')))).toString('utf8')) as KbSpec;
    } catch {
      spec = null;
    }
    this.specs.set(file, spec);
    if (this.specs.size > SPEC_CACHE_SIZE) this.specs.delete(this.specs.keys().next().value!);
    return spec;
  }

  private tldrData(): TldrData | null {
    if (this.tldr !== undefined) return this.tldr;
    try {
      this.tldr = JSON.parse(gunzipSync(readFileSync(join(this.dir, 'tldr.json.gz'))).toString('utf8')) as TldrData;
    } catch {
      this.tldr = null;
    }
    return this.tldr;
  }
}
