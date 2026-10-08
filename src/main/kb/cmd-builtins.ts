import type { KbArg, KbOption, KbSpec } from '../../shared/kb-types';

/**
 * The commands built into cmd.exe. They are not programs, so there is no --help to read and no bundled spec; this
 * is what `help` and `<command> /?` print, condensed. Options are lower case (cmd matches without regard to case).
 */

const file: KbArg = { name: 'file', templates: ['filepaths'], variadic: true };
const folder: KbArg = { name: 'folder', templates: ['folders'] };
const flag = (name: string, description: string, extra: Partial<KbOption> = {}): KbOption => ({ names: [name], description, verified: true, ...extra });
const withValue = (name: string, description: string, argName: string, suggestions?: string[]): KbOption =>
  flag(name, description, { separator: ':', args: [{ name: argName, optional: true, ...(suggestions ? { suggestions: suggestions.map((s) => ({ name: s })) } : {}) }] });

const SPECS: KbSpec[] = [
  {
    names: ['dir'],
    description: 'List the files and folders in a folder',
    args: [{ ...file, optional: true }],
    options: [
      withValue('/a', 'Only items with these attributes (d folders, h hidden, r read-only, s system, a archive)', 'attributes'),
      flag('/b', 'Bare format: names only'),
      flag('/c', 'Show thousands separators in sizes'),
      flag('/d', 'Sort the wide list by column'),
      flag('/l', 'Lower-case names'),
      flag('/n', 'Long list format with names at the right'),
      withValue('/o', 'Sort order (n name, e extension, s size, d date, g folders first; - reverses)', 'order'),
      flag('/p', 'Pause after each screen'),
      flag('/q', 'Show the owner of each file'),
      flag('/r', 'Show alternate data streams'),
      flag('/s', 'Include subfolders'),
      withValue('/t', 'Which time to show (c created, a accessed, w written)', 'time', ['c', 'a', 'w']),
      flag('/w', 'Wide list format'),
      flag('/x', 'Show short (8.3) names'),
      flag('/4', 'Four-digit years'),
    ],
  },
  { names: ['cd', 'chdir'], description: 'Show or change the current folder', args: [{ ...folder, optional: true }], options: [flag('/d', 'Also change the current drive')] },
  { names: ['pushd'], description: 'Remember the current folder, then change to another', args: [{ ...folder, optional: true }] },
  { names: ['popd'], description: 'Return to the folder remembered by pushd' },
  { names: ['md', 'mkdir'], description: 'Create a folder (and any missing parent folders)', args: [{ ...folder, variadic: true }] },
  {
    names: ['rd', 'rmdir'],
    description: 'Remove a folder',
    args: [{ ...folder, variadic: true }],
    options: [flag('/s', 'Also remove everything inside it', { dangerous: true }), flag('/q', 'Do not ask for confirmation', { dangerous: true })],
  },
  {
    names: ['del', 'erase'],
    description: 'Delete files',
    args: [file],
    options: [
      flag('/p', 'Ask before deleting each file'),
      flag('/f', 'Also delete read-only files', { dangerous: true }),
      flag('/s', 'Delete matching files in subfolders too', { dangerous: true }),
      flag('/q', 'Quiet: do not ask for confirmation', { dangerous: true }),
      withValue('/a', 'Only files with these attributes (r, a, s, h, i; - negates)', 'attributes'),
    ],
  },
  {
    names: ['copy'],
    description: 'Copy files',
    args: [{ name: 'source', templates: ['filepaths'] }, { name: 'destination', templates: ['filepaths'], optional: true }],
    options: [
      flag('/a', 'Treat the file as ASCII text'),
      flag('/b', 'Treat the file as binary'),
      flag('/d', 'Allow the copy to be decrypted'),
      flag('/v', 'Verify that the copy is correct'),
      flag('/n', 'Use short names'),
      flag('/y', 'Overwrite without asking'),
      flag('/-y', 'Ask before overwriting'),
      flag('/z', 'Restartable network copy'),
      flag('/l', 'Copy symbolic links themselves'),
    ],
  },
  {
    names: ['move'],
    description: 'Move or rename files and folders',
    args: [{ name: 'source', templates: ['filepaths'] }, { name: 'destination', templates: ['filepaths'] }],
    options: [flag('/y', 'Overwrite without asking'), flag('/-y', 'Ask before overwriting')],
  },
  { names: ['ren', 'rename'], description: 'Rename a file or folder', args: [{ name: 'name', templates: ['filepaths'] }, { name: 'new name' }] },
  { names: ['type'], description: 'Print the contents of text files', args: [file] },
  { names: ['echo'], description: 'Print text, or turn command echoing on or off', args: [{ name: 'text', optional: true, variadic: true, suggestions: [{ name: 'on' }, { name: 'off' }, { name: '.' }] }] },
  { names: ['cls'], description: 'Clear the screen' },
  { names: ['ver'], description: 'Show the Windows version' },
  { names: ['vol'], description: 'Show a drive’s label and serial number', args: [{ name: 'drive', optional: true }] },
  { names: ['date'], description: 'Show or set the date', options: [flag('/t', 'Only show the date')] },
  { names: ['time'], description: 'Show or set the time', options: [flag('/t', 'Only show the time')] },
  { names: ['title'], description: 'Set the window title', args: [{ name: 'title', variadic: true }] },
  { names: ['color'], description: 'Set the console colors (two hex digits: background, text)', args: [{ name: 'colors', optional: true }] },
  { names: ['path'], description: 'Show or set the program search path', args: [{ name: 'path', optional: true }] },
  { names: ['prompt'], description: 'Change the command prompt text', args: [{ name: 'text', optional: true }] },
  {
    names: ['set'],
    description: 'Show, set or remove environment variables',
    args: [{ name: 'name=value', optional: true }],
    options: [flag('/a', 'Evaluate an arithmetic expression'), flag('/p', 'Prompt for a value to store')],
  },
  { names: ['setlocal'], description: 'Start a scope for environment changes in a batch file', args: [{ name: 'option', optional: true, suggestions: [{ name: 'enableextensions' }, { name: 'enabledelayedexpansion' }] }] },
  { names: ['endlocal'], description: 'End a setlocal scope and discard its changes' },
  {
    names: ['start'],
    description: 'Start a program or open a document in a new window',
    args: [{ name: 'program', templates: ['filepaths'], optional: true }],
    options: [
      flag('/b', 'Start without a new window'),
      flag('/wait', 'Wait for the program to finish'),
      flag('/min', 'Start minimized'),
      flag('/max', 'Start maximized'),
      flag('/i', 'Use the original environment'),
      flag('/d', 'Start in this folder', { args: [{ name: 'folder', templates: ['folders'] }] }),
      flag('/low', 'Low priority'),
      flag('/high', 'High priority'),
      flag('/realtime', 'Real-time priority'),
      flag('/node', 'NUMA node'),
      flag('/affinity', 'Processor affinity mask'),
    ],
  },
  { names: ['call'], description: 'Run a batch file or label from another one', args: [{ name: 'batch file', templates: ['filepaths'] }], options: [] },
  { names: ['exit'], description: 'Close this command prompt', options: [flag('/b', 'Leave a batch file only, with an exit code')] },
  { names: ['assoc'], description: 'Show or change file extension associations', args: [{ name: 'extension', optional: true }] },
  { names: ['ftype'], description: 'Show or change the commands that open file types', args: [{ name: 'file type', optional: true }] },
  {
    names: ['mklink'],
    description: 'Create a symbolic link, hard link or junction',
    args: [{ name: 'link' }, { name: 'target', templates: ['filepaths'] }],
    options: [flag('/d', 'Directory symbolic link'), flag('/h', 'Hard link'), flag('/j', 'Directory junction')],
  },
  { names: ['pause'], description: 'Wait for a key press' },
  { names: ['verify'], description: 'Turn verification of file writes on or off', args: [{ name: 'on|off', optional: true, suggestions: [{ name: 'on' }, { name: 'off' }] }] },
  {
    names: ['for'],
    description: 'Run a command for each item in a set',
    options: [flag('/d', 'Loop over folders'), flag('/r', 'Loop over a folder tree'), flag('/l', 'Loop over a number range'), flag('/f', 'Loop over the lines of a file or command')],
  },
  { names: ['if'], description: 'Run a command only if a condition is true (exist, defined, errorlevel, comparisons)', options: [flag('/i', 'Compare text without regard to case')] },
  { names: ['goto'], description: 'Jump to a label in a batch file', args: [{ name: 'label' }] },
  { names: ['rem'], description: 'A comment; the rest of the line is ignored' },
  { names: ['shift'], description: 'Shift the arguments of a batch file' },
  { names: ['help'], description: 'Show help for a command', args: [{ name: 'command', optional: true }] },
];

/** Commands whose option lists above are not complete: unknown options get a yellow mark, never a red one. */
const INCOMPLETE = new Set(['start', 'for', 'if', 'set']);

const BY_NAME = new Map<string, KbSpec>();
for (const spec of SPECS) {
  const sure = !INCOMPLETE.has(spec.names[0]);
  const entry: KbSpec = { ...spec, verified: sure, options: spec.options?.map((o) => ({ ...o, verified: sure })) };
  for (const name of spec.names) BY_NAME.set(name, entry);
}

/** The built-in cmd.exe command with this name (any case), or null. */
export function cmdBuiltin(name: string): KbSpec | null {
  return BY_NAME.get(name.toLowerCase()) ?? null;
}

/** Every built-in command name, for completion and the unknown-command check. */
export const CMD_BUILTIN_NAMES: string[] = [...BY_NAME.keys()];
