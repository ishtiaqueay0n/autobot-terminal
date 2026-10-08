import { useEffect, useRef } from 'react';
import type { Settings, SshIntegration } from '@shared/types';

const SSH_CHOICES: { id: SshIntegration; label: string; hint: string }[] = [
  { id: 'ask', label: 'Ask each time', hint: 'A question appears in the terminal when you run ssh.' },
  { id: 'on', label: 'Always', hint: 'Every interactive ssh login gets suggestions.' },
  { id: 'off', label: 'Never', hint: 'ssh runs exactly as it does in any other terminal.' },
];

/** The settings that have no better place yet. Changes apply to tabs opened after this. */
export function Preferences({ settings, onClose }: { settings: Settings; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => dialogRef.current?.focus(), []);

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
        aria-labelledby="preferences-title"
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
          <h2 id="preferences-title">Settings</h2>
          <button className="modal-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <fieldset className="field">
          <legend>Suggestions inside ssh sessions</legend>
          <div className="segmented" role="radiogroup">
            {SSH_CHOICES.map((c) => (
              <button
                key={c.id}
                role="radio"
                aria-checked={settings.sshIntegration === c.id}
                className={settings.sshIntegration === c.id ? 'selected' : ''}
                onClick={() => void window.autobot.updateSettings({ sshIntegration: c.id })}
              >
                {c.label}
              </button>
            ))}
          </div>
          <div className="field-note">{SSH_CHOICES.find((c) => c.id === settings.sshIntegration)?.hint}</div>
          <div className="field-note">
            When on, a small helper travels with the login (nothing is installed on the other machine and nothing is
            typed into the session), so the machine you connect to gets suggestions, checks and path completion from its
            own commands and files. Works for bash and zsh logins from bash, zsh and PowerShell tabs; not from Command
            Prompt. Applies to tabs opened after you change it.
          </div>
        </fieldset>

        <fieldset className="field">
          <legend>Colours</legend>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.colorCommands}
              onChange={(e) => void window.autobot.updateSettings({ colorCommands: e.target.checked })}
            />
            Colour commands by type and word: what kind of program it is, options, subcommands, paths, strings, variables
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.colorOutput}
              onChange={(e) => void window.autobot.updateSettings({ colorOutput: e.target.checked })}
            />
            Colour output by its words and shape: errors, warnings, successes, paths, addresses, numbers, diffs
          </label>
          <div className="field-note">
            Only colours are added, never text. Output that a program colours itself, and full-screen programs such as vim
            or less, keep their own colours.
          </div>
        </fieldset>

        <div className="modal-footer">
          <span className="spacer" />
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
