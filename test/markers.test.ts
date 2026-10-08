import { describe, expect, it } from 'vitest';
import { MarkerParser, parseMarkerPayload, type ParsedItem } from '../src/shared/markers';

const A = (code: number, cwd: string) => `\x1b]7777;A;${code};${cwd}\x07`;

function collect(chunks: string[]): ParsedItem[] {
  const parser = new MarkerParser();
  const items: ParsedItem[] = [];
  for (const chunk of chunks) {
    for (const item of parser.push(chunk)) {
      const last = items[items.length - 1];
      if (item.type === 'data' && last?.type === 'data') last.data += item.data;
      else items.push(item);
    }
  }
  const rest = parser.flush();
  if (rest) items.push({ type: 'data', data: rest });
  return items;
}

describe('parseMarkerPayload', () => {
  it('parses prompt markers, keeping semicolons in the cwd', () => {
    expect(parseMarkerPayload('A;0;/home/me')).toEqual({ kind: 'prompt', exitCode: 0, cwd: '/home/me' });
    expect(parseMarkerPayload('A;127;/tmp/a;b')).toEqual({ kind: 'prompt', exitCode: 127, cwd: '/tmp/a;b' });
    expect(parseMarkerPayload('A;1;C:\\Users\\me')).toEqual({ kind: 'prompt', exitCode: 1, cwd: 'C:\\Users\\me' });
  });

  it('parses command start and properties', () => {
    expect(parseMarkerPayload('C')).toEqual({ kind: 'commandStart' });
    expect(parseMarkerPayload('P;Home=/home/me')).toEqual({ kind: 'property', key: 'Home', value: '/home/me' });
    expect(parseMarkerPayload('P;Shell=bash 5.2.21')).toEqual({ kind: 'property', key: 'Shell', value: 'bash 5.2.21' });
  });

  it('rejects malformed or unknown payloads', () => {
    expect(parseMarkerPayload('A;0')).toBeNull();
    expect(parseMarkerPayload('P;novalue')).toBeNull();
    expect(parseMarkerPayload('Z;x')).toBeNull();
  });
});

describe('MarkerParser', () => {
  it('strips markers and keeps order', () => {
    expect(collect([`hello\r\n${A(0, '/tmp')}`, 'next'])).toEqual([
      { type: 'data', data: 'hello\r\n' },
      { type: 'marker', marker: { kind: 'prompt', exitCode: 0, cwd: '/tmp' } },
      { type: 'data', data: 'next' },
    ]);
  });

  it('handles a marker split at every possible position', () => {
    const full = `out${A(2, '/x/y')}more`;
    for (let cut = 1; cut < full.length; cut++) {
      expect(collect([full.slice(0, cut), full.slice(cut)])).toEqual([
        { type: 'data', data: 'out' },
        { type: 'marker', marker: { kind: 'prompt', exitCode: 2, cwd: '/x/y' } },
        { type: 'data', data: 'more' },
      ]);
    }
  });

  it('accepts ST (ESC \\) as terminator', () => {
    expect(collect(['\x1b]7777;C\x1b\\ok'])).toEqual([
      { type: 'marker', marker: { kind: 'commandStart' } },
      { type: 'data', data: 'ok' },
    ]);
  });

  it('passes other escape sequences through untouched', () => {
    const other = '\x1b]0;title\x07\x1b[31mred\x1b[0m\x1b]777;x\x07';
    expect(collect([other])).toEqual([{ type: 'data', data: other }]);
  });

  it('does not hold back a lone ESC that cannot start a marker', () => {
    const parser = new MarkerParser();
    expect(parser.push('abc\x1b[')).toEqual([{ type: 'data', data: 'abc\x1b[' }]);
  });

  it('holds back a possible marker prefix until the next chunk', () => {
    const parser = new MarkerParser();
    expect(parser.push('abc\x1b]77')).toEqual([{ type: 'data', data: 'abc' }]);
    expect(parser.push('x')).toEqual([{ type: 'data', data: '\x1b]77x' }]);
  });

  it('gives up on an unterminated marker that grows too long', () => {
    const junk = `\x1b]7777;A;0;${'x'.repeat(9000)}`;
    const items = collect([junk]);
    expect(items).toEqual([{ type: 'data', data: junk }]);
  });
});

describe('remote (SSH) markers', () => {
  it('parses the remote context and keeps semicolons in the host', () => {
    expect(parseMarkerPayload('R;alice@prod-db;bash')).toEqual({ kind: 'remote', host: 'alice@prod-db', shell: 'bash' });
    expect(parseMarkerPayload('R;weird;name@host;zsh')).toEqual({ kind: 'remote', host: 'weird;name@host', shell: 'zsh' });
    expect(parseMarkerPayload('R;host;fish')).toBeNull();
    expect(parseMarkerPayload('R;bash')).toBeNull();
  });

  it('parses replies to requests, with data that may contain semicolons', () => {
    expect(parseMarkerPayload('Q;7;aGVsbG8=')).toEqual({ kind: 'reply', id: '7', data: 'aGVsbG8=' });
    expect(parseMarkerPayload('Q;7;')).toEqual({ kind: 'reply', id: '7', data: '' });
    expect(parseMarkerPayload('Q;x')).toBeNull();
  });

  it('accepts a long marker such as a remote command list', () => {
    const big = 'x'.repeat(60_000);
    const items = collect([`before\x1b]7777;P;RemoteCommands=${big}\x07after`]);
    expect(items).toEqual([
      { type: 'data', data: 'before' },
      { type: 'marker', marker: { kind: 'property', key: 'RemoteCommands', value: big } },
      { type: 'data', data: 'after' },
    ]);
  });
});
