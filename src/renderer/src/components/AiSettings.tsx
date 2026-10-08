import { useEffect, useRef, useState } from 'react';
import type { AiStatus, LlmProvider, Settings } from '@shared/types';

const CLAUDE_MODELS = [
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (fastest, lowest cost)' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 (smarter)' },
  { id: 'claude-opus-5', label: 'Claude Opus 5 (most capable, highest cost)' },
];

const KEYS_URL = 'https://console.anthropic.com/settings/keys';

const NO_KEY_STORE =
  window.autobot.platform === 'linux'
    ? 'No keyring (Secret Service) was found to keep a key safe. Start GNOME Keyring, KWallet or KeePassXC, or start Autobot from a terminal with ANTHROPIC_API_KEY set.'
    : 'This system has no key store to keep a key safe. Set ANTHROPIC_API_KEY in your environment instead.';

type Note = { kind: 'ok' | 'error' | 'info'; text: string } | null;

function statusLine(status: AiStatus | null): { kind: 'ok' | 'error' | 'info'; text: string } {
  if (!status) return { kind: 'info', text: 'Loading…' };
  if (status.provider === 'off') return { kind: 'info', text: 'AI help is off.' };
  if (status.lastError) return { kind: 'error', text: status.lastError };
  if (status.provider === 'anthropic' && !status.keySource) return { kind: 'info', text: 'Add your Claude API key to turn AI help on.' };
  const where =
    status.provider === 'ollama'
      ? 'local model'
      : status.keySource === 'env'
        ? 'key from ANTHROPIC_API_KEY'
        : 'key stored encrypted by your system';
  return { kind: 'ok', text: `Ready: ${status.model} (${where})` };
}

/**
 * The AI settings dialog: choose Claude or a local Ollama model, enter the API key (it goes straight to
 * the OS key store and is never shown again), pick a model and what the AI may do.
 */
export function AiSettings({
  status,
  settings,
  onStatus,
  onClose,
}: {
  status: AiStatus | null;
  settings: Settings;
  onStatus: (status: AiStatus) => void;
  onClose: () => void;
}) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const [ollamaUrl, setOllamaUrl] = useState(settings.ollamaUrl);
  const [ollamaModel, setOllamaModel] = useState(settings.ollamaModel);
  const keyRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const provider = settings.llmProvider;
  const line = statusLine(status);

  useEffect(() => {
    if (provider === 'anthropic' && status && !status.keySource) keyRef.current?.focus();
    else dialogRef.current?.focus();
    // Only when the dialog opens.
  }, []);

  const refresh = async () => onStatus(await window.autobot.aiStatus());

  const update = async (patch: Partial<Settings>) => {
    await window.autobot.updateSettings(patch);
    await refresh();
  };

  const test = async () => {
    setBusy(true);
    setNote({ kind: 'info', text: 'Testing…' });
    try {
      const res = await window.autobot.aiTest();
      setNote({ kind: res.ok ? 'ok' : 'error', text: res.message });
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const saveKey = async () => {
    if (!key.trim()) return;
    setBusy(true);
    try {
      const res = await window.autobot.aiSetKey(key);
      onStatus(res.status);
      if (!res.ok) {
        setNote({ kind: 'error', text: res.message ?? 'The key could not be saved.' });
        return;
      }
      setKey('');
    } finally {
      setBusy(false);
    }
    await test();
  };

  const removeKey = async () => {
    setBusy(true);
    try {
      const res = await window.autobot.aiSetKey('');
      onStatus(res.status);
      setNote({ kind: 'info', text: 'The stored key was removed.' });
    } finally {
      setBusy(false);
    }
  };

  const chooseProvider = (p: LlmProvider) => {
    setNote(null);
    void update({ llmProvider: p });
  };

  const models = CLAUDE_MODELS.some((m) => m.id === settings.llmModel)
    ? CLAUDE_MODELS
    : [...CLAUDE_MODELS, { id: settings.llmModel, label: settings.llmModel }];

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-settings-title"
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="modal-header">
          <h2 id="ai-settings-title">AI assistant</h2>
          <button className="modal-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className={`ai-status ai-status-${line.kind}`} role="status">
          {line.text}
        </div>

        <fieldset className="field">
          <legend>Provider</legend>
          <div className="segmented" role="radiogroup">
            {(
              [
                ['anthropic', 'Claude'],
                ['ollama', 'Ollama (local)'],
                ['off', 'Off'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                role="radio"
                aria-checked={provider === id}
                className={provider === id ? 'selected' : ''}
                onClick={() => chooseProvider(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>

        {provider === 'anthropic' && (
          <>
            <div className="field">
              <label htmlFor="ai-key">API key</label>
              {status?.keySource === 'keychain' && (
                <div className="field-note">
                  A key is saved (encrypted by your system).{' '}
                  <button className="link-button" disabled={busy} onClick={() => void removeKey()}>
                    Remove it
                  </button>
                </div>
              )}
              {status?.keySource === 'env' && <div className="field-note">Using ANTHROPIC_API_KEY from your environment.</div>}
              {status && !status.canStoreKey && (
                <div className="field-note field-warn">{NO_KEY_STORE}</div>
              )}
              <div className="field-row">
                <input
                  id="ai-key"
                  ref={keyRef}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={status?.keySource ? 'Paste a new key to replace it' : 'sk-ant-…'}
                  value={key}
                  disabled={busy || (status !== null && !status.canStoreKey)}
                  onChange={(e) => setKey(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveKey();
                  }}
                />
                <button className="primary" disabled={busy || !key.trim()} onClick={() => void saveKey()}>
                  Save
                </button>
              </div>
              <div className="field-note">
                Get a key from the{' '}
                <a
                  href={KEYS_URL}
                  onClick={(e) => {
                    e.preventDefault();
                    window.autobot.openExternal(KEYS_URL);
                  }}
                >
                  Claude Console
                </a>
                . Requests are billed to that account.
              </div>
            </div>

            <div className="field">
              <label htmlFor="ai-model">Model</label>
              <select id="ai-model" value={settings.llmModel} onChange={(e) => void update({ llmModel: e.target.value })}>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}

        {provider === 'ollama' && (
          <div className="field">
            <label htmlFor="ai-ollama-url">Ollama server</label>
            <input
              id="ai-ollama-url"
              value={ollamaUrl}
              spellCheck={false}
              onChange={(e) => setOllamaUrl(e.target.value)}
              onBlur={() => void update({ ollamaUrl })}
            />
            <label htmlFor="ai-ollama-model">Model</label>
            <input
              id="ai-ollama-model"
              value={ollamaModel}
              spellCheck={false}
              placeholder="llama3.1"
              onChange={(e) => setOllamaModel(e.target.value)}
              onBlur={() => void update({ ollamaModel })}
            />
            <div className="field-note">Runs on your machine; nothing leaves it. No web search.</div>
          </div>
        )}

        {provider !== 'off' && (
          <fieldset className="field">
            <legend>What the AI may do</legend>
            <label className="check">
              <input type="checkbox" checked disabled /> Suggest a fix for the last failed command when you press <kbd>Ctrl+.</kbd>
            </label>
            <label className="check">
              <input type="checkbox" checked={settings.llmLearn} onChange={(e) => void update({ llmLearn: e.target.checked })} />
              Describe the tools you use, in the background
            </label>
            <label className="check check-sub">
              At most
              <input
                className="inline-number"
                type="number"
                min={0}
                max={1000}
                value={settings.llmDailyLimit}
                disabled={!settings.llmLearn}
                onChange={(e) => void update({ llmDailyLimit: Number(e.target.value) })}
              />
              background requests a day
            </label>
            {provider === 'anthropic' && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={settings.llmWebSearch}
                  disabled={!settings.llmLearn}
                  onChange={(e) => void update({ llmWebSearch: e.target.checked })}
                />
                Search the web for tools that have no local help (billed per search)
              </label>
            )}
            <label className="check">
              <input type="checkbox" checked={settings.llmPanel} onChange={(e) => void update({ llmPanel: e.target.checked })} />
              Add AI notes to the Ctrl+Space panel
            </label>
          </fieldset>
        )}

        <div className="field-note privacy">
          Sent only when used: tool and option names; for Ctrl+., the failed command and its last 50 output lines with
          passwords, tokens and keys masked and your home folder shown as ~. Commands are never run by the AI.
        </div>

        <div className="modal-footer">
          {note && <span className={`ai-note ai-status-${note.kind}`}>{note.text}</span>}
          <span className="spacer" />
          {provider !== 'off' && (
            <button disabled={busy || !status?.ready} onClick={() => void test()}>
              Test
            </button>
          )}
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
