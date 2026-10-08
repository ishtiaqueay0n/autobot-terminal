// Builds the bundled knowledge base in resources/kb from:
//   - withfig/autocomplete specs (node_modules/@withfig/autocomplete, ISC/MIT): structure only. Functions in the
//     specs are never kept; dynamic generators are mapped to Autobot's own read-only helpers or dropped.
//   - tldr-pages (CC BY 4.0): usage examples for common, linux and windows pages (downloaded once, cached).
//
// Usage: node scripts/build-kb.mjs [--if-missing] [--refresh-tldr]
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync, strFromU8, unzipSync } from 'fflate';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'resources', 'kb');
const cache = join(root, '.cache', 'kb');
const figBuild = join(root, 'node_modules', '@withfig', 'autocomplete', 'build');
const TLDR_URL = 'https://github.com/tldr-pages/tldr/releases/latest/download/tldr-pages.en.zip';
const KB_VERSION = 1;
const MAX_DESCRIPTION = 180;

const args = new Set(process.argv.slice(2));
if (args.has('--if-missing') && existsSync(join(out, 'index.json'))) {
  console.log('kb: already built (resources/kb/index.json exists)');
  process.exit(0);
}

// ------------------------------------------------------------------------------------------- helpers

const HELPER_RULES = [
  [/git[\s\S]*?\bbranch\b/, 'git.branches'],
  [/git[\s\S]*?\btag\b/, 'git.tags'],
  [/git[\s\S]*?\bremote\b/, 'git.remotes'],
  [/docker[\s\S]*?\b(ps|container"?,\s*"?ls)\b/, 'docker.containers'],
  [/docker[\s\S]*?\b(images|image"?,\s*"?ls)\b/, 'docker.images'],
  [/docker[\s\S]*?\bnetwork\b/, 'docker.networks'],
  [/docker[\s\S]*?\bvolume\b/, 'docker.volumes'],
  [/kubectl[\s\S]*?(namespaces?\b|"ns")/, 'kubectl.namespaces'],
  [/kubectl[\s\S]*?(get-contexts|contexts)/, 'kubectl.contexts'],
  [/kubectl[\s\S]*?\bpods?\b/, 'kubectl.pods'],
  [/package\.json/, 'npm.scripts'],
  [/Makefile|make"?,\s*"?-qp/, 'make.targets'],
  [/\.ssh\/config|known_hosts/, 'ssh.hosts'],
  [/systemctl[\s\S]*?list-unit/, 'systemd.units'],
];

function describe(value) {
  if (typeof value === 'function') return value.toString();
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function helperFor(gen) {
  const text = [gen.script, gen.custom, gen.postProcess].map(describe).join(' ');
  for (const [pattern, id] of HELPER_RULES) if (pattern.test(text)) return id;
  return null;
}

// ------------------------------------------------------------------------------------------- conversion

const stats = { specs: 0, skipped: 0, options: 0, helpers: 0, droppedGenerators: 0 };

function list(v) {
  return v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
}

function names(v) {
  return list(v).filter((n) => typeof n === 'string' && n.length > 0);
}

function shortText(text) {
  if (typeof text !== 'string') return undefined;
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return undefined;
  if (clean.length <= MAX_DESCRIPTION) return clean;
  const sentence = clean.slice(0, MAX_DESCRIPTION).match(/^(.{40,}?[.!?])\s/);
  return sentence ? sentence[1] : `${clean.slice(0, MAX_DESCRIPTION - 1).trimEnd()}…`;
}

function compact(obj) {
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === undefined || v === false || (Array.isArray(v) && v.length === 0)) delete obj[k];
  }
  return obj;
}

function convertArg(a) {
  if (!a || typeof a !== 'object') return null;
  const templates = new Set(list(a.template).filter((t) => t === 'filepaths' || t === 'folders'));
  const helpers = new Set();
  for (const g of list(a.generators)) {
    if (!g || typeof g !== 'object') continue;
    for (const t of list(g.template)) if (t === 'filepaths' || t === 'folders') templates.add(t);
    if (g.script || g.custom) {
      const id = helperFor(g);
      if (id) {
        helpers.add(id);
        stats.helpers++;
      } else stats.droppedGenerators++;
    }
  }
  const suggestions = [];
  for (const s of list(a.suggestions)) {
    if (typeof s === 'string') suggestions.push({ name: s });
    else if (s && typeof s === 'object' && !s.hidden) {
      for (const n of names(s.name)) suggestions.push(compact({ name: n, description: shortText(s.description) }));
    }
  }
  return compact({
    name: typeof a.name === 'string' ? a.name : undefined,
    description: shortText(a.description),
    optional: a.isOptional === true,
    variadic: a.isVariadic === true,
    isCommand: a.isCommand === true || a.isScript === true,
    templates: [...templates],
    suggestions: suggestions.slice(0, 200),
    helpers: [...helpers],
    dangerous: a.isDangerous === true,
  });
}

function convertOption(o) {
  const n = names(o?.name);
  if (n.length === 0) return null;
  stats.options++;
  const sepValue = o.requiresSeparator === true ? '=' : typeof o.requiresSeparator === 'string' ? o.requiresSeparator : undefined;
  return compact({
    names: n,
    description: shortText(o.description),
    args: list(o.args).map(convertArg).filter(Boolean),
    persistent: o.isPersistent === true,
    repeatable: o.isRepeatable === true || typeof o.isRepeatable === 'number',
    required: o.isRequired === true,
    separator: sepValue,
    dangerous: o.isDangerous === true,
    hidden: o.hidden === true,
  });
}

function convertSpec(s, depth = 0) {
  const n = names(s?.name);
  if (n.length === 0 || depth > 40) return null;
  return compact({
    names: n,
    description: shortText(s.description),
    subcommands: list(s.subcommands).map((c) => convertSpec(c, depth + 1)).filter(Boolean),
    options: list(s.options).map(convertOption).filter(Boolean),
    args: list(s.args).map(convertArg).filter(Boolean),
    loadSpec: typeof s.loadSpec === 'string' ? s.loadSpec : undefined,
    dangerous: s.isDangerous === true,
    hidden: s.hidden === true,
  });
}

function* specFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(figBuild, full).split(sep).join('/');
    if (entry.isDirectory()) {
      // Scoped npx tools, examples, Fig's own CLI and the dynamic loader are not useful here.
      if (/^(@|example$|dynamic$|fig$)/.test(rel)) continue;
      yield* specFiles(full);
    } else if (entry.name.endsWith('.js') && entry.name !== 'index.js' && entry.name !== '-.js') {
      yield { full, key: rel.slice(0, -3) };
    }
  }
}

async function buildFig() {
  if (!existsSync(figBuild)) throw new Error('node_modules/@withfig/autocomplete is missing; run npm install');
  // Convert everything first, then keep only what a top-level tool can reach through loadSpec.
  const converted = new Map();
  for (const { full, key } of specFiles(figBuild)) {
    let spec;
    try {
      spec = (await import(pathToFileURL(full).href)).default;
    } catch {
      stats.skipped++;
      continue;
    }
    if (!spec || typeof spec !== 'object') {
      stats.skipped++;
      continue;
    }
    const spec2 = convertSpec(spec);
    if (!spec2) {
      stats.skipped++;
      continue;
    }
    converted.set(key, { spec: spec2, json: JSON.stringify(spec2) });
  }

  // Only top-level files are tools; files in subfolders are loadSpec targets (aws/s3 ...).
  const reachable = new Set();
  const queue = [...converted.keys()].filter((k) => !k.includes('/'));
  while (queue.length) {
    const key = queue.pop();
    if (reachable.has(key) || !converted.has(key)) continue;
    reachable.add(key);
    for (const m of converted.get(key).json.matchAll(/"loadSpec":"([^"]+)"/g)) queue.push(m[1]);
  }
  stats.unreachable = converted.size - reachable.size;

  // Identical specs (hub = git, cl = commercelayer) share one gzipped file.
  const index = {};
  const byHash = new Map();
  for (const key of reachable) {
    const { spec, json } = converted.get(key);
    const hash = createHash('sha1').update(json).digest('hex');
    let file = byHash.get(hash);
    if (!file) {
      file = `fig/${key}.json.gz`;
      byHash.set(hash, file);
      const target = join(out, ...file.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, gzipSync(Buffer.from(json), { level: 9 }));
      stats.specs++;
    } else stats.deduped = (stats.deduped ?? 0) + 1;
    if (!key.includes('/')) for (const n of spec.names) index[n] = { file, description: spec.description };
  }
  return index;
}

// ------------------------------------------------------------------------------------------- tldr

async function tldrZip() {
  const file = join(cache, 'tldr-pages.en.zip');
  const stale = !existsSync(file) || args.has('--refresh-tldr');
  if (stale) {
    console.log(`kb: downloading ${TLDR_URL}`);
    const res = await fetch(TLDR_URL);
    if (!res.ok) throw new Error(`tldr download failed: HTTP ${res.status}`);
    mkdirSync(cache, { recursive: true });
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  return readFileSync(file);
}

export function parseTldrPage(markdown) {
  const lines = markdown.split(/\r?\n/);
  const description = [];
  const examples = [];
  let pending = null;
  for (const line of lines) {
    if (line.startsWith('> ')) {
      const text = line.slice(2).trim();
      if (!/^More information:/i.test(text) && !/^See also:/i.test(text)) description.push(text);
    } else if (line.startsWith('- ')) {
      pending = line.slice(2).trim().replace(/:$/, '');
    } else if (line.startsWith('`') && line.endsWith('`') && pending) {
      examples.push({ text: pending, command: line.slice(1, -1) });
      pending = null;
    }
  }
  return compact({ description: description.join(' ') || undefined, examples });
}

async function buildTldr() {
  const files = unzipSync(new Uint8Array(await tldrZip()));
  const pages = {};
  let count = 0;
  for (const [path, data] of Object.entries(files)) {
    const m = /(?:^|\/)(common|linux|windows)\/([^/]+)\.md$/.exec(path);
    if (!m) continue;
    const [, platform, tool] = m;
    (pages[tool] ??= {})[platform] = parseTldrPage(strFromU8(data));
    count++;
  }
  writeFileSync(join(out, 'tldr.json.gz'), gzipSync(Buffer.from(JSON.stringify(pages)), { level: 9 }));
  return count;
}

// ------------------------------------------------------------------------------------------- main

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const started = Date.now();
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const fig = await buildFig();
  const tldr = await buildTldr();
  const index = { version: KB_VERSION, generatedAt: new Date().toISOString(), fig };
  writeFileSync(join(out, 'index.json'), JSON.stringify(index));
  writeFileSync(
    join(out, 'NOTICE.md'),
    [
      '# Third-party data in this folder',
      '',
      '- `fig/`: converted from withfig/autocomplete (https://github.com/withfig/autocomplete), MIT/ISC license.',
      '- `tldr.json.gz`: from tldr-pages (https://github.com/tldr-pages/tldr), CC BY 4.0.',
      '',
    ].join('\n'),
  );
  const size = (dir) =>
    readdirSync(dir, { withFileTypes: true }).reduce(
      (n, e) => n + (e.isDirectory() ? size(join(dir, e.name)) : statSync(join(dir, e.name)).size),
      0,
    );
  console.log(
    `kb: ${stats.specs} specs (${Object.keys(fig).length} tool names, ${stats.options} options, ` +
      `${stats.helpers} generators mapped to helpers, ${stats.droppedGenerators} dropped, ${stats.skipped} skipped, ` +
      `${stats.unreachable} unreachable, ${stats.deduped ?? 0} duplicates), ` +
      `${tldr} tldr pages, ${(size(out) / 1e6).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(1)} s`,
  );
}
