import { useEffect, useRef } from 'react';
import type { PanelEntry, PanelState } from '../terminal/controller';

const SECTION_TITLES: Record<PanelEntry['section'], string> = {
  suggestions: 'Suggestions',
  examples: 'Examples',
  history: 'Your history',
  ai: 'AI notes',
};

const SOURCE_LABELS: Record<string, string> = {
  bundled: 'bundled knowledge',
  learned: 'learned from this machine',
  'bundled+learned': 'verified on this machine',
  powershell: 'PowerShell metadata',
  ai: 'described by AI (unverified)',
};

/** The AI section's summary or status line. */
function AiNote({ ai }: { ai: NonNullable<PanelState['ai']> }) {
  if (ai.summary) return <div className="panel-ai-summary">{ai.summary}</div>;
  if (ai.loading) return <div className="panel-ai-status">Asking the AI…</div>;
  return ai.message ? <div className="panel-ai-status">{ai.message}</div> : null;
}

/** The Ctrl+Space panel: everything known about the command being typed. */
export function SuggestionPanel({ panel, onPick }: { panel: PanelState; onPick: (index: number) => void }) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.querySelector('.panel-entry.selected')?.scrollIntoView({ block: 'nearest' });
  }, [panel.selected, panel.entries]);

  if (!panel.open) return null;
  let lastSection: PanelEntry['section'] | null = null;
  const hasAiEntries = panel.entries.some((e) => e.section === 'ai');
  const title = (section: PanelEntry['section']) =>
    section === 'examples' && panel.examplesFromAi ? 'Examples · written by AI' : SECTION_TITLES[section];

  return (
    <div className="panel" role="dialog" aria-label="Suggestions">
      <div className="panel-header">
        {panel.tool ? (
          <>
            <span className="panel-tool">{panel.tool.name}</span>
            {panel.tool.source && <span className="panel-badge">{SOURCE_LABELS[panel.tool.source] ?? panel.tool.source}</span>}
            {panel.tool.description && <span className="panel-tool-desc">{panel.tool.description}</span>}
          </>
        ) : (
          <span className="panel-tool">{panel.loading ? 'Looking up…' : 'Suggestions'}</span>
        )}
        <span className="spacer" />
        <span className="panel-hint">↑↓ choose · Tab/Enter insert · Esc close</span>
      </div>
      <div className="panel-body" ref={listRef} role="listbox">
        {panel.entries.length === 0 && !panel.loading && !panel.ai && <div className="panel-empty">Nothing known here yet.</div>}
        {panel.entries.map((entry, i) => {
          const heading = entry.section !== lastSection ? title(entry.section) : null;
          lastSection = entry.section;
          return (
            <div key={`${entry.section}:${i}`}>
              {heading && <div className="panel-section">{heading}</div>}
              {heading && entry.section === 'ai' && panel.ai && <AiNote ai={panel.ai} />}
              <div
                role="option"
                aria-selected={i === panel.selected}
                className={`panel-entry${i === panel.selected ? ' selected' : ''}${entry.dangerous ? ' dangerous' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(i);
                }}
              >
                <span className="panel-label">{entry.label}</span>
                {entry.detail && <span className="panel-detail">{entry.detail}</span>}
                {entry.description && <span className="panel-desc">{entry.description}</span>}
              </div>
            </div>
          );
        })}
        {panel.ai && !hasAiEntries && (
          <>
            <div className="panel-section">{SECTION_TITLES.ai}</div>
            <AiNote ai={panel.ai} />
          </>
        )}
      </div>
    </div>
  );
}
