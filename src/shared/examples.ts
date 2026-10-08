/**
 * Turns a tldr example command into editor text: `{{placeholder}}` markers are removed (the text stays so
 * the user can see what goes there) and the first placeholder's range is returned for selection.
 * tldr's option alternatives `{{[-r|--recursive]}}` become the first alternative.
 */
export function fillExample(command: string): { text: string; select: [number, number] | null } {
  let text = '';
  let select: [number, number] | null = null;
  let last = 0;
  for (const m of command.matchAll(/\{\{(.*?)\}\}/g)) {
    text += command.slice(last, m.index);
    let inner = m[1];
    const alt = /^\[([^|\]]+)\|[^\]]*\]$/.exec(inner);
    if (alt) inner = alt[1];
    // Option alternatives are a choice, not something to type over.
    if (!select && !alt) select = [text.length, text.length + inner.length];
    text += inner;
    last = m.index! + m[0].length;
  }
  text += command.slice(last);
  return { text, select };
}
