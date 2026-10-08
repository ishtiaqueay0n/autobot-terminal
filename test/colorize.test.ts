import { describe, expect, it } from 'vitest';
import { colorLine, OutputColorizer, outputSpans } from '../src/shared/colorize';
import { DARK_PALETTE, LIGHT_PALETTE } from '../src/shared/palette';

/** "text:role" for every coloured piece of an output line. */
function roles(line: string, diff = false): string[] {
  return outputSpans(line, diff).map((s) => `${line.slice(s.start, s.end)}:${s.role}`);
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('output colours by words', () => {
  it('marks errors, warnings and successes', () => {
    expect(roles('ls: cannot access /nope: No such file or directory')).toEqual([
      'cannot:error',
      '/nope:path',
      'No such file or directory:error',
    ]);
    expect(roles('bash: foo: command not found')).toEqual(['command not found:error']);
    expect(roles('Warning: this option is deprecated')).toEqual(['Warning:warning', 'deprecated:warning']);
    expect(roles('Build completed successfully')).toEqual(['completed:success', 'successfully:success']);
    expect(roles('[  OK  ] Started nginx.service')).toEqual(['OK:success', 'Started:success']);
    expect(roles('Process exited with errors: 3 failed')).toEqual(['errors:error', '3:number', 'failed:error']);
  });

  it('does not colour words that only contain them', () => {
    expect(roles('terrorist okapi warning-free-zone')).toEqual([]);
    expect(roles('The user was not interrupted')).toEqual([]);
  });

  it('marks log levels', () => {
    expect(roles('[INFO] starting')).toEqual(['[INFO]:info']);
    expect(roles('2024-05-01T10:20:30Z DEBUG cache miss')).toEqual(['2024-05-01T10:20:30Z:time', 'DEBUG:debug']);
  });
});

describe('output colours by shape', () => {
  it('finds paths, urls, addresses, times and ids', () => {
    expect(roles('wrote /var/log/app.log and ~/notes/todo.txt (see ./src/main.ts:42)')).toEqual([
      '/var/log/app.log:path',
      '~/notes/todo.txt:path',
      './src/main.ts:42:path',
    ]);
    expect(roles('GET https://example.com/a?b=1 from 10.0.0.12:8080')).toEqual(['https://example.com/a?b=1:url', '10.0.0.12:8080:ip']);
    expect(roles('commit 3f2a9c1 by bob@example.com')).toEqual(['3f2a9c1:id', 'bob@example.com:url']);
    expect(roles('id 123e4567-e89b-12d3-a456-426614174000')).toEqual(['123e4567-e89b-12d3-a456-426614174000:id']);
    expect(roles('C:\\Users\\me\\file.txt is there')).toEqual(['C:\\Users\\me\\file.txt:path']);
  });

  it('finds numbers with units, versions and plain numbers', () => {
    expect(roles('took 250 ms, 1.5 GB used, 85%')).toEqual(['250 ms:number', '1.5 GB:number', '85%:number']);
    expect(roles('node v22.4.1 and 7 items')).toEqual(['v22.4.1:number', '7:number']);
  });

  it('finds quoted text but not apostrophes', () => {
    expect(roles('name="Ada Lovelace"')).toEqual(['name:key', '"Ada Lovelace":string']);
    expect(roles("it's what they don't say")).toEqual([]);
  });

  it('colours HTTP status codes by class', () => {
    expect(roles('HTTP/1.1 200 OK')).toEqual(['HTTP/1.1:debug', '200:success', 'OK:success']);
    expect(roles('HTTP/1.1 404 Not Found')).toEqual(['HTTP/1.1:debug', '404:warning', 'Not Found:error']);
    expect(roles('status: 503')).toEqual(['503:error']);
  });

  it('finds labels, options in help text and permissions', () => {
    expect(roles('Active: active (running) since Mon')).toEqual(['Active:key', 'running:success']);
    expect(roles('  -h, --help     show help')).toEqual(['-h:option', '--help:option']);
    expect(roles('drwxr-xr-x  2 me me 4096 Oct  7 12:00 src')).toEqual(['drwxr-xr-x:path', '2:number', '4096:number', 'Oct  7 12:00:time']);
    expect(roles('-rw-r--r--  1 me me  120 Oct  7 12:00 a.txt')).toEqual(['-rw-r--r--:debug', '1:number', '120:number', 'Oct  7 12:00:time']);
  });

  it('colours headings and rules as a whole', () => {
    expect(roles('USAGE:')).toEqual(['USAGE::heading']);
    expect(roles('--------------')).toEqual(['--------------:debug']);
  });
});

describe('diffs', () => {
  it('colours added, removed and hunk lines once a diff has started', () => {
    expect(roles('+added line', true)).toEqual(['+added line:added']);
    expect(roles('-removed line', true)).toEqual(['-removed line:removed']);
    expect(roles('@@ -1,3 +1,4 @@', true)).toEqual(['@@ -1,3 +1,4 @@:hunk']);
    expect(roles('+++ b/file.txt', true)).toEqual(['+++ b/file.txt:key']);
    // Outside a diff a leading - is just text (a list item, an option).
    expect(roles('- item one')).toEqual([]);
  });
});

describe('OutputColorizer', () => {
  const colorizer = () => new OutputColorizer();

  it('only inserts colour codes, never changes the text', () => {
    const chunk = 'error: cannot open /etc/shadow: Permission denied\r\nok 3 items in 12 ms\r\npartial line with warning';
    const out = colorizer().push(chunk, DARK_PALETTE);
    expect(out).not.toBe(chunk);
    expect(strip(out)).toBe(chunk);
    // Line endings are kept exactly.
    expect(out.split('\n').map((l) => l.endsWith('\r'))).toEqual([true, true, false]);
  });

  it('uses 24-bit colours from the palette and resets only the foreground', () => {
    const out = colorizer().push('failed\n', LIGHT_PALETTE);
    expect(out).toBe('\x1b[38;2;207;34;46mfailed\x1b[39m\n');
  });

  it("leaves lines alone that carry escape codes (the program's own colours) or redraw with a carriage return", () => {
    const coloured = '\x1b[31merror\x1b[0m: already red\r\n';
    const progress = 'downloading 10%\rdownloading 50%\r\n';
    expect(colorizer().push(coloured + progress, DARK_PALETTE)).toBe(coloured + progress);
  });

  it('leaves full-screen programs alone until they leave the alternate screen', () => {
    const c = colorizer();
    expect(c.push('\x1b[?1049h', DARK_PALETTE)).toBe('\x1b[?1049h');
    expect(c.push('error in vim buffer\r\n', DARK_PALETTE)).toBe('error in vim buffer\r\n');
    expect(c.push('\x1b[?1049l', DARK_PALETTE)).toBe('\x1b[?1049l');
    expect(strip(c.push('error again\r\n', DARK_PALETTE))).toBe('error again\r\n');
    expect(c.push('error again\r\n', DARK_PALETTE)).not.toBe('error again\r\n');
  });

  it('knows a diff from its header until the next prompt', () => {
    const c = colorizer();
    c.push('diff --git a/x b/x\r\n', DARK_PALETTE);
    expect(c.push('-old\r\n', DARK_PALETTE)).toContain('\x1b[38;2;224;108;117m-old');
    c.reset();
    // No longer a diff: not red any more (a leading dash is an option, as in help text).
    expect(c.push('-old\r\n', DARK_PALETTE)).not.toContain('\x1b[38;2;224;108;117m');
  });

  it('passes a flood of output through untouched', () => {
    const big = 'error\n'.repeat(20_000);
    expect(colorizer().push(big, DARK_PALETTE)).toBe(big);
  });

  it('does not choke on odd input', () => {
    const c = colorizer();
    for (const s of ['', '\n', '\r\n', 'a'.repeat(5000), '\t\ttabbed error', '"unterminated', "'", '/', '~', '::::', '0.0.0.0.0.0.0']) {
      expect(strip(c.push(s, DARK_PALETTE))).toBe(s);
    }
  });
});

describe('colorLine', () => {
  it('leaves a line without spans as it is', () => {
    expect(colorLine('plain', [], DARK_PALETTE)).toBe('plain');
  });
});
