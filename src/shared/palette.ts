import type { TokenRole } from './highlight';

/** What a piece of command output is (colours for output are chosen by its words and its shape). */
export type OutputRole =
  | 'error'
  | 'warning'
  | 'success'
  | 'info'
  | 'debug'
  | 'number'
  | 'path'
  | 'url'
  | 'ip'
  | 'time'
  | 'id'
  | 'string'
  | 'key'
  | 'option'
  | 'added'
  | 'removed'
  | 'hunk'
  | 'heading';

export type ColorRole = TokenRole | OutputRole;
export type Palette = Record<ColorRole, string>;

/** #RRGGBB colours per role. Command words are coloured by type, everything else by what it looks like. */
export const DARK_PALETTE: Palette = {
  'cmd-read': '#61afef',
  'cmd-change': '#d19a66',
  'cmd-danger': '#e06c75',
  'cmd-priv': '#ff8bb0',
  'cmd-vcs': '#c678dd',
  'cmd-pkg': '#b5bd68',
  'cmd-cloud': '#56b6c2',
  'cmd-net': '#4ec9a8',
  'cmd-sys': '#e2b86b',
  'cmd-shell': '#c0caf5',
  'cmd-other': '#d7dae0',
  keyword: '#bb9af7',
  subcommand: '#7dcfff',
  option: '#e5c07b',
  path: '#98c379',
  url: '#82aaff',
  string: '#ce9178',
  variable: '#c678dd',
  number: '#d19a66',
  operator: '#8f98a8',
  comment: '#5c6370',
  error: '#e06c75',
  warning: '#e5c07b',
  success: '#98c379',
  info: '#61afef',
  debug: '#7d8490',
  ip: '#c678dd',
  time: '#8b93a7',
  id: '#a29bfe',
  key: '#9cdcfe',
  added: '#98c379',
  removed: '#e06c75',
  hunk: '#56b6c2',
  heading: '#7dcfff',
};

export const LIGHT_PALETTE: Palette = {
  'cmd-read': '#0969da',
  'cmd-change': '#b35900',
  'cmd-danger': '#cf222e',
  'cmd-priv': '#bf3989',
  'cmd-vcs': '#8250df',
  'cmd-pkg': '#5f7a00',
  'cmd-cloud': '#1b7c83',
  'cmd-net': '#0f7b5f',
  'cmd-sys': '#8a6100',
  'cmd-shell': '#3b4a7a',
  'cmd-other': '#24292f',
  keyword: '#6639ba',
  subcommand: '#0e7490',
  option: '#8a6100',
  path: '#1a7f37',
  url: '#0550ae',
  string: '#a31515',
  variable: '#8250df',
  number: '#b35900',
  operator: '#57606a',
  comment: '#8c959f',
  error: '#cf222e',
  warning: '#9a6700',
  success: '#1a7f37',
  info: '#0969da',
  debug: '#6e7781',
  ip: '#8250df',
  time: '#6e7781',
  id: '#6f42c1',
  key: '#005cc5',
  added: '#1a7f37',
  removed: '#cf222e',
  hunk: '#1b7c83',
  heading: '#0e7490',
};

export function paletteFor(theme: 'dark' | 'light'): Palette {
  return theme === 'light' ? LIGHT_PALETTE : DARK_PALETTE;
}
