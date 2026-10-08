import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { Worker } from 'node:worker_threads';

/**
 * Runs background programs (help learning, helpers, PowerShell introspection) from a worker thread.
 *
 * Creating a process is synchronous, and on Windows it can take from a few hundred milliseconds to seconds
 * while Defender scans the program or its command line. On the main thread that freezes the terminal: no
 * output, no prompt, no typing. In the worker it only delays the background result.
 */

export interface SpawnJob {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  input?: string;
  timeoutMs: number;
  maxBytes: number;
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/** Spawns, collects capped output, kills after the timeout. Shared by the worker and the fallback. */
function collect(job: SpawnJob, spawnFn: typeof spawn, done: (r: SpawnResult) => void): void {
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let child: ChildProcessByStdio<Writable | null, Readable, Readable>;
  try {
    const stdin = job.input === undefined ? 'ignore' : 'pipe';
    child = spawnFn(job.command, job.args, {
      cwd: job.cwd,
      env: job.env,
      windowsHide: true,
      stdio: [stdin, 'pipe', 'pipe'],
    }) as typeof child;
  } catch {
    done({ stdout: '', stderr: '', code: null, timedOut: false });
    return;
  }
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, job.timeoutMs);
  if (job.input !== undefined && child.stdin) {
    child.stdin.on('error', () => {}); // the program may exit without reading it
    child.stdin.end(job.input);
  }
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d: string) => {
    if (stdout.length < job.maxBytes) stdout += d;
  });
  child.stderr.on('data', (d: string) => {
    if (stderr.length < job.maxBytes) stderr += d;
  });
  let finished = false;
  const finish = (code: number | null) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    done({ stdout, stderr, code, timedOut });
  };
  child.on('error', () => finish(null));
  child.on('close', (code) => finish(code));
}

// The worker is plain JavaScript evaluated from this string, so it needs no separate bundle entry.
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const collect = ${collect.toString()};
parentPort.on('message', ({ id, job }) => collect(job, spawn, (result) => parentPort.postMessage({ id, result })));
`;

let worker: Worker | null = null;
let workerBroken = false;
let stopped = false;
let nextId = 1;
const pending = new Map<number, { job: SpawnJob; resolve: (r: SpawnResult) => void }>();

/** Jobs the worker did not finish run here instead. */
function rerunPending(): void {
  const jobs = [...pending.values()];
  pending.clear();
  for (const { job, resolve } of jobs) collect(job, spawn, resolve);
}

function getWorker(): Worker | null {
  if (worker || workerBroken || stopped) return worker;
  try {
    const w = new Worker(WORKER_SOURCE, { eval: true });
    w.unref(); // an idle worker never keeps the process alive
    w.on('message', ({ id, result }: { id: number; result: SpawnResult }) => {
      const entry = pending.get(id);
      pending.delete(id);
      if (pending.size === 0) w.unref();
      entry?.resolve(result);
    });
    w.on('error', (err) => {
      console.error('[spawner]', err);
      workerBroken = true;
    });
    w.on('exit', () => {
      if (worker === w) worker = null;
      if (!stopped) rerunPending();
    });
    worker = w;
  } catch (err) {
    console.error('[spawner]', err);
    workerBroken = true;
  }
  return worker;
}

/** Runs `job` off the main thread; falls back to spawning here if the worker cannot run. */
export function spawnCollect(job: SpawnJob): Promise<SpawnResult> {
  const w = getWorker();
  if (!w) return new Promise((resolve) => collect(job, spawn, resolve));
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, { job, resolve });
    w.ref();
    w.postMessage({ id, job });
  });
}

/** Stops the worker (app shutdown); unfinished jobs resolve empty. */
export function stopSpawner(): void {
  stopped = true;
  const w = worker;
  worker = null;
  for (const { resolve } of pending.values()) resolve({ stdout: '', stderr: '', code: null, timedOut: false });
  pending.clear();
  void w?.terminate();
}
