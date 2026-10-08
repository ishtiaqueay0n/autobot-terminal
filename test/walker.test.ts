import { describe, expect, it } from 'vitest';
import { availableOptions, currentArg, walk, type SpecSource } from '../src/main/complete/walker';
import type { KbSpec } from '../src/shared/kb-types';

const kubectl: KbSpec = {
  names: ['kubectl'],
  options: [
    { names: ['-n', '--namespace'], persistent: true, args: [{ name: 'namespace', helpers: ['kubectl.namespaces'] }] },
    { names: ['--context'], persistent: true, args: [{ name: 'context' }] },
  ],
  subcommands: [
    {
      names: ['get'],
      options: [
        { names: ['-o', '--output'], args: [{ name: 'format', suggestions: [{ name: 'json' }, { name: 'yaml' }] }] },
        { names: ['-A', '--all-namespaces'] },
        { names: ['-w', '--watch'] },
      ],
      args: [{ name: 'type' }, { name: 'name', variadic: true }],
    },
    { names: ['logs'], loadSpec: 'kubectl/logs' },
  ],
};
const logs: KbSpec = { names: ['logs'], options: [{ names: ['-f', '--follow'] }], args: [{ name: 'pod' }] };

const source: SpecSource = {
  root: (tool) => (tool === 'kubectl' ? kubectl : null),
  child: (_tool, _path, sub) => (sub.loadSpec === 'kubectl/logs' ? logs : sub),
};

const w = (...args: string[]) => walk('kubectl', args, source, false)!;

describe('walk', () => {
  it('returns null for unknown tools', () => {
    expect(walk('nope', [], source, false)).toBeNull();
  });

  it('descends into subcommands and inherits persistent options', () => {
    const s = w('get');
    expect(s.path).toEqual(['get']);
    expect(availableOptions(s).map((o) => o.names[0])).toEqual(['-o', '-A', '-w', '-n', '--context']);
  });

  it('expands split-out subcommand specs', () => {
    expect(w('logs').node.options?.[0].names).toContain('--follow');
  });

  it('knows when the current word is an option value', () => {
    expect(w('get', '-o').pending?.names).toContain('--output');
    expect(w('get', '-o', 'json').pending).toBeNull();
    expect(w('get', '--output=json').pending).toBeNull();
    expect(w('-n').pending?.names).toContain('--namespace');
  });

  it('counts positional arguments and handles variadic ones', () => {
    const s = w('get', 'pods');
    expect(s.positional).toBe(1);
    expect(currentArg(s)?.name).toBe('name');
    expect(currentArg(w('get', 'pods', 'a', 'b'))?.name).toBe('name');
    expect(currentArg(w('get'))?.name).toBe('type');
  });

  it('does not treat a positional word as a subcommand', () => {
    // "logs" after a positional argument is an argument, not the subcommand.
    expect(w('get', 'pods', 'logs').path).toEqual(['get']);
  });

  it('understands combined short flags', () => {
    const s = w('get', '-Aw');
    expect([...s.used].map((o) => o.names[0]).sort()).toEqual(['-A', '-w']);
  });

  it('records usage facts for learning', () => {
    expect(w('-n', 'prod', 'get', 'pods', '-o', 'yaml').usage).toEqual([
      { slot: 'opt:', value: '-n' },
      { slot: 'val::-n', value: 'prod' },
      { slot: 'sub:', value: 'get' },
      { slot: 'pos:get:0', value: 'pods' },
      { slot: 'opt:get', value: '-o' },
      { slot: 'val:get:-o', value: 'yaml' },
    ]);
  });

  it('stops parsing options after --', () => {
    const s = w('get', '--', '-o');
    expect(s.pending).toBeNull();
    expect(s.positional).toBe(1);
  });

  it('matches PowerShell parameters case-insensitively and by unique prefix', () => {
    const ps: KbSpec = {
      names: ['Get-ChildItem'],
      options: [{ names: ['-Path'], args: [{ name: 'path' }] }, { names: ['-Recurse'] }, { names: ['-Force'] }],
    };
    const src: SpecSource = { root: () => ps, child: (_t, _p, s) => s };
    expect(walk('get-childitem', ['-path'], src, true)!.pending?.names).toEqual(['-Path']);
    expect([...walk('get-childitem', ['-rec'], src, true)!.used].map((o) => o.names[0])).toEqual(['-Recurse']);
  });
});

describe('walk usage learning', () => {
  it('does not learn free-text values', () => {
    const s = walk('kubectl', ['get', 'pods', '-o', 'hello world', 'my-pod'], source, false)!;
    expect(s.usage.map((u) => u.value)).toEqual(['get', 'pods', '-o', 'my-pod']);
  });
});
