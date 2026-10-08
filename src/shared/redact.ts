/**
 * Masks obvious secrets in a command line before it is stored in history or (later) sent to an LLM.
 * Errs toward masking: a masked non-secret costs a slightly worse suggestion, a leaked secret costs more.
 */

const MASK = '***';
const VALUE = `("[^"]*"|'[^']*'|\\S+)`;

const RULES: [RegExp, string][] = [
  // --password=x, --token x, --api-key "x", --client-secret=x ...
  [
    new RegExp(
      `(--?(?:password|passwd|pass|pwd|token|secret|api[-_]?key|apikey|access[-_]?key|secret[-_]?key|client[-_]?secret|auth)(?:=|\\s+))${VALUE}`,
      'gi',
    ),
    `$1${MASK}`,
  ],
  // NAME=x (bash, env) and $env:NAME = x (PowerShell) where NAME looks secret.
  [
    new RegExp(
      `(\\b[A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?)[A-Za-z0-9_]*\\s*=\\s*)${VALUE}`,
      'gi',
    ),
    `$1${MASK}`,
  ],
  // Authorization header values.
  [/(\b(?:Bearer|Basic|Token)\s+)[A-Za-z0-9._~+/=-]{8,}/g, `$1${MASK}`],
  // user:password@ in URLs.
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+(@)/gi, `$1${MASK}$2`],
  // curl -u user:password, --user user:password
  [/((?:\s-u\s*|--user[=\s]+)["']?[^\s:"']+:)[^\s"']+/g, `$1${MASK}`],
  // mysql -pSECRET, sshpass -p SECRET
  [/(\b(?:mysql|mariadb|mysqldump|mysqladmin)\b[^\n]*?\s-p)(\S+)/g, `$1${MASK}`],
  [/(\bsshpass\s+-p\s*)(\S+)/g, `$1${MASK}`],
  // ConvertTo-SecureString "x" -AsPlainText
  [new RegExp(`(ConvertTo-SecureString\\s+(?:-String\\s+)?)${VALUE}`, 'gi'), `$1${MASK}`],
  // Well-known token formats anywhere in the line.
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}\b/g, MASK],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g, MASK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, MASK],
];

export interface Redaction {
  text: string;
  /** True when anything was masked. */
  changed: boolean;
}

export function redact(command: string): Redaction {
  let text = command;
  for (const [pattern, replacement] of RULES) text = text.replace(pattern, replacement);
  return { text, changed: text !== command };
}

/** `password: x`, `"token": "x"`, `api_key = x` in program output (config dumps, error messages). */
const KEY_VALUE =
  /(\b[\w-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)["']?\s*[:=]\s*["']?)([^\s"',;]{3,})/gi;
const PEM = /(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g;

/**
 * Masks secrets in program output before it is sent to an AI: everything `redact` catches, private key
 * blocks, and key/value pairs that look secret. The home folder becomes `~`, so the user name stays local.
 */
export function redactOutput(text: string, home?: string | null): string {
  let out = text.replace(PEM, `$1\n${MASK}\n$2`);
  out = out
    .split('\n')
    .map((line) => redact(line).text.replace(KEY_VALUE, `$1${MASK}`))
    .join('\n');
  if (home && home.length > 3) out = out.split(home).join('~');
  return out;
}
