import type { KbArg, KbOption, KbSpec } from '../../shared/kb-types';
import { runIn } from './exec';

const WINDOWS = { id: 'windows', kind: 'windows' as const };

const PRELUDE = `[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
`;

const LIST_SCRIPT = `${PRELUDE}
$names = @(Get-Command -CommandType Cmdlet,Function,Alias | ForEach-Object { $_.Name })
ConvertTo-Json -Compress -InputObject @{ version = "$($PSVersionTable.PSVersion)"; names = $names }
`;

function describeScript(names: string[]): string {
  const list = names.map((n) => `'${n.replace(/'/g, "''")}'`).join(',');
  return `${PRELUDE}
$common = @([System.Management.Automation.PSCmdlet]::CommonParameters) + @([System.Management.Automation.PSCmdlet]::OptionalCommonParameters)
$out = foreach ($n in @(${list})) {
  $c = Get-Command -Name $n | Select-Object -First 1
  if (-not $c) { continue }
  $alias = $null
  if ($c.CommandType -eq 'Alias') { $alias = $c.Name; $c = $c.ResolvedCommand }
  if (-not $c -or -not $c.Parameters) { continue }
  $params = foreach ($p in $c.Parameters.Values) {
    $vs = @()
    foreach ($a in $p.Attributes) { if ($a -is [System.Management.Automation.ValidateSetAttribute]) { $vs = @($a.ValidValues) } }
    $t = $p.ParameterType
    if ($vs.Count -eq 0 -and $t.IsEnum) { $vs = @([enum]::GetNames($t)) }
    $mandatory = $false; $position = -1
    foreach ($ps in $p.ParameterSets.Values) { if ($ps.IsMandatory) { $mandatory = $true }; if ($ps.Position -ge 0) { $position = $ps.Position } }
    @{ n = $p.Name; a = @($p.Aliases); sw = ($t -eq [System.Management.Automation.SwitchParameter]); t = $t.Name; v = $vs; m = $mandatory; p = $position; c = ($common -contains $p.Name) }
  }
  @{ name = $c.Name; alias = $alias; params = @($params) }
}
ConvertTo-Json -Compress -Depth 5 -InputObject @($out)
`;
}

/**
 * The script goes in through stdin, and the command line stays short and plain. Windows Defender scans
 * PowerShell command lines while the process is created, which blocks the calling thread: a long
 * -EncodedCommand, or base64 decoding fed to Invoke-Expression, costs 3-5 s there. Scripts are ASCII (command
 * names are filtered to word characters), so the console input encoding does not matter.
 */
const STDIN_LOADER = '& ([scriptblock]::Create([Console]::In.ReadToEnd()))';

function run(exe: string, script: string, timeoutMs: number) {
  return runIn(WINDOWS, exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', STDIN_LOADER], { timeoutMs, input: script });
}

/** Windows PowerShell 5.1 serializes one-element arrays as plain values; normalize. */
function arr<T>(v: T | T[] | null | undefined): T[] {
  return v === null || v === undefined ? [] : Array.isArray(v) ? v : [v];
}

/** Every cmdlet, function and alias name the PowerShell at `exe` knows (without the user's profile). */
export async function listPowerShellCommands(exe: string): Promise<{ version: string; names: string[] } | null> {
  const res = await run(exe, LIST_SCRIPT, 30_000);
  try {
    const data = JSON.parse(res.stdout) as { version: string; names: string | string[] };
    return { version: data.version, names: arr(data.names) };
  } catch {
    return null;
  }
}

interface RawParam {
  n: string;
  a?: string | string[];
  sw: boolean;
  t: string;
  v?: string | string[];
  m: boolean;
  p: number;
  c: boolean;
}

/** Parameters, aliases, allowed values and positions for each named command, as specs keyed by lower-case name. */
export async function describePowerShellCommands(exe: string, names: string[]): Promise<Map<string, KbSpec>> {
  const safe = names.filter((n) => /^[\w.-]+$/.test(n));
  const result = new Map<string, KbSpec>();
  if (safe.length === 0) return result;
  const res = await run(exe, describeScript(safe), Math.min(60_000, 8_000 + safe.length * 400));
  let rows: { name: string; alias: string | null; params: RawParam | RawParam[] }[];
  try {
    rows = arr(JSON.parse(res.stdout));
  } catch {
    return result;
  }
  for (const row of rows) {
    const spec = toSpec(row.name, arr(row.params));
    result.set(row.name.toLowerCase(), spec);
    if (row.alias) result.set(row.alias.toLowerCase(), { ...spec, names: [row.alias, row.name] });
  }
  return result;
}

const KEEP_COMMON = new Set(['WhatIf', 'Confirm', 'ErrorAction', 'Verbose']);

export function toSpec(name: string, params: RawParam[]): KbSpec {
  const options: KbOption[] = [];
  const positional: { pos: number; arg: KbArg }[] = [];
  for (const p of params) {
    const arg = p.sw ? null : valueArg(p);
    const option: KbOption = { names: [`-${p.n}`, ...arr(p.a).map((a) => `-${a}`)] };
    if (arg) option.args = [arg];
    if (p.m) option.required = true;
    // Common parameters (-Debug, -OutVariable ...) stay valid but are not offered unless asked for.
    if (p.c && !KEEP_COMMON.has(p.n)) option.hidden = true;
    options.push(option);
    if (arg && p.p >= 0) positional.push({ pos: p.p, arg: { ...arg, name: p.n } });
  }
  positional.sort((a, b) => a.pos - b.pos);
  const spec: KbSpec = { names: [name], options };
  if (positional.length) spec.args = positional.map((x) => ({ ...x.arg, optional: true }));
  return spec;
}

function valueArg(p: RawParam): KbArg {
  const arg: KbArg = { name: p.t };
  const values = arr(p.v);
  if (values.length) arg.suggestions = values.map((v) => ({ name: v }));
  if (/^(Path|LiteralPath|FilePath|PSPath|Destination|OutFile|InFile|.*Path)$/i.test(p.n) || /^(FileInfo|DirectoryInfo)$/.test(p.t)) {
    arg.templates = /Directory|Folder/i.test(p.n) || p.t === 'DirectoryInfo' ? ['folders'] : ['filepaths'];
  }
  return arg;
}
