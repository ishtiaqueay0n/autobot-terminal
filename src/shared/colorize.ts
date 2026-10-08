import type { OutputRole, Palette } from './palette';

/**
 * Colours for what commands print, chosen by the words and by the shape of what is printed: errors, warnings and
 * successes by their words; paths, URLs, addresses, times, numbers and quoted text by their shape; added and
 * removed lines in a diff. It only inserts colour codes (never moves, adds or removes text), only into lines that
 * carry no escape codes of their own, so programs that colour their output keep their own colours.
 */

interface Rule {
  role: OutputRole;
  re: RegExp;
}

const word = (alternatives: string, flags = 'gi'): RegExp => new RegExp(`(?<![\\w-])(?:${alternatives})(?![\\w-])`, flags);

/** Rules in priority order: when two match the same text, the earlier one wins. */
const RULES: Rule[] = [
  { role: 'url', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]+|\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/gi },
  {
    role: 'time',
    re: /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b|\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),? (?:\d{1,2} )?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}(?: \d{2}:\d{2}:\d{2})?(?: \d{4})?|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}\d{1,2} \d{2}:\d{2}(?::\d{2})?\b|(?<![\w.:])\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?(?![\w.:])/g,
  },
  { role: 'ip', re: /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2}|:\d{1,5})?(?![\w.])|(?<![\w:])(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}(?![\w:])/gi },
  { role: 'id', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b(?:sha(?:1|256|512)[:-])?[0-9a-f]{32,64}\b|\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,12}\b/g },
  {
    role: 'path',
    re: /(?<![\w./~-])(?:~|\.{1,2})?\/(?:[\w.@%+~=,-]+\/)*[\w.@%+~=,-]+\/?(?::\d+(?::\d+)?)?|(?<![\w./~-])~\/|(?<![\w.])[A-Za-z]:\\(?:[^\s"'<>|*?\\]+\\)*[^\s"'<>|*?\\]*|(?<![\w./~-])(?:[\w.@-]+\/)+[\w@-]+\.[A-Za-z0-9]{1,6}(?::\d+(?::\d+)?)?\b/g,
  },
  // Errors, then warnings, then successes: longer phrases first so "no such file or directory" is one piece.
  {
    role: 'error',
    re: word(
      "no such file or directory|command not found|permission denied|segmentation fault|core dumped|not permitted|timed out|connection (?:refused|reset|closed)|unable to|could not|couldn't|can't|cannot|failed|failure|failures|failing|fails|error|errors|err|fatal|critical|panic|exception|traceback|denied|refused|forbidden|unauthorized|invalid|illegal|corrupt|corrupted|aborted|abort|killed|timeout|unreachable|unavailable|unknown|missing|broken|crashed|crash|rejected|violation|not found|no such|E\\d{4,}",
    ),
  },
  { role: 'warning', re: word('warnings?|warn|deprecated|caution|notice|skipped|skipping|ignored|obsolete|insecure|retrying|retry|slow|unsupported|overwrit(?:e|ing|ten)|dangerous') },
  // Short words only in capitals (OK, UP): in lower case they are ordinary words.
  { role: 'success', re: word('OK|PASS|PASSED|DONE|SUCCESS|READY|UP|ACTIVE', 'g') },
  {
    role: 'success',
    re: word('success|successful|successfully|succeeded|completed?|installed|passed|healthy|finished|enabled|created|connected|started|up to date|up-to-date|running|listening|resolved|saved|updated|loaded|valid|verified'),
  },
  { role: 'info', re: /\[(?:info|note|hint|tip|notice)\]|(?<![\w-])(?:INFO|NOTE|HINT|TIP)(?![\w-])/gi },
  { role: 'debug', re: /\[(?:debug|trace|verbose)\]|(?<![\w-])(?:DEBUG|TRACE|VERBOSE)(?![\w-])/gi },
  { role: 'string', re: /"[^"\n]{1,200}"|(?<![\w])'[^'\n]{1,120}'(?![\w])/g },
  // Numbers with a unit, versions, plain numbers.
  {
    role: 'number',
    re: /(?<![\w.])\d+(?:[.,]\d+)?\s?(?:[KMGTPE]i?B|B|bytes?|ms|µs|us|ns|sec|secs|min|mins|hours?|MHz|GHz|kB|rpm|%)(?![\w])|(?<![\w.])v?\d+\.\d+(?:\.\d+)+(?:[-+][\w.]+)?(?![\w.])|(?<![\w.#-])[+-]?\d+(?:[.,]\d+)?(?![\w.-])/g,
  },
  { role: 'option', re: /(?<=^|[\s[(,|])--?[A-Za-z][\w-]*/g },
  { role: 'key', re: /^\s*[A-Z][\w .-]{0,30}(?=:\s)|(?<![\w-])[A-Za-z_][\w.-]*(?==[^\s=])/g },
];

const DIFF_START = /^(?:diff --git |index [0-9a-f]+\.\.[0-9a-f]+|@@ .* @@|--- (?:a\/|\/dev\/null)|\+\+\+ (?:b\/|\/dev\/null))/;
const PERMISSIONS = /^[-dlcbps][rwxsStT-]{9}[.+@]?(?=\s)/;
const RULE_LINE = /^\s*[-=_~*─━]{4,}\s*$/;
const HEADING = /^[A-Z][A-Z0-9 _-]{2,40}:?\s*$/;
const HTTP_STATUS = /\bHTTP\/\d(?:\.\d)? (\d{3})\b|\b(?:status|code)[: =]+(\d{3})\b/gi;

/** Longest chunk and line that are coloured: a flood of output (cat of a big file) passes through untouched. */
const MAX_CHUNK = 64 * 1024;
const MAX_LINE = 2000;

const ALT_SCREEN = /\x1b\[\?(?:1049|1047|47)([hl])/g;

function sgr(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}

interface Span {
  start: number;
  end: number;
  role: OutputRole;
}

function httpRole(code: number): OutputRole {
  return code >= 500 ? 'error' : code >= 400 ? 'warning' : code >= 300 ? 'info' : 'success';
}

/** The coloured pieces of one line, without overlaps. */
export function outputSpans(line: string, inDiff: boolean): Span[] {
  if (inDiff) {
    if (/^@@ /.test(line)) return [{ start: 0, end: line.length, role: 'hunk' }];
    if (/^\+(?!\+\+ )/.test(line)) return [{ start: 0, end: line.length, role: 'added' }];
    if (/^-(?!-- )/.test(line)) return [{ start: 0, end: line.length, role: 'removed' }];
    if (/^(?:diff --git |index |--- |\+\+\+ )/.test(line)) return [{ start: 0, end: line.length, role: 'key' }];
  }
  if (RULE_LINE.test(line)) return [{ start: 0, end: line.length, role: 'debug' }];
  if (HEADING.test(line)) return [{ start: 0, end: line.length, role: 'heading' }];

  const taken = new Uint8Array(line.length);
  const spans: Span[] = [];
  const claim = (start: number, end: number, role: OutputRole) => {
    if (end <= start) return;
    for (let i = start; i < end; i++) if (taken[i]) return;
    taken.fill(1, start, end);
    spans.push({ start, end, role });
  };

  const perms = PERMISSIONS.exec(line);
  if (perms) claim(0, perms[0].length, perms[0][0] === 'd' ? 'path' : 'debug');
  HTTP_STATUS.lastIndex = 0;
  for (let m = HTTP_STATUS.exec(line); m; m = HTTP_STATUS.exec(line)) {
    // "HTTP/1.1" is a protocol name (it would pass for a path), the code after it says how it went.
    if (m[1] !== undefined) claim(m.index, m.index + m[0].indexOf(' '), 'debug');
    const code = m[1] ?? m[2];
    const at = m.index + m[0].lastIndexOf(code);
    claim(at, at + code.length, httpRole(Number(code)));
  }
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (let m = rule.re.exec(line); m; m = rule.re.exec(line)) {
      if (m[0] === '') {
        rule.re.lastIndex++;
        continue;
      }
      claim(m.index, m.index + m[0].length, rule.role);
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

/** Inserts colour codes around the spans of a line. */
export function colorLine(line: string, spans: Span[], palette: Palette): string {
  if (spans.length === 0) return line;
  let out = '';
  let at = 0;
  for (const s of spans) {
    out += line.slice(at, s.start) + sgr(palette[s.role]) + line.slice(s.start, s.end) + '\x1b[39m';
    at = s.end;
  }
  return out + line.slice(at);
}

/**
 * Colours a stream of output chunks. Keeps the little state that spans chunks: a full-screen program (vim, less)
 * is running, or the output is a diff.
 */
export class OutputColorizer {
  private altScreen = false;
  private diff = false;

  /** A new prompt: nothing from the last command carries over. */
  reset(): void {
    this.altScreen = false;
    this.diff = false;
  }

  push(chunk: string, palette: Palette): string {
    if (chunk.length > MAX_CHUNK) return chunk;
    let toggled = false;
    ALT_SCREEN.lastIndex = 0;
    for (let m = ALT_SCREEN.exec(chunk); m; m = ALT_SCREEN.exec(chunk)) {
      this.altScreen = m[1] === 'h';
      toggled = true;
    }
    if (this.altScreen || toggled) return chunk;

    const parts = chunk.split('\n');
    for (let i = 0; i < parts.length; i++) {
      const raw = parts[i];
      const cr = raw.endsWith('\r');
      const line = cr ? raw.slice(0, -1) : raw;
      // Anything but plain text (escape codes, carriage returns that redraw a line, other controls): leave alone.
      // eslint-disable-next-line no-control-regex
      if (line.length === 0 || line.length > MAX_LINE || /[\x00-\x08\x0b-\x1f\x7f]/.test(line)) continue;
      if (DIFF_START.test(line)) this.diff = true;
      const spans = outputSpans(line, this.diff);
      if (spans.length > 0) parts[i] = colorLine(line, spans, palette) + (cr ? '\r' : '');
    }
    return parts.join('\n');
  }
}
