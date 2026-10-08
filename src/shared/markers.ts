/**
 * Streaming parser for Autobot's private OSC 7777 shell markers.
 *
 *   ESC ] 7777 ; A ; <exit> ; <cwd> BEL   prompt ready
 *   ESC ] 7777 ; C BEL                    command started
 *   ESC ] 7777 ; P ; <Key>=<Value> BEL    session property
 *   ESC ] 7777 ; R ; <host> ; <shell> BEL  the shell that prints the next prompt runs on another machine (SSH)
 *   ESC ] 7777 ; Q ; <id> ; <data> BEL     answer to a request Autobot typed into a remote shell
 *
 * Markers are removed from the output stream; everything else passes through untouched and in order.
 * Both BEL and ST (ESC \) terminate a marker. PTY chunks can split a marker anywhere.
 */

export type ShellMarker =
  | { kind: 'prompt'; exitCode: number; cwd: string }
  | { kind: 'commandStart' }
  | { kind: 'property'; key: string; value: string }
  | { kind: 'remote'; host: string; shell: 'bash' | 'zsh' }
  | { kind: 'reply'; id: string; data: string };

export type ParsedItem = { type: 'data'; data: string } | { type: 'marker'; marker: ShellMarker };

const INTRO = '\x1b]7777;';
/**
 * A marker longer than this is treated as garbage and passed through as plain output. Large enough for a remote
 * machine's command list or a folder listing, which travel inside markers.
 */
const MAX_MARKER_LENGTH = 512 * 1024;

export function parseMarkerPayload(payload: string): ShellMarker | null {
  const sep = payload.indexOf(';');
  const kind = sep === -1 ? payload : payload.slice(0, sep);
  const rest = sep === -1 ? '' : payload.slice(sep + 1);
  switch (kind) {
    case 'A': {
      const sep2 = rest.indexOf(';');
      if (sep2 === -1) return null;
      const exitCode = Number.parseInt(rest.slice(0, sep2), 10);
      // The cwd is everything after the exit code; it may itself contain ';'.
      return { kind: 'prompt', exitCode: Number.isNaN(exitCode) ? 0 : exitCode, cwd: rest.slice(sep2 + 1) };
    }
    case 'C':
      return { kind: 'commandStart' };
    case 'P': {
      const eq = rest.indexOf('=');
      if (eq <= 0) return null;
      return { kind: 'property', key: rest.slice(0, eq), value: rest.slice(eq + 1) };
    }
    case 'R': {
      const sep2 = rest.lastIndexOf(';');
      const shell = rest.slice(sep2 + 1);
      if (sep2 <= 0 || (shell !== 'bash' && shell !== 'zsh')) return null;
      return { kind: 'remote', host: rest.slice(0, sep2), shell };
    }
    case 'Q': {
      const sep2 = rest.indexOf(';');
      return sep2 <= 0 ? null : { kind: 'reply', id: rest.slice(0, sep2), data: rest.slice(sep2 + 1) };
    }
    default:
      return null;
  }
}

export class MarkerParser {
  private pending = '';

  push(chunk: string): ParsedItem[] {
    const items: ParsedItem[] = [];
    let buf = this.pending + chunk;
    this.pending = '';

    for (;;) {
      const start = buf.indexOf(INTRO);
      if (start === -1) {
        // Hold back a tail that could be the beginning of a marker split across chunks.
        const keep = partialIntroLength(buf);
        emitData(items, buf.slice(0, buf.length - keep));
        this.pending = buf.slice(buf.length - keep);
        return items;
      }

      emitData(items, buf.slice(0, start));
      const bodyStart = start + INTRO.length;
      const end = findTerminator(buf, bodyStart);
      if (end === null) {
        if (buf.length - start > MAX_MARKER_LENGTH) {
          emitData(items, buf.slice(start));
        } else {
          this.pending = buf.slice(start);
        }
        return items;
      }

      const marker = parseMarkerPayload(buf.slice(bodyStart, end.index));
      if (marker) items.push({ type: 'marker', marker });
      buf = buf.slice(end.index + end.length);
    }
  }

  /** Returns any held-back text, e.g. when the PTY exits. */
  flush(): string {
    const rest = this.pending;
    this.pending = '';
    return rest;
  }
}

function emitData(items: ParsedItem[], data: string): void {
  if (!data) return;
  const last = items[items.length - 1];
  if (last && last.type === 'data') last.data += data;
  else items.push({ type: 'data', data });
}

function findTerminator(buf: string, from: number): { index: number; length: number } | null {
  for (let i = from; i < buf.length; i++) {
    const c = buf.charCodeAt(i);
    if (c === 0x07) return { index: i, length: 1 };
    if (c === 0x1b) {
      if (i + 1 >= buf.length) return null; // could be the start of ST; wait for more
      if (buf[i + 1] === '\\') return { index: i, length: 2 };
    }
  }
  return null;
}

function partialIntroLength(buf: string): number {
  const max = Math.min(INTRO.length - 1, buf.length);
  for (let len = max; len > 0; len--) {
    if (INTRO.startsWith(buf.slice(buf.length - len))) return len;
  }
  return 0;
}
