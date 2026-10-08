import { defaultKeymap, history, historyKeymap, insertNewline } from '@codemirror/commands';
import { EditorState, Prec } from '@codemirror/state';
import { drawSelection, EditorView, highlightSpecialChars, keymap, type KeyBinding } from '@codemirror/view';
import { closeCompletion } from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';
import type { Ghost } from './ghost';

export interface InputEditorCallbacks {
  onSubmit(text: string): void;
  isIncomplete(text: string): boolean;
  /** Older history entry, or null when there is none. Receives the current text to keep as a draft. */
  historyPrev(current: string): string | null;
  /** Newer history entry (the draft after the newest), or null when not browsing history. */
  historyNext(): string | null;
  /** Ctrl+C with nothing selected in the editor. */
  onCtrlC(): void;
  onClearScreen(): void;
  /** Ctrl+Space: open or close the full suggestion panel. */
  onTogglePanel(): void;
  /** Keys for the panel while it is open; returns false when the panel is closed. */
  panelKey(key: 'up' | 'down' | 'pageup' | 'pagedown' | 'accept' | 'close'): boolean;
  /** The text changed (typing, completion, history recall). */
  onDocChange(): void;
  /** Esc with no dropdown or panel open: cancel a pending danger confirmation or hide a fix. */
  onEscape(): boolean;
  /** Alt+Enter: apply the fix for the most important problem in the line. */
  onQuickFix(): boolean;
  /** Ctrl+.: ask the AI to fix the last failed command. */
  onAskAi(): boolean;
}

export interface Dropdown {
  extension: Extension;
  keys: KeyBinding[];
}

const inputTheme = EditorView.theme({
  '&': {
    color: 'var(--fg)',
    backgroundColor: 'transparent',
    fontFamily: 'var(--term-font)',
    fontSize: 'var(--term-font-size)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.4' },
  '.cm-content': { padding: '0', caretColor: 'var(--caret)' },
  '.cm-line': { padding: '0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--caret)', borderLeftWidth: '2px' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--selection)' },
  '.cm-ghost': { color: 'var(--ghost)' },
});

export function setEditorText(view: EditorView, text: string): void {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: text.length },
    scrollIntoView: true,
  });
}

export function createInputEditor(
  parent: HTMLElement,
  cb: InputEditorCallbacks,
  ghost: Ghost,
  dropdown: Dropdown,
  extra: Extension[] = [],
): EditorView {
  // Precedence, highest first: the Ctrl+Space panel, the dropdown, then ghost text / history / editing.
  const panelKeys = Prec.highest(
    keymap.of([
      { key: 'Ctrl-Space', run: () => (cb.onTogglePanel(), true) },
      { key: 'ArrowUp', run: () => cb.panelKey('up') },
      { key: 'ArrowDown', run: () => cb.panelKey('down') },
      { key: 'PageUp', run: () => cb.panelKey('pageup') },
      { key: 'PageDown', run: () => cb.panelKey('pagedown') },
      { key: 'Tab', run: () => cb.panelKey('accept') },
      { key: 'Enter', run: () => cb.panelKey('accept') },
      { key: 'Escape', run: () => cb.panelKey('close') },
    ]),
  );
  const dropdownKeys = Prec.highest(keymap.of(dropdown.keys));
  const shellKeys = Prec.highest(
    keymap.of([
      // Ghost text: → or End takes all of it, Ctrl+→ one word, Esc hides it. Without ghost text these
      // fall through to normal cursor movement.
      { key: 'ArrowRight', run: (view) => ghost.accept(view, false) },
      { key: 'End', run: (view) => ghost.accept(view, false) },
      { key: 'Ctrl-ArrowRight', run: (view) => ghost.accept(view, true) },
      { key: 'Escape', run: (view) => cb.onEscape() || ghost.dismiss(view) },
      { key: 'Alt-Enter', run: () => cb.onQuickFix() },
      { key: 'Ctrl-.', run: () => cb.onAskAi() },
      {
        key: 'Enter',
        run: (view) => {
          const text = view.state.doc.toString();
          // Enter runs the command; it never accepts a dropdown item (Tab does).
          closeCompletion(view);
          if (cb.isIncomplete(text)) return insertNewline(view);
          cb.onSubmit(text);
          return true;
        },
      },
      { key: 'Shift-Enter', run: insertNewline },
      {
        key: 'ArrowUp',
        run: (view) => {
          if (view.state.doc.lineAt(view.state.selection.main.head).number !== 1) return false;
          const text = cb.historyPrev(view.state.doc.toString());
          if (text !== null) setEditorText(view, text);
          return true;
        },
      },
      {
        key: 'ArrowDown',
        run: (view) => {
          const { doc, selection } = view.state;
          if (doc.lineAt(selection.main.head).number !== doc.lines) return false;
          const text = cb.historyNext();
          if (text !== null) setEditorText(view, text);
          return true;
        },
      },
      {
        key: 'Ctrl-c',
        // With a selection, let the browser copy it; otherwise cancel the line.
        run: (view) => {
          if (!view.state.selection.main.empty) return false;
          cb.onCtrlC();
          return true;
        },
      },
      {
        key: 'Ctrl-l',
        run: () => {
          cb.onClearScreen();
          return true;
        },
      },
      // Never let Tab move focus out of the editor (the dropdown keymap handles Tab itself).
      { key: 'Tab', run: () => true },
      { key: 'Shift-Tab', run: () => true },
    ]),
  );

  return new EditorView({
    parent,
    state: EditorState.create({
      doc: '',
      extensions: [
        ghost.extension,
        dropdown.extension,
        history(),
        drawSelection(),
        highlightSpecialChars(),
        EditorView.lineWrapping,
        panelKeys,
        dropdownKeys,
        shellKeys,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) cb.onDocChange();
        }),
        ...extra,
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.contentAttributes.of({
          spellcheck: 'false',
          autocorrect: 'off',
          autocapitalize: 'off',
          'aria-label': 'Command input',
        }),
        inputTheme,
      ],
    }),
  });
}
