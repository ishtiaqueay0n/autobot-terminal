/**
 * Opt-in diagnostics for troubleshooting: set AUTOBOT_DEBUG=1 and read stderr.
 * Times are milliseconds since the main process started.
 */
const enabled = process.env.AUTOBOT_DEBUG === '1';

export function debugLog(message: string): void {
  if (enabled) process.stderr.write(`[autobot ${Math.round(process.uptime() * 1000)}ms] ${message}\n`);
}

/** Runs `fn` and logs how long it took when that is long enough to be felt (debug mode only). */
export function timed<T>(label: string, fn: () => T, thresholdMs = 20): T {
  if (!enabled) return fn();
  const start = performance.now();
  try {
    return fn();
  } finally {
    const ms = performance.now() - start;
    if (ms >= thresholdMs) debugLog(`slow: ${label} took ${Math.round(ms)} ms`);
  }
}

/** Like `timed`, for promises. */
export async function timedAsync<T>(label: string, fn: () => Promise<T>, thresholdMs = 20): Promise<T> {
  if (!enabled) return fn();
  const start = performance.now();
  try {
    return await fn();
  } finally {
    const ms = performance.now() - start;
    if (ms >= thresholdMs) debugLog(`slow: ${label} took ${Math.round(ms)} ms`);
  }
}

/** Logs whenever the main process event loop was blocked for a noticeable time (debug mode only). */
export function startLagMonitor(): void {
  if (!enabled) return;
  const tick = 50;
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    const lag = now - last - tick;
    if (lag > 100) debugLog(`event loop blocked for ~${Math.round(lag)} ms`);
    last = now;
  }, tick).unref();
}
