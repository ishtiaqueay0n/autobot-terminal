/**
 * Questions Autobot asks the shell on the other end of an ssh session, such as "what is in this folder?". The
 * hook there defines `__autobot_rpc` (resources/shell/remote/common.sh); a question is a line typed at the idle
 * remote prompt, starting with a space so it stays out of the shell's history, and the answer comes back in a
 * marker. The shell echoes the line and prints a prompt afterwards, so while a question is open the terminal's
 * output is held back until that prompt arrives, and nothing of the exchange reaches the screen.
 */

/** A silent shell would freeze the screen otherwise: the exchange is over after this long no matter what. */
const HOLD_MAX_MS = 6000;

interface Request {
  op: string;
  arg: string;
  resolve: (answer: string | null) => void;
}

export class RemoteRpc {
  private readonly queue: Request[] = [];
  private active: { id: number; resolve: (answer: string | null) => void; timer: NodeJS.Timeout } | null = null;
  private holding = false;
  private holdTimer: NodeJS.Timeout | null = null;
  /** The remote side did not answer (no helper, or too slow): stop asking until the context changes. */
  private broken = false;
  private nextId = 1;

  constructor(
    /** Types text into the shell. */
    private readonly send: (text: string) => void,
    /** True when the shell is idle at a remote prompt, so a question can be typed. */
    private readonly canAsk: () => boolean,
    /** An exchange ended: whatever waited for it can go ahead. */
    private readonly released: () => void,
    private readonly timeoutMs = 2000,
  ) {}

  /** An exchange is under way: output is held back and input must wait. */
  get busy(): boolean {
    return this.holding;
  }

  /** The answer (text decoded from base64) or null when it could not be had. */
  request(op: string, arg: string): Promise<string | null> {
    if (this.broken) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.queue.push({ op, arg, resolve });
      this.pump();
    });
  }

  /** The reply marker for question `id` arrived. */
  reply(id: string, data: string): void {
    const a = this.active;
    if (!a || String(a.id) !== id) return;
    clearTimeout(a.timer);
    this.active = null;
    let text: string | null = null;
    try {
      text = Buffer.from(data, 'base64').toString('utf8');
    } catch {
      // Garbled: treated as no answer.
    }
    a.resolve(text);
  }

  /** The remote prompt that follows the exchange arrived. */
  prompt(): void {
    this.release();
  }

  /** The user is about to run something: questions that were waiting for a quiet moment are dropped. */
  cancelQueued(): void {
    for (const r of this.queue.splice(0)) r.resolve(null);
  }

  /** The tab moved to another machine (or back): forget what was learned about the old one. */
  reset(): void {
    this.cancelQueued();
    this.broken = false;
    if (this.active) {
      clearTimeout(this.active.timer);
      this.active.resolve(null);
      this.active = null;
    }
    this.holding = false;
    this.clearHold();
  }

  /** Call when the previous question's prompt or the user's command made room: sends the next question. */
  pump(): void {
    if (this.active || this.holding || this.broken || this.queue.length === 0 || !this.canAsk()) return;
    const job = this.queue.shift()!;
    const id = this.nextId++;
    this.holding = true;
    this.holdTimer = setTimeout(() => this.release(), HOLD_MAX_MS);
    this.active = {
      id,
      resolve: job.resolve,
      timer: setTimeout(() => {
        // No answer in time: stop asking this machine (the exchange itself ends with its prompt).
        this.broken = true;
        this.active?.resolve(null);
        this.active = null;
      }, this.timeoutMs),
    };
    this.send(` __autobot_rpc ${id} ${job.op} ${Buffer.from(job.arg, 'utf8').toString('base64')}\r`);
  }

  dispose(): void {
    this.reset();
  }

  private release(): void {
    if (!this.holding) return;
    this.holding = false;
    this.clearHold();
    if (this.active) {
      // The prompt came back without an answer: the helper is missing or broken.
      clearTimeout(this.active.timer);
      this.active.resolve(null);
      this.active = null;
      this.broken = true;
    }
    this.released();
    this.pump();
  }

  private clearHold(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }
}
