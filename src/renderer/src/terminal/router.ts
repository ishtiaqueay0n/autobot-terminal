import type { SessionEvent } from '@shared/types';

interface SessionHandler {
  events(events: SessionEvent[]): void;
  exit(exitCode: number): void;
}

const handlers = new Map<number, SessionHandler>();
/** Events that arrive before a pane has registered for its session (spawn races the IPC reply). */
const early = new Map<number, { events: SessionEvent[]; exit?: number }>();
let installed = false;

function install(): void {
  if (installed) return;
  installed = true;
  window.autobot.onSessionEvents((id, events) => {
    const handler = handlers.get(id);
    if (handler) handler.events(events);
    else {
      const entry = early.get(id) ?? { events: [] };
      entry.events.push(...events);
      early.set(id, entry);
    }
  });
  window.autobot.onSessionExit((id, exitCode) => {
    const handler = handlers.get(id);
    if (handler) handler.exit(exitCode);
    else early.set(id, { events: early.get(id)?.events ?? [], exit: exitCode });
  });
}

/** Delivers a session's output and exit to one handler. Returns an unsubscribe function. */
export function routeSession(sessionId: number, handler: SessionHandler): () => void {
  install();
  handlers.set(sessionId, handler);
  const pending = early.get(sessionId);
  if (pending) {
    early.delete(sessionId);
    if (pending.events.length) handler.events(pending.events);
    if (pending.exit !== undefined) handler.exit(pending.exit);
  }
  return () => {
    if (handlers.get(sessionId) === handler) handlers.delete(sessionId);
  };
}

// Make sure early events are captured from the start.
install();
