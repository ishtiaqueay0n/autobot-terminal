import { describe, expect, it } from 'vitest';
import { DARK_PALETTE, LIGHT_PALETTE, paletteFor } from '../src/shared/palette';

describe('palettes', () => {
  it('give every role a #RRGGBB colour (the terminal takes nothing else)', () => {
    for (const palette of [DARK_PALETTE, LIGHT_PALETTE]) {
      for (const [role, color] of Object.entries(palette)) expect(color, role).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('tell the kinds of command apart', () => {
    for (const palette of [DARK_PALETTE, LIGHT_PALETTE]) {
      const commands = Object.entries(palette).filter(([role]) => role.startsWith('cmd-') && role !== 'cmd-other');
      expect(new Set(commands.map(([, c]) => c)).size).toBe(commands.length);
      // Dangerous things look like errors, and different from the harmless kinds.
      expect(palette['cmd-danger']).toBe(palette.error);
    }
  });

  it('picks by theme', () => {
    expect(paletteFor('dark')).toBe(DARK_PALETTE);
    expect(paletteFor('light')).toBe(LIGHT_PALETTE);
  });
});
