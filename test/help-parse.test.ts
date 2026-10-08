import { describe, expect, it } from 'vitest';
import { parseHelp } from '../src/shared/help-parse';
import type { KbOption, KbSpec } from '../src/shared/kb-types';

const opt = (spec: KbSpec, name: string): KbOption | undefined => spec.options?.find((o) => o.names.includes(name));
const subs = (spec: KbSpec) => spec.subcommands?.map((s) => s.names[0]) ?? [];

describe('parseHelp', () => {
  it('reads GNU-style help (ls)', () => {
    const spec = parseHelp(
      'ls',
      `Usage: ls [OPTION]... [FILE]...
List information about the FILEs (the current directory by default).
Sort entries alphabetically if none of -cftuvSUX nor --sort is specified.

Mandatory arguments to long options are mandatory for short options too.
  -a, --all                  do not ignore entries starting with .
  -A, --almost-all           do not list implied . and ..
      --block-size=SIZE      with -l, scale sizes by SIZE when printing them;
                             e.g., '--block-size=M'; see SIZE format below
  -l                         use a long listing format
      --color[=WHEN]         color the output WHEN; more info below
  -h, --human-readable       with -l and -s, print sizes like 1K 234M 2G etc.
      --help     display this help and exit
`,
    );
    expect(spec.description).toBe('List information about the FILEs (the current directory by default).');
    expect(opt(spec, '--all')).toMatchObject({ names: ['-a', '--all'], description: 'do not ignore entries starting with .' });
    expect(opt(spec, '--all')?.args).toBeUndefined();
    expect(opt(spec, '--block-size')?.args).toEqual([{ name: 'size' }]);
    expect(opt(spec, '--block-size')?.description).toContain("e.g., '--block-size=M'");
    expect(opt(spec, '--color')?.args?.[0]).toMatchObject({ name: 'when', optional: true });
    expect(opt(spec, '-l')?.args).toBeUndefined();
    expect(subs(spec)).toEqual([]);
  });

  it('reads cobra help with type words (docker ps)', () => {
    const spec = parseHelp(
      'docker',
      `
Usage:  docker ps [OPTIONS]

List containers

Aliases:
  docker container ls, docker container list, docker container ps, docker ps

Options:
  -a, --all             Show all containers (default shows just running)
  -f, --filter filter   Filter output based on conditions provided
      --format string   Format output using a custom template:
                        'table':            Print output in table format with column headers (default)
  -n, --last int        Show n last created containers (includes all states) (default -1)
  -q, --quiet           Only display container IDs
`,
    );
    expect(spec.description).toBe('List containers');
    expect(opt(spec, '--all')?.args).toBeUndefined();
    expect(opt(spec, '--filter')?.args).toEqual([{ name: 'filter' }]);
    expect(opt(spec, '--format')?.args).toEqual([{ name: 'string' }]);
    expect(opt(spec, '--last')?.args).toEqual([{ name: 'int' }]);
    expect(subs(spec)).toEqual([]);
  });

  it('reads cobra command groups and kubectl flag blocks', () => {
    const top = parseHelp(
      'kubectl',
      `kubectl controls the Kubernetes cluster manager.

 Find more information at: https://kubernetes.io/docs/reference/kubectl/

Basic Commands (Beginner):
  create          Create a resource from a file or from stdin
  expose          Take a replication controller, service, deployment or pod and expose it as a new Kubernetes service

Basic Commands (Intermediate):
  get             Display one or many resources
`,
    );
    expect(top.description).toBe('kubectl controls the Kubernetes cluster manager.');
    expect(subs(top)).toEqual(['create', 'expose', 'get']);

    const get = parseHelp(
      'kubectl',
      `Options:
    -A, --all-namespaces=false:
	If present, list the requested object(s) across all namespaces.

    --chunk-size=500:
	Return large lists in chunks rather than all at once.

    -o, --output='':
	Output format. One of: (json, yaml, name).
`,
    );
    expect(opt(get, '--all-namespaces')).toMatchObject({ names: ['-A', '--all-namespaces'] });
    expect(opt(get, '--all-namespaces')?.args).toBeUndefined();
    expect(opt(get, '--all-namespaces')?.description).toContain('across all namespaces');
    expect(opt(get, '--chunk-size')?.args).toHaveLength(1);
    expect(opt(get, '-o')?.args).toHaveLength(1);
  });

  it('reads dnf help: commands at column 0 and argparse options', () => {
    const spec = parseHelp(
      'dnf',
      `usage: dnf [options] COMMAND

List of Main Commands:

alias                     List or create command aliases
autoremove                remove all unneeded packages that were originally installed as dependencies
install                   install a package or packages on your system

List of Plugin Commands:

builddep                  Install build dependencies for package or spec file

Optional arguments:
  -c [config file], --config [config file]
                        config file location
  -q, --quiet           quiet operation
  -y, --assumeyes       automatically answer yes for all questions
  --releasever RELEASEVER
                        override the value of $releasever in config and repo
`,
    );
    expect(subs(spec)).toEqual(['alias', 'autoremove', 'install', 'builddep']);
    expect(spec.subcommands?.find((s) => s.names[0] === 'install')?.description).toBe('install a package or packages on your system');
    expect(opt(spec, '--assumeyes')?.args).toBeUndefined();
    expect(opt(spec, '--config')?.args?.[0]).toMatchObject({ name: 'config file', optional: true, templates: ['filepaths'] });
    expect(opt(spec, '--config')?.description).toBe('config file location');
    expect(opt(spec, '--releasever')?.args).toEqual([{ name: 'releasever' }]);
  });

  it('reads git-style grouped command lists', () => {
    const spec = parseHelp(
      'git',
      `usage: git [-v | --version] [-h | --help] [-C <path>] [-c <name>=<value>]

These are common Git commands used in various situations:

start a working area (see also: git help tutorial)
   clone     Clone a repository into a new directory
   init      Create an empty Git repository or reinitialize an existing one

work on the current change (see also: git help everyday)
   add       Add file contents to the index
`,
    );
    expect(subs(spec)).toEqual(['clone', 'init', 'add']);
  });

  it('reads argparse with uppercase placeholders and docker plugin markers', () => {
    const spec = parseHelp(
      'tool',
      `options:
  -h, --help            show this help message and exit
  -o OUTPUT, --output OUTPUT
                        output file
Management Commands:
  builder     Manage builds
  buildx*     Docker Buildx
`,
    );
    expect(opt(spec, '--output')?.args).toEqual([{ name: 'output' }]);
    expect(opt(spec, '--output')?.description).toBe('output file');
    expect(subs(spec)).toEqual(['builder', 'buildx']);
  });

  it('reads systemd-style help (journalctl): space-separated names, nested brackets, repeatable values', () => {
    const spec = parseHelp(
      'journalctl',
      `journalctl [OPTIONS...] [MATCHES...]

Query the journal.

\x1b[0mSource Options:
     --system                Show the system journal
  -M --machine=CONTAINER     Operate on local container
  -m --merge                 Show entries from all available journals

\x1b[0mFiltering Options:
  -S --since=DATE            Show entries not older than the specified date
  -b --boot[=ID]             Show current boot or the specified boot
     --facility=FACILITY...  Show entries with the specified facilities
     --case-sensitive[=BOOL] Force case sensitive or insensitive matching
  -n --lines[=[+]INTEGER]    Number of journal entries to show
`,
    );
    expect(spec.description).toBe('Query the journal.');
    expect(opt(spec, '--since')).toMatchObject({ names: ['-S', '--since'], args: [{ name: 'date' }] });
    expect(opt(spec, '-m')).toMatchObject({ names: ['-m', '--merge'] });
    expect(opt(spec, '-m')?.args).toBeUndefined();
    expect(opt(spec, '--boot')?.args?.[0]).toMatchObject({ optional: true });
    expect(opt(spec, '--facility')?.args).toHaveLength(1);
    expect(opt(spec, '--lines')).toMatchObject({ names: ['-n', '--lines'], description: 'Number of journal entries to show' });
    expect(opt(spec, '--lines')?.args?.[0]).toMatchObject({ name: 'integer', optional: true });
    expect(opt(spec, '--case-sensitive')?.description).toBe('Force case sensitive or insensitive matching');
    expect(spec.options).toHaveLength(8);
  });

  it('ignores escape codes and backspace overstrike from man-style output', () => {
    const spec = parseHelp('x', '\x1b[1mOPTIONS\x1b[0m\n  -\x08-v\x08v, -\x08--verbose  be loud\n');
    expect(opt(spec, '--verbose')).toBeDefined();
  });
});

describe('parseHelp: classic Windows /? pages', () => {
  const xcopy = [
    'Copies files and directory trees.',
    '',
    'XCOPY source [destination] [/A | /M] [/D[:date]] [/P] [/S [/E]] [/V] [/W]',
    '',
    '  source       Specifies the file(s) to copy.',
    '  destination  Specifies the location and/or name of new files.',
    '  /A           Copies only files with the archive attribute set,',
    "               doesn't change the attribute.",
    '  /S           Copies directories and subdirectories except empty ones.',
    '  /E           Copies directories and subdirectories, including empty ones.',
    '  /Y           Suppresses prompting to confirm you want to overwrite.',
  ].join('\n');

  it('reads /X option lines and takes the plain first line as the description', () => {
    const spec = parseHelp('xcopy', xcopy);
    expect(spec.description).toBe('Copies files and directory trees.');
    expect(spec.options?.map((o) => o.names[0])).toEqual(['/A', '/S', '/E', '/Y']);
    expect(spec.options?.[0].description).toMatch(/archive attribute/);
  });

  it('does not take an upper-case synopsis line for the description', () => {
    const spec = parseHelp('tasklist', ['TASKLIST [/S system [/U username]] [/V]', '', 'Description:', '    This tool displays running processes.', '', 'Parameter List:', '   /V      Displays verbose task information.'].join('\n'));
    expect(spec.description).toBe('This tool displays running processes.');
    expect(spec.options?.map((o) => o.names[0])).toContain('/V');
  });
});
