import { RangeSetBuilder, StateEffect, type Extension } from '@codemirror/state';
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view';
import { highlightCommand } from '@shared/highlight';
import type { ShellKind } from '@shared/types';

/** Sent to the editor when the colour settings or the shell changed, so it colours the text again. */
export const recolor = StateEffect.define<null>();

const marks = new Map<string, Decoration>();
function mark(role: string): Decoration {
  let d = marks.get(role);
  if (!d) {
    d = Decoration.mark({ class: `tok tok-${role}` });
    marks.set(role, d);
  }
  return d;
}

/**
 * Colours the command line while it is typed: the command by what kind of program it is, then options,
 * subcommands, paths, strings, variables, numbers, operators and comments (see shared/highlight.ts). The classes
 * take their colours from the palette variables (--c-<role>).
 */
export function commandColors(kind: () => ShellKind, enabled: () => boolean): Extension {
  const build = (view: EditorView): DecorationSet => {
    if (!enabled()) return Decoration.none;
    const text = view.state.doc.toString();
    if (!text) return Decoration.none;
    const builder = new RangeSetBuilder<Decoration>();
    let last = 0;
    for (const t of highlightCommand(text, kind())) {
      if (t.start < last || t.end <= t.start) continue;
      builder.add(t.start, t.end, mark(t.role));
      last = t.end;
    }
    return builder.finish();
  };
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(recolor)))) this.decorations = build(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  );
}
