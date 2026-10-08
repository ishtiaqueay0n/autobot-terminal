import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AiStatus, ShellProfile } from '@shared/types';
import type { TerminalController } from '../terminal/controller';

export interface TabEntry {
  key: number;
  controller: TerminalController;
}

function TabButton({
  tab,
  active,
  onSelect,
  onClose,
}: {
  tab: TabEntry;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const state = useSyncExternalStore(tab.controller.subscribe, tab.controller.getState);
  const busy = state.mode === 'running';
  return (
    <div
      role="tab"
      aria-selected={active}
      className={`tab${active ? ' active' : ''}`}
      title={state.cwd ?? state.title}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          onClose();
        } else if (e.button === 0) onSelect();
      }}
    >
      <span className={`tab-dot${busy ? ' busy' : ''}${state.mode === 'exited' ? ' dead' : ''}`} />
      <span className="tab-title">{state.title}</span>
      <button
        className="tab-close"
        aria-label="Close tab"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        ×
      </button>
    </div>
  );
}

function NewTabMenu({ profiles, onOpen }: { profiles: ShellProfile[]; onOpen: (profileId: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div className="new-tab" ref={ref}>
      <button className="new-tab-button" title="New tab (Ctrl+Shift+T)" onClick={() => onOpen(null)}>
        +
      </button>
      <button className="new-tab-menu-button" title="Choose shell" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        ▾
      </button>
      {open && (
        <div className="menu" role="menu">
          {profiles.length === 0 && <div className="menu-empty">No shells found</div>}
          {profiles.map((p) => (
            <button
              key={p.id}
              role="menuitem"
              className="menu-item"
              onClick={() => {
                setOpen(false);
                onOpen(p.id);
              }}
            >
              {p.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Opens the AI settings; the dot shows whether AI help works (green), needs setup (amber) or failed (red). */
function AiButton({ status, onClick }: { status: AiStatus | null; onClick: () => void }) {
  const state = !status || status.provider === 'off' ? 'off' : status.lastError ? 'error' : status.ready ? 'ready' : 'setup';
  const titles = {
    off: 'AI help is off: click to set it up',
    setup: 'Set up AI help (Claude API key)',
    ready: `AI help: ${status?.model ?? ''}`,
    error: `AI help: ${status?.lastError ?? ''}`,
  };
  return (
    <button className={`ai-button ai-${state}`} title={titles[state]} onClick={onClick}>
      <span className="ai-dot" aria-hidden="true" />
      AI
    </button>
  );
}

export function TabBar({
  tabs,
  activeKey,
  profiles,
  ai,
  onSelect,
  onClose,
  onOpen,
  onOpenAi,
  onOpenSettings,
}: {
  tabs: TabEntry[];
  activeKey: number | null;
  profiles: ShellProfile[];
  ai: AiStatus | null;
  onSelect: (key: number) => void;
  onClose: (key: number) => void;
  onOpen: (profileId: string | null) => void;
  onOpenAi: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <div className="tabbar" role="tablist">
      <div className="tabs">
        {tabs.map((tab) => (
          <TabButton
            key={tab.key}
            tab={tab}
            active={tab.key === activeKey}
            onSelect={() => onSelect(tab.key)}
            onClose={() => onClose(tab.key)}
          />
        ))}
      </div>
      <NewTabMenu profiles={profiles} onOpen={onOpen} />
      <AiButton status={ai} onClick={onOpenAi} />
      <button className="settings-button" title="Settings" aria-label="Settings" onClick={onOpenSettings}>
        ⚙
      </button>
    </div>
  );
}
