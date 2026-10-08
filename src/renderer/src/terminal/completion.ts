import {
  acceptCompletion,
  autocompletion,
  closeCompletion,
  completionStatus,
  moveCompletionSelection,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult as CmResult,
} from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';
import type { EditorView, KeyBinding } from '@codemirror/view';
import type { CompletionItem, CompletionResult } from '@shared/types';

export interface CompletionOptions {
  query(text: string, cursor: number, reason: 'auto' | 'tab'): Promise<CompletionResult | null>;
  /** Shell matching is case-insensitive (PowerShell): common-prefix insertion ignores case. */
  foldCase(): boolean;
}

interface AutobotCompletion extends Completion {
  item: CompletionItem;
}

const KIND_GLYPH: Record<CompletionItem['kind'], string> = {
  command: '›',
  subcommand: '◆',
  option: '–',
  value: '=',
  file: '·',
  folder: '▸',
  variable: '$',
};

function insertItem(view: EditorView, item: CompletionItem, from: number, to: number): void {
  const insert = item.insert + (item.suffix ?? '');
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length },
    userEvent: 'input.complete',
  });
}

function toCompletion(item: CompletionItem, index: number): AutobotCompletion {
  return {
    label: item.label,
    detail: item.detail,
    type: item.kind,
    // Keep the engine's ranking.
    boost: 99 - Math.min(index, 198),
    apply: (view, _c, from, to) => insertItem(view, item, from, to),
    item,
  };
}

/**
 * The suggestion dropdown: opens while typing (the engine decides when there is something useful),
 * Tab accepts, ↑↓ move, Esc closes. Accepting a subcommand, option or folder reopens it for the next word.
 */
export function completion(opts: CompletionOptions): { extension: Extension; keys: KeyBinding[] } {
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const source = async (ctx: CompletionContext): Promise<CmResult | null> => {
    const text = ctx.state.doc.toString();
    const res = await opts.query(text, ctx.pos, ctx.explicit ? 'tab' : 'auto');
    if (res?.retry && ctx.view) {
      // Knowledge for this command was still loading (first use); ask again once it has had time to arrive.
      // One pending retry at a time: each refresh of an open list would restart its interaction timer.
      const view = ctx.view;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        if (view.state.doc.toString() === text && view.hasFocus) startCompletion(view);
      }, 1200);
    }
    if (ctx.aborted || !res?.items.length) return null;
    return { from: res.from, to: res.to, options: res.items.map(toCompletion), filter: false };
  };

  const extension = autocompletion({
    override: [source],
    activateOnTyping: true,
    activateOnTypingDelay: 40,
    activateOnCompletion: (c) => {
      const suffix = (c as AutobotCompletion).item?.suffix;
      return suffix === ' ' || suffix === '' || suffix === '=';
    },
    defaultKeymap: false,
    // Tab accepts what is shown even right after the list refreshed (late knowledge, a retry): by default
    // CodeMirror ignores it for 75 ms, which reads as a dead key.
    interactionDelay: 0,
    closeOnBlur: true,
    aboveCursor: true,
    maxRenderedOptions: 60,
    icons: false,
    optionClass: (c) => ((c as AutobotCompletion).item?.dangerous ? 'cm-ab-dangerous' : ''),
    addToOptions: [
      {
        position: 20,
        render: (c) => {
          const span = document.createElement('span');
          span.className = `cm-ab-kind cm-ab-kind-${(c as AutobotCompletion).item?.kind ?? 'value'}`;
          span.textContent = KIND_GLYPH[(c as AutobotCompletion).item?.kind ?? 'value'];
          return span;
        },
      },
      {
        position: 60,
        render: (c) => {
          const text = (c as AutobotCompletion).item?.description;
          if (!text) return null;
          const span = document.createElement('span');
          span.className = 'cm-ab-description';
          span.textContent = text;
          return span;
        },
      },
    ],
  });

  /** Tab with the dropdown closed: complete in place when there is one answer, else show the list. */
  const tab = (view: EditorView): boolean => {
    const text = view.state.doc.toString();
    const pos = view.state.selection.main.head;
    void opts.query(text, pos, 'tab').then((res) => {
      if (!res?.items.length || view.state.doc.toString() !== text) return;
      if (res.items.length === 1) {
        insertItem(view, res.items[0], res.from, res.to);
        return;
      }
      const typed = text.slice(res.from, res.to);
      const common = commonPrefix(res.items.map((i) => i.insert), opts.foldCase());
      if (common.length > typed.length) {
        view.dispatch({ changes: { from: res.from, to: res.to, insert: common }, selection: { anchor: res.from + common.length } });
      }
      startCompletion(view);
    });
    return true;
  };

  const keys: KeyBinding[] = [
    { key: 'Tab', run: (view) => (completionStatus(view.state) === 'active' ? acceptCompletion(view) : tab(view)) },
    { key: 'ArrowDown', run: moveCompletionSelection(true) },
    { key: 'ArrowUp', run: moveCompletionSelection(false) },
    { key: 'PageDown', run: moveCompletionSelection(true, 'page') },
    { key: 'PageUp', run: moveCompletionSelection(false, 'page') },
    { key: 'Escape', run: closeCompletion },
  ];
  return { extension, keys };
}

export function commonPrefix(values: string[], fold: boolean): string {
  if (!values.length) return '';
  let prefix = values[0];
  for (const v of values.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < v.length && (fold ? prefix[i].toLowerCase() === v[i].toLowerCase() : prefix[i] === v[i])) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}

export { closeCompletion };
