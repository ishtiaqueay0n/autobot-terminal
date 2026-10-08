import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';

export interface GhostOptions {
  /** Full command to suggest for the text typed so far (empty text: likely next command), or null. */
  suggest(text: string): Promise<string | null>;
  /** True when matching ignores case (PowerShell). */
  foldCase(): boolean;
}

interface GhostState {
  /** Document text the candidate was computed for (or still agrees with). */
  text: string;
  candidate: string | null;
}

const setGhost = StateEffect.define<GhostState>();

function agrees(candidate: string, text: string, fold: boolean): boolean {
  if (candidate.length <= text.length) return false;
  const head = candidate.slice(0, text.length);
  return fold ? head.toLowerCase() === text.toLowerCase() : head === text;
}

class GhostWidget extends WidgetType {
  constructor(readonly suffix: string) {
    super();
  }
  eq(other: GhostWidget): boolean {
    return other.suffix === this.suffix;
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-ghost';
    span.textContent = this.suffix;
    return span;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

export interface Ghost {
  extension: Extension;
  /** Asks for a new suggestion for the current text (e.g. an empty line at a fresh prompt). */
  refresh(view: EditorView): void;
  /** Accepts the whole ghost text, or with `oneWord` just the next word. False when none is shown. */
  accept(view: EditorView, oneWord: boolean): boolean;
  /** Hides the current ghost text. False when none is shown. */
  dismiss(view: EditorView): boolean;
}

/**
 * Ghost text: the rest of the best history match, drawn after the cursor. Shown only for a single-line
 * command with the cursor at the end, the way fish and PSReadLine do it.
 */
export function ghostText(opts: GhostOptions): Ghost {
  const field = StateField.define<GhostState>({
    create: () => ({ text: '', candidate: null }),
    update(value, tr) {
      for (const e of tr.effects) if (e.is(setGhost)) return e.value;
      if (!tr.docChanged) return value;
      // Keep the current suggestion while it still fits what is typed, so it does not flicker while the
      // next answer is on its way.
      const text = tr.newDoc.toString();
      return value.candidate && agrees(value.candidate, text, opts.foldCase())
        ? { text, candidate: value.candidate }
        : { text, candidate: null };
    },
  });

  const visibleSuffix = (state: EditorState): string | null => {
    const { candidate } = state.field(field);
    if (!candidate) return null;
    const text = state.doc.toString();
    const sel = state.selection.main;
    if (text.includes('\n') || !sel.empty || sel.head !== text.length) return null;
    return agrees(candidate, text, opts.foldCase()) ? candidate.slice(text.length) : null;
  };

  let requestSeq = 0;
  const refresh = (view: EditorView) => {
    const text = view.state.doc.toString();
    const seq = ++requestSeq;
    if (text.includes('\n')) {
      view.dispatch({ effects: setGhost.of({ text, candidate: null }) });
      return;
    }
    void opts.suggest(text).then(
      (candidate) => {
        // Drop answers for text that has changed since, or that a newer request has replaced.
        if (seq !== requestSeq || view.state.doc.toString() !== text) return;
        view.dispatch({ effects: setGhost.of({ text, candidate }) });
      },
      () => {},
    );
  };

  const decorations = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view.state);
      }
      update(u: ViewUpdate) {
        if (u.docChanged) refresh(u.view);
        this.decorations = this.build(u.state);
      }
      build(state: EditorState): DecorationSet {
        const suffix = visibleSuffix(state);
        if (!suffix) return Decoration.none;
        return Decoration.set([
          Decoration.widget({ widget: new GhostWidget(suffix), side: 1 }).range(state.doc.length),
        ]);
      }
    },
    { decorations: (v) => v.decorations },
  );

  const accept = (view: EditorView, oneWord: boolean): boolean => {
    const suffix = visibleSuffix(view.state);
    const { candidate } = view.state.field(field);
    if (!suffix || !candidate) return false;
    const text = view.state.doc.toString();
    const take = oneWord ? (/^\s*\S+/.exec(suffix)?.[0] ?? suffix) : suffix;
    // Rebuild from the candidate's own spelling, so a case-insensitive match adopts the stored case.
    const next = candidate.slice(0, text.length + take.length);
    view.dispatch({ changes: { from: 0, to: text.length, insert: next }, selection: { anchor: next.length } });
    return true;
  };

  const dismiss = (view: EditorView): boolean => {
    if (!visibleSuffix(view.state)) return false;
    view.dispatch({ effects: setGhost.of({ text: view.state.doc.toString(), candidate: null }) });
    return true;
  };

  return { extension: [field, decorations], refresh, accept, dismiss };
}
