import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

/**
 * Drives the built app and looks at the colours: the command line while it is typed, the same line in the
 * scrollback after it ran, and the output of the command. Runs the platform's default shell.
 */

const root = join(__dirname, '..');
let app: ElectronApplication;
let page: Page;
let dataDir: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'autobot-e2e-colors-'));
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ importHistory: false, learnTools: false, llmProvider: 'off' }));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  env.AUTOBOT_USER_DATA = dataDir;
  app = await electron.launch({ args: [root], cwd: root, env });
  page = await app.firstWindow();
  await prompt().waitFor({ timeout: 60_000 });
});

test.afterAll(async () => {
  await app?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const pane = () => page.locator('.pane[style*="flex"]');
const prompt = () => pane().locator('.input-area.mode-prompt');
const terminalText = () => pane().locator('.xterm-rows').innerText();

const hex = (h: string): string => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(',');

/**
 * The text of the first terminal row that starts with `start`, by colour: the pieces drawn in a colour of their
 * own, keyed "r,g,b" (text drawn in the default colour is under ""). The terminal draws spaces as non-breaking.
 */
function colorsOfRow(start: string): Promise<Record<string, string> | null> {
  return pane()
    .locator('.xterm-rows')
    .evaluate((rows, wanted) => {
      for (const row of Array.from(rows.children)) {
        if (!(row.textContent ?? '').replace(/ /g, ' ').trimStart().startsWith(wanted)) continue;
        const byColor: Record<string, string> = {};
        for (const span of Array.from(row.querySelectorAll('span'))) {
          const own = (span as HTMLElement).style.color ? getComputedStyle(span).color.replace(/[^\d,]/g, '') : '';
          byColor[own] = (byColor[own] ?? '') + (span.textContent ?? '').replace(/ /g, ' ');
        }
        return byColor;
      }
      return null;
    }, start);
}

test('colours the command line while it is typed, by what each word is', async () => {
  await page.keyboard.type('git commit --amend "a note" ~/x');
  await page.keyboard.press('Escape');
  const cls = async (name: string) => (await pane().locator(`.cm-content .tok-${name}`).allInnerTexts()).join('|');
  expect(await cls('cmd-vcs')).toBe('git');
  expect(await cls('subcommand')).toBe('commit');
  expect(await cls('option')).toBe('--amend');
  expect(await cls('string')).toBe('"a note"');
  expect(await cls('path')).toBe('~/x');
  // The colour really is the palette's.
  const color = await pane().locator('.cm-content .tok-cmd-vcs').evaluate((el) => getComputedStyle(el).color.replace(/[^\d,]/g, ''));
  expect(color).toBe(hex('#c678dd'));
  // A different kind of command gets a different colour.
  await page.keyboard.press('Control+C');
  await page.keyboard.type('rm -rf x');
  await page.keyboard.press('Escape');
  expect(await pane().locator('.cm-content .tok-cmd-danger').allInnerTexts()).toEqual(['rm']);
  await page.keyboard.press('Control+C');
});

test('colours the output by its words, and the echoed command line by its words', async () => {
  await page.keyboard.type('echo "error: cannot open /etc/x"');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await expect.poll(terminalText).toContain('cannot open');
  await prompt().waitFor();
  // The output line: "error" and "cannot" are errors, the path is a path.
  const output = await colorsOfRow('error: cannot open');
  expect(output?.[hex('#e06c75')]).toBe('errorcannot');
  expect(output?.[hex('#98c379')]).toBe('/etc/x');
  // The echoed command line above it is coloured as a command line instead: echo is a shell word and the quoted
  // text is one string, not three error words.
  await expect.poll(async () => (await colorsOfRow('echo "error'))?.[hex('#c0caf5')]).toBe('echo');
  expect((await colorsOfRow('echo "error'))?.[hex('#ce9178')]).toBe('"error: cannot open /etc/x"');
});

test('can be turned off in the Settings dialog', async () => {
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  // The boxes follow the saved settings, so they flip a moment after the click.
  await dialog.getByLabel(/Colour commands/).click();
  await expect(dialog.getByLabel(/Colour commands/)).not.toBeChecked();
  await dialog.getByLabel(/Colour output/).click();
  await expect(dialog.getByLabel(/Colour output/)).not.toBeChecked();
  await page.keyboard.press('Escape');
  await page.keyboard.type('echo "error: again"');
  await page.keyboard.press('Escape');
  expect(await pane().locator('.cm-content .tok').count()).toBe(0);
  await page.keyboard.press('Enter');
  await expect.poll(terminalText).toContain('error: again');
  await prompt().waitFor();
  const row = await colorsOfRow('error: again');
  expect(row?.[hex('#e06c75')]).toBeUndefined();
  expect((await colorsOfRow('echo "error: again'))?.[hex('#c0caf5')]).toBeUndefined();
});
