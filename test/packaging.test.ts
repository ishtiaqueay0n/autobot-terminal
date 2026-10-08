import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
// Line endings follow the checkout (CRLF on Windows): the checks below are about content.
const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8').replace(/\r\n/g, '\n');

/** The part of electron-builder.yml under a top-level key (up to the next top-level key). */
function section(yml: string, key: string): string {
  const match = new RegExp(`^${key}:\\n((?:[ \\t].*\\n|\\n)*)`, 'm').exec(yml);
  return match?.[1] ?? '';
}

describe('Linux packaging (found by installing on clean RHEL 8/9 and Ubuntu 22.04/24.04 images)', () => {
  const yml = read('electron-builder.yml');

  it('the rpm declares the libraries Electron needs that RHEL 8 does not pull in, and libsecret', () => {
    const rpm = section(yml, 'rpm');
    for (const lib of ['gtk3', 'nss', 'libsecret', 'mesa-libgbm', 'alsa-lib', 'libdrm', 'libX11-xcb']) {
      expect(rpm, lib).toMatch(new RegExp(`^\\s+- ${lib}$`, 'm'));
    }
    // Without this, rpm 4.14+ adds .build-id links that collide with other Electron apps' packages.
    expect(rpm).toContain('_build_id_links none');
  });

  it('the deb declares them too, with the Ubuntu 24.04 name of libasound', () => {
    const deb = section(yml, 'deb');
    for (const lib of ['libgtk-3-0', 'libnss3', 'libsecret-1-0', 'libgbm1', 'libdrm2', 'libx11-xcb1']) {
      expect(deb, lib).toContain(lib);
    }
    expect(deb).toContain('libasound2t64 | libasound2');
  });

  it('is a terminal in the menu and keeps the desktop window class in sync', () => {
    expect(section(yml, 'linux')).toMatch(/category: System;TerminalEmulator/);
    expect(section(yml, 'linux')).toMatch(/syncDesktopName: true/);
    expect(read('package.json')).toMatch(/"desktopName": "autobot-terminal\.desktop"/);
  });

  it('shell scripts and hooks use LF line endings (CRLF breaks them on Linux)', () => {
    const files = [
      ...readdirSync(join(root, 'scripts')).filter((f) => f.endsWith('.sh')).map((f) => join('scripts', f)),
      join('build', 'linux', 'rpm-after-remove.sh'),
      join('resources', 'shell', 'autobot.bash'),
      join('resources', 'shell', 'zsh', '.zshenv'),
      join('resources', 'shell', 'zsh', '.zshrc'),
    ];
    expect(files.length).toBeGreaterThan(4);
    for (const f of files) expect(read(f), f).not.toContain('\r');
  });

  it('the rpm removal script keeps the launcher when rpm upgrades or reinstalls', () => {
    expect(section(yml, 'rpm')).toContain('afterRemove: build/linux/rpm-after-remove.sh');
    // rpm passes the number of remaining installs: only 0 (a real uninstall) may remove the launcher.
    const script = read('build', 'linux', 'rpm-after-remove.sh');
    expect(script).toContain('if [ "${1:-0}" -gt 0 ]');
    expect(script.indexOf('exit 0')).toBeLessThan(script.indexOf('update-alternatives --remove'));
  });

  it('the build script enables a modern gcc and clears LD_LIBRARY_PATH for rpmbuild', () => {
    expect(read('scripts', 'lib-linux.sh')).toContain('gcc-toolset');
    expect(read('scripts', 'build-linux.sh')).toMatch(/unset LD_LIBRARY_PATH/);
  });
});
