import { linter, type Diagnostic as CmDiagnostic } from '@codemirror/lint';
import type { Extension } from '@codemirror/state';
import type { Diagnostic } from '@shared/types';

export interface CheckOptions {
  query(text: string, cursor: number): Promise<Diagnostic[]>;
  /** Latest result for the current text (for the hint line and Alt+Enter). */
  onResult(diagnostics: Diagnostic[], text: string): void;
}

/**
 * Red and yellow underlines from the main-process checker. Runs shortly after typing stops, and again
 * when the cursor moves (a word counts as finished once the cursor leaves it).
 */
export function checks(opts: CheckOptions): Extension {
  return linter(
    async (view) => {
      const text = view.state.doc.toString();
      if (!text.trim()) {
        opts.onResult([], text);
        return [];
      }
      let diagnostics: Diagnostic[];
      try {
        diagnostics = await opts.query(text, view.state.selection.main.head);
      } catch {
        diagnostics = [];
      }
      if (view.state.doc.toString() !== text) return [];
      opts.onResult(diagnostics, text);
      const len = view.state.doc.length;
      return diagnostics
        .filter((d) => d.from < len)
        .map(
          (d): CmDiagnostic => ({
            from: d.from,
            to: Math.min(Math.max(d.to, d.from + 1), len),
            severity: d.severity,
            message: d.message,
            actions: d.fix
              ? [
                  {
                    name: d.fix.label,
                    apply: (v, from, to) => v.dispatch({ changes: { from, to, insert: d.fix!.insert } }),
                  },
                ]
              : [],
          }),
        );
    },
    { delay: 250, needsRefresh: (u) => u.selectionSet && !u.docChanged },
  );
}
