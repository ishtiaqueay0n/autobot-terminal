import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

/**
 * Drives the built app with cmd.exe (Command Prompt) as the shell, like a user would. Windows only.
 */

test.skip(process.platform !== 'win32', 'cmd.exe exists only on Windows');

const root = join(__dirname, '..');
let app: ElectronApplication;
let page: Page;
let dataDir: string;
let files: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'autobot-e2e-cmd-'));
  files = join(dataDir, 'files');
  mkdirSync(files);
  writeFileSync(join(files, 'cmd-unique-file.txt'), 'hello');
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ importHistory: false, learnTools: false, llmProvider: 'off', defaultProfile: 'cmd' }));
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
const ghost = () => pane().locator('.cm-ghost');
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

async function run(command: string, expectOutput: string): Promise<void> {
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
  await expect.poll(terminalText).toContain(expectOutput);
  await prompt().waitFor();
}

test('opens a Command Prompt tab and runs a command without showing the hook text', async () => {
  await expect(pane().locator('.prompt-bar .shell-label')).toContainText('cmd');
  await run('echo e2e-cmd-hello', 'e2e-cmd-hello');
  await expect(pane().locator('.cmd-mark[data-status="ok"]').first()).toBeAttached();
  const text = await terminalText();
  expect(text).not.toContain('__AB');
  expect(text).not.toContain('&%');
});

test('shows the exit code of a failed command', async () => {
  await run('cmd /c "echo e2e-cmd-fail & exit 3"', 'e2e-cmd-fail');
  await expect(pane().locator('.prompt-bar .exit-code')).toHaveText('exit 3');
  await expect(pane().locator('.cmd-mark[data-status="fail"]').first()).toBeAttached();
});

test('offers ghost text from history; → accepts it', async () => {
  await run('echo e2e-cmd-ghost-42', 'e2e-cmd-ghost-42');
  await page.keyboard.type('echo e2e-cmd-gh');
  await expect(ghost()).toHaveText('ost-42');
  await page.keyboard.press('ArrowRight');
  expect(await editorText()).toBe('echo e2e-cmd-ghost-42');
  await clearLine();
});

test('the dropdown offers a built-in command’s /options and Tab accepts', async () => {
  await page.keyboard.type('dir /');
  await expect.poll(dropdownLabels, { timeout: 20_000 }).toEqual(expect.arrayContaining(['/b', '/s']));
  await page.keyboard.type('s');
  await expect.poll(dropdownLabels).toContain('/s');
  await page.keyboard.press('Tab');
  await expect.poll(editorText).toBe('dir /s ');
  await clearLine();
});

test('Tab completes file paths, quoting only when needed', async () => {
  await page.keyboard.type(`type ${files}\\cmd-uni`);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  await expect.poll(editorText).toContain('cmd-unique-file.txt');
  await clearLine();
});

test('underlines a mistyped command and Alt+Enter fixes it', async () => {
  await expect
    .poll(
      async () => {
        await clearLine();
        await page.keyboard.type('dri /b');
        await page.waitForTimeout(600);
        return (await pane().locator('.hint').textContent()) ?? '';
      },
      { timeout: 30_000 },
    )
    .toContain("Did you mean 'dir'?");
  await page.keyboard.press('Alt+Enter');
  await expect.poll(editorText).toBe('dir /b');
  await clearLine();
});

test('destructive commands need a second Enter; Esc cancels', async () => {
  await page.keyboard.type('rd /s /q C:\\');
  await page.keyboard.press('Enter');
  await expect(pane().locator('.banner-danger')).toBeVisible();
  await expect(prompt()).toBeVisible(); // not run yet
  await page.keyboard.press('Escape');
  await expect(pane().locator('.banner-danger')).toBeHidden();
  await clearLine();
});

test('after a failure, the fix is offered as a banner and ghost text', async () => {
  await page.keyboard.type('dri');
  await page.keyboard.press('Enter');
  await expect(pane().locator('.banner-fix')).toContainText('Did you mean', { timeout: 20_000 });
  await expect(ghost()).toHaveText('dir');
  await page.keyboard.press('ArrowRight');
  expect(await editorText()).toBe('dir');
  await clearLine();
});

test('a block of several lines runs as one command', async () => {
  await page.keyboard.type('if 1==1 (');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('echo e2e-cmd-block');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type(')');
  await page.keyboard.press('Enter');
  await expect.poll(terminalText).toContain('e2e-cmd-block');
  await prompt().waitFor();
  await expect(pane().locator('.prompt-bar .exit-code')).toHaveCount(0);
});
