import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PtySession, type CommandResult } from '../../src/main/session';
import type { ResolvedProfile, SshLaunch } from '../../src/main/profiles';
import { toHostPath } from '../../src/shared/paths';
import type { SessionEvent } from '../../src/shared/types';

/** Runs real shells with the Autobot hook through node-pty and records what the session reports. */

export const shellDir = join(__dirname, '..', '..', 'resources', 'shell');
export const live: PtySession[] = [];

export type Prompt = Extract<SessionEvent, { type: 'prompt' }>;

export class Harness {
  readonly events: SessionEvent[] = [];
  readonly results: CommandResult[] = [];
  readonly session: PtySession;
  private waiters: (() => void)[] = [];

  constructor(readonly profile: ResolvedProfile, ssh?: SshLaunch) {
    this.session = new PtySession({
      id: 1,
      profile,
      shellDir,
      ssh,
      cols: 120,
      rows: 30,
      onEvents: (evs) => {
        this.events.push(...evs);
        for (const w of this.waiters.splice(0)) w();
      },
      onExit: () => {},
      onCommandFinished: (r) => this.results.push(r),
    });
    live.push(this.session);
  }

  /** Reads the command-name file the hook reported (it may still be being written in the background). */
  async commandNames(): Promise<string[]> {
    const prop = this.events.find((e) => e.type === 'property' && e.key === 'Commands');
    if (prop?.type !== 'property') return [];
    const file = toHostPath(prop.value, this.profile);
    for (let i = 0; i < 60 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 500));
    return readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/);
  }

  get prompts(): Prompt[] {
    return this.events.filter((e): e is Prompt => e.type === 'prompt');
  }

  output(fromIndex = 0): string {
    return this.events
      .slice(fromIndex)
      .map((e) => (e.type === 'data' ? e.data : ''))
      .join('');
  }

  async waitFor(check: () => boolean, timeoutMs = 20000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out; output so far:\n${this.output()}`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 200);
      });
    }
  }

  /** Submits a command like the GUI does and resolves with the prompt that follows it. */
  async run(text: string, prompts = 1): Promise<{ prompt: Prompt; output: string; result: CommandResult | undefined }> {
    const before = this.prompts.length;
    const start = this.events.length;
    const results = this.results.length;
    this.session.submit(text, true);
    await this.waitFor(() => this.prompts.length >= before + prompts);
    return { prompt: this.prompts[this.prompts.length - 1], output: this.output(start), result: this.results[results] };
  }
}

