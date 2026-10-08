/**
 * Terminal output as plain text: escape sequences removed, CRLF normalized, and lines rewritten with a bare
 * carriage return (progress bars) reduced to their final state.
 */
export function stripAnsi(text: string): string {
  const noEscapes = text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC (titles, hyperlinks)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI (colors, cursor movement)
    .replace(/\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMNOZc]/g, '') // charset selection, keypad modes, misc
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  return noEscapes
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.slice(line.lastIndexOf('\r') + 1))
    .join('\n');
}
