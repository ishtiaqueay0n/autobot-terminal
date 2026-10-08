import { describe, expect, it } from 'vitest';
import { detectLocalProfiles } from '../src/main/profiles';
import { describePowerShellCommands, listPowerShellCommands } from '../src/main/kb/powershell';

/** Asks the installed Windows PowerShell for its commands; skipped where there is none. */
const exe = process.platform === 'win32' ? (detectLocalProfiles().find((p) => p.kind === 'powershell')?.executable ?? null) : null;

describe.skipIf(!exe)('PowerShell introspection', () => {
  it('lists commands', async () => {
    const list = await listPowerShellCommands(exe!);
    expect(list?.names).toContain('Get-ChildItem');
  }, 60_000);

  it('describes parameters without blocking the caller', async () => {
    // A batch of names makes a long script; it must not slow down process creation (see powershell.ts).
    const names = ['Get-ChildItem', 'gci', 'Get-Date', 'Set-Location', 'Get-Process', 'Get-Service', 'Get-Content', 'Copy-Item'];
    const started = performance.now();
    const pending = describePowerShellCommands(exe!, names);
    expect(performance.now() - started).toBeLessThan(1000);
    const specs = await pending;
    const gci = specs.get('get-childitem');
    expect(gci?.options?.some((o) => o.names.includes('-Recurse'))).toBe(true);
    expect(specs.has('get-date')).toBe(true);
  }, 60_000);
});
