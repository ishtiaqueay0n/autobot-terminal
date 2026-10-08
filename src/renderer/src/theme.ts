import type { ITheme } from '@xterm/xterm';
import { paletteFor } from '@shared/palette';
import type { Settings } from '@shared/types';

const DARK: ITheme = {
  background: '#15171c',
  foreground: '#d7dae0',
  cursor: '#e8e8e8',
  cursorAccent: '#15171c',
  selectionBackground: '#3a4252',
  black: '#1e2127',
  red: '#e06c75',
  green: '#98c379',
  yellow: '#e5c07b',
  blue: '#61afef',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#abb2bf',
  brightBlack: '#5c6370',
  brightRed: '#f08a93',
  brightGreen: '#b5e08f',
  brightYellow: '#f0d39a',
  brightBlue: '#82c2f5',
  brightMagenta: '#d8a0e8',
  brightCyan: '#7fd0da',
  brightWhite: '#e6e9ef',
};

const LIGHT: ITheme = {
  background: '#f7f7f5',
  foreground: '#24292f',
  cursor: '#24292f',
  cursorAccent: '#f7f7f5',
  selectionBackground: '#c8d7f0',
  black: '#24292f',
  red: '#cf222e',
  green: '#1a7f37',
  yellow: '#9a6700',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#116329',
  brightYellow: '#7d4e00',
  brightBlue: '#0550ae',
  brightMagenta: '#6639ba',
  brightCyan: '#136061',
  brightWhite: '#8c959f',
};

export function xtermTheme(theme: Settings['theme']): ITheme {
  return theme === 'light' ? LIGHT : DARK;
}

/** Pushes theme and font settings into CSS variables used by the whole UI. */
export function applyDocumentSettings(settings: Settings): void {
  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  root.style.setProperty('--term-font', settings.fontFamily);
  root.style.setProperty('--term-font-size', `${settings.fontSize}px`);
  // Colours of command words and output, by role (the input editor reads them as var(--c-<role>)).
  for (const [role, hex] of Object.entries(paletteFor(settings.theme))) root.style.setProperty(`--c-${role}`, hex);
}
