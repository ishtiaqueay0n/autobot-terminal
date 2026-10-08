import { createRequire } from 'node:module';
import { sep } from 'node:path';
import type * as NodePty from 'node-pty';

const nodeRequire = createRequire(__filename);

/**
 * Loads node-pty from app.asar.unpacked in packaged builds.
 *
 * node-pty starts a worker thread from a path relative to its own __dirname to drain ConPTY output. It
 * only rewrites "node_modules.asar" paths, so when loaded through app.asar the worker cannot start,
 * nothing drains the output pipe, and spawn() blocks for ~5 s. Loading the unpacked copy directly makes
 * every path it computes point at real files.
 */
export function unpackedPath(resolved: string): string {
  const marker = `${sep}app.asar${sep}`;
  return resolved.includes(marker) ? resolved.replace(marker, `${sep}app.asar.unpacked${sep}`) : resolved;
}

export const pty: typeof NodePty = nodeRequire(unpackedPath(nodeRequire.resolve('node-pty')));
