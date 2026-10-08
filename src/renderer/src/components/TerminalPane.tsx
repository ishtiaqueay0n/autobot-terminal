import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { PaneState, TerminalController } from '../terminal/controller';
import { SuggestionPanel } from './SuggestionPanel';

function BranchIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        fill="currentColor"
        d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 2.122a2.25 2.25 0 1 0-1.5 0v5.256a2.25 2.25 0 1 0 1.5 0V9.25c.53.27 1.13.42 1.75.42h2.5a2.25 2.25 0 0 0 2.24-2.03 2.25 2.25 0 1 0-1.53-.07A.75.75 0 0 1 9.25 8.2h-2.5A1.75 1.75 0 0 1 5 6.45V5.372ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm7.5-6a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"
      />
    </svg>
  );
}

function PromptBar({ state }: { state: PaneState }) {
  const failed = state.lastExitCode !== null && state.lastExitCode !== 0;
  return (
    <div className="prompt-bar">
      {state.remote && (
        <span className="host" title="This tab is connected over ssh. Suggestions come from the other machine.">
          {state.remote.host}
        </span>
      )}
      <span className="cwd" title={state.cwd ?? undefined}>
        {state.displayCwd || state.profile?.name || '…'}
      </span>
      {state.gitBranch && (
        <span className="branch" title="git branch">
          <BranchIcon />
          {state.gitBranch}
        </span>
      )}
      {failed && <span className="exit-code">exit {state.lastExitCode}</span>}
      {failed && state.aiReady && state.mode === 'prompt' && !state.fix && !state.aiRequest && (
        <span className="ai-hint">Ctrl+. ask AI</span>
      )}
      <span className="spacer" />
      <span className="shell-label">{state.shellLabel ?? state.profile?.name ?? ''}</span>
    </div>
  );
}

function StatusLine({ state }: { state: PaneState }) {
  if (state.mode === 'running') {
    return (
      <div className="status-line">
        <span className="pulse" aria-hidden="true" />
        <span className="status-command">{state.runningCommand.split('\n')[0] || 'running'}</span>
        <span className="status-hint">Ctrl+C to interrupt</span>
      </div>
    );
  }
  if (state.mode === 'starting') {
    return <div className="status-line status-hint">starting {state.profile?.name ?? 'shell'}…</div>;
  }
  if (state.mode === 'exited') {
    return (
      <div className="status-line status-hint">
        {state.error ? `error: ${state.error}` : `process exited with code ${state.processExitCode}`} · press Enter in the
        terminal to restart
      </div>
    );
  }
  return null;
}

export function TerminalPane({ controller, active }: { controller: TerminalController; active: boolean }) {
  const termRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const state = useSyncExternalStore(controller.subscribe, controller.getState);

  useEffect(() => {
    if (termRef.current && editorRef.current) controller.mount(termRef.current, editorRef.current);
  }, [controller]);

  useEffect(() => {
    controller.setActive(active);
  }, [controller, active]);

  // Runs after the editor or status line for the new mode is on screen, so focus can land.
  useEffect(() => {
    if (active) controller.focus();
  }, [controller, active, state.mode]);

  const failed = state.lastExitCode !== null && state.lastExitCode !== 0;
  const atPrompt = state.mode === 'prompt';

  return (
    <div className="pane" style={{ display: active ? 'flex' : 'none' }}>
      <div className="term-host" ref={termRef} />
      <div className={`input-area mode-${state.mode}`}>
        <SuggestionPanel panel={state.panel} onPick={(i) => controller.pickPanel(i)} />
        {atPrompt && state.danger && (
          <div className="banner banner-danger" role="alert">
            <span className="banner-icon" aria-hidden="true">⚠</span>
            <span className="banner-text">{state.danger.reason}</span>
            <span className="banner-keys">Enter again to run · Esc to cancel</span>
          </div>
        )}
        {atPrompt && !state.danger && state.aiRequest && (
          <div className={`banner banner-ai${state.aiRequest.state === 'error' ? ' banner-ai-error' : ''}`} role="status">
            <span className="banner-icon" aria-hidden="true">
              {state.aiRequest.state === 'pending' ? '…' : '!'}
            </span>
            <span className="banner-text">
              {state.aiRequest.state === 'pending' ? 'Asking the AI about the failed command…' : state.aiRequest.message}
            </span>
            <span className="banner-keys">Esc to {state.aiRequest.state === 'pending' ? 'cancel' : 'dismiss'}</span>
          </div>
        )}
        {atPrompt && !state.danger && !state.aiRequest && state.fix && (
          <div className="banner banner-fix" role="status">
            <span className="banner-icon" aria-hidden="true">↳</span>
            <span className="banner-text">
              {state.fix.source === 'ai' && <span className="banner-badge">AI</span>}
              {state.fix.title}
              {state.fix.detail && <span className="banner-detail"> {state.fix.detail}</span>}
              {state.fix.command && <code className="banner-command">{state.fix.command}</code>}
            </span>
            {state.fix.command && (
              <button className="banner-button" onMouseDown={(e) => e.preventDefault()} onClick={() => controller.useFix()}>
                Use
              </button>
            )}
            <span className="banner-keys">
              {state.fix.command ? '→ to use · ' : ''}
              {state.aiReady && state.fix.source !== 'ai' ? 'Ctrl+. ask AI · ' : ''}Esc to dismiss
            </span>
          </div>
        )}
        <PromptBar state={state} />
        <div className="input-row">
          <span className={`chevron${failed ? ' fail' : ''}`} aria-hidden="true">
            ❯
          </span>
          <div className="input-editor" ref={editorRef} style={{ display: atPrompt ? 'block' : 'none' }} />
          {!atPrompt && <StatusLine state={state} />}
        </div>
        {atPrompt && state.hint && (
          <div className={`hint hint-${state.hint.severity}`} role="status">
            <span aria-hidden="true">{state.hint.severity === 'error' ? '✗' : '!'}</span>
            <span className="hint-text">{state.hint.message}</span>
            {state.hint.fixLabel && <span className="hint-keys">Alt+Enter: {state.hint.fixLabel}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
