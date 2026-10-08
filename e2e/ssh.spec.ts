import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

/**
 * Drives the built app through an ssh login to a real server: the wrapper's question, the other machine's
 * name in the prompt bar, suggestions from its files and commands, and the setting. Runs only when
 * AUTOBOT_TEST_SSH holds the ssh arguments for a bash or zsh account that has ~/projects/alpha, ~/projects/notes.txt
 * and an executable ~/bin/remote-tool on its PATH (e.g. "-p 2222 -i key -o StrictHostKeyChecking=no user@localhost").
 */

const sshArgs = process.env.AUTOBOT_TEST_SSH;
test.skip(!sshArgs, 'set AUTOBOT_TEST_SSH to run against a real ssh server');

const root = join(__dirname, '..');
let app: ElectronApplication;
let page: Page;
let dataDir: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'autobot-e2e-ssh-'));
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
const dropdownLabels = () => page.locator('.cm-tooltip-autocomplete li .cm-completionLabel').allInnerTexts();

function editorText(): Promise<string> {
  return pane()
    .locator('.cm-content')
    .evaluate((el) => {
      const copy = el.cloneNode(true) as HTMLElement;
      copy.querySelectorAll('.cm-ghost').forEach((g) => g.remove());
      return copy.textContent ?? '';
    });
}

async function clearLine(): Promise<void> {
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+C');
}

test('asks before sending the helper, and "always" is remembered', async () => {
  await page.keyboard.type(`ssh ${sshArgs}`);
  await page.keyboard.press('Enter');
  await expect.poll(terminalText, { timeout: 30_000 }).toContain('not this time');
  await page.keyboard.type('a');
  await page.keyboard.press('Enter');
  // The prompt bar names the other machine.
  await expect(pane().locator('.prompt-bar .host')).toContainText('@', { timeout: 60_000 });
  await prompt().waitFor();
  await expect.poll(() => JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')).sshIntegration).toBe('on');
});

test('completes files and commands of the other machine', async () => {
  await page.keyboard.type('cat ~/pro');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  await expect.poll(editorText).toContain('~/projects/');
  await clearLine();

  // ~/bin is on the remote PATH only after its login files ran.
  await page.keyboard.type('remote-to');
  await expect.poll(dropdownLabels, { timeout: 20_000 }).toContain('remote-tool');
  await clearLine();
});

test('checks paths on the other machine', async () => {
  // The word the cursor is in is not judged yet, so the line ends with a space.
  await page.keyboard.type('cat ~/projects/notes.txt ~/projects/missing.txt ');
  await page.keyboard.press('Escape');
  await expect(pane().locator('.cm-lintRange-warning')).toHaveCount(1, { timeout: 20_000 });
  await clearLine();
});

test('runs commands there, and the questions leave no trace in the terminal', async () => {
  await page.keyboard.type('echo run-over-there');
  await page.keyboard.press('Enter');
  await expect.poll(terminalText).toContain('run-over-there');
  await prompt().waitFor();
  expect(await terminalText()).not.toContain('__autobot_rpc');
});

test('leaving returns to this machine', async () => {
  await expect(pane().locator('.cm-content')).toBeFocused();
  await page.keyboard.type('exit');
  await page.keyboard.press('Enter');
  await expect(pane().locator('.prompt-bar .host')).toBeHidden({ timeout: 30_000 });
  await prompt().waitFor();
});

test('the setting can be changed in the Settings dialog', async () => {
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog.getByRole('radio', { name: 'Always' })).toHaveAttribute('aria-checked', 'true');
  await dialog.getByRole('radio', { name: 'Never' }).click();
  await expect.poll(() => JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')).sshIntegration).toBe('off');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
