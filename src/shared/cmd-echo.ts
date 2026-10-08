import { CMD_HOOK_SUFFIX } from './submit';

/**
 * cmd.exe (through ConPTY) echoes the line it was sent, including the exit-code hook that Autobot appends
 * (CMD_HOOK_SUFFIX). This streaming filter replaces that text with spaces, so the echoed command looks as typed
 * and the cursor positions ConPTY sends around it stay correct. The text can arrive split across chunks, so a
 * tail that could be the start of the suffix is held back until the next chunk.
 */
export class CmdEchoFilter {
  private pending = '';

  push(chunk: string): string {
    let buf = this.pending + chunk;
    this.pending = '';
    const blank = ' '.repeat(CMD_HOOK_SUFFIX.length);
    buf = buf.split(CMD_HOOK_SUFFIX).join(blank);
    const keep = partialSuffixLength(buf);
    this.pending = buf.slice(buf.length - keep);
    return buf.slice(0, buf.length - keep);
  }

  /** Returns any held-back text (the PTY ended in the middle of it). */
  flush(): string {
    const rest = this.pending;
    this.pending = '';
    return rest;
  }
}

function partialSuffixLength(buf: string): number {
  const max = Math.min(CMD_HOOK_SUFFIX.length - 1, buf.length);
  for (let len = max; len > 0; len--) {
    if (CMD_HOOK_SUFFIX.startsWith(buf.slice(buf.length - len))) return len;
  }
  return 0;
}
