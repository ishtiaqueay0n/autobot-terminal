/**
 * The lists of command and variable names that the shell hooks write to the temp folder and report with a marker
 * ("Commands=<path>"). A marker is only text: any program, or a remote machine, can print one. So the only paths
 * Autobot reads (and then deletes) are the ones with the exact names the hooks use, and never a path that climbs.
 */
const HOOK_FILE = /^autobot-\d+\.(?:commands|vars)$/;

export function isHookFile(path: string): boolean {
  if (path.length > 1024 || path.includes('\0')) return false;
  const parts = path.split(/[\\/]/);
  return !parts.includes('..') && HOOK_FILE.test(parts[parts.length - 1] ?? '');
}

/** A home folder reported by a shell: absolute, POSIX, and not climbing out of itself. */
export function isPlainHome(home: string): boolean {
  return /^\/[^\0]{0,1023}$/.test(home) && !home.split('/').includes('..');
}
