import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

/**
 * Drives the built app (out/) like a user: types into the input editor and reads the terminal. Runs the
 * platform's default shell: Windows PowerShell on Windows, bash on Linux.
 */

const root = join(__dirname, '..');
const windows = process.platform === 'win32';
const sep = windows ? '\\' : '/';

let app: ElectronApplication;
let page: Page;
let dataDir: string;
let files: string;
let ai: Server;
/** Request bodies the fake AI received. */
const aiRequests: string[] = [];
const AI_FIX = windows ? 'Get-Process -Name e2e' : 'echo e2e-ai-fixed';

/**
 * A stand-in for a local Ollama server, so the AI features run end to end without a real model:
 * it answers by the shape of the requested JSON.
 */
function startFakeAi(): Promise<number> {
  ai = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      aiRequests.push(body);
      const props = Object.keys(JSON.parse(body).format?.properties ?? {});
      let answer: unknown = { known: false, description: '', subcommands: [], options: [], examples: [] };
      if (props.includes('explanation')) answer = { explanation: 'e2e: the AI explains the failure.', command: AI_FIX };
      if (props.includes('summary')) answer = { summary: 'e2e: archives files.', examples: [{ command: 'tar -cf {{out.tar}} {{dir}}', description: 'Pack' }] };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ message: { role: 'assistant', content: JSON.stringify(answer) } }));
    });
  });
  return new Promise((resolve) => ai.listen(0, '127.0.0.1', () => resolve((ai.address() as { port: number }).port)));
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'autobot-e2e-'));
  files = join(dataDir, 'files');
  mkdirSync(files);
  writeFileSync(join(files, 'e2e-unique-file.txt'), 'hello');
  const aiPort = await startFakeAi();
  // An isolated profile: no import of the real shell history, no background learning, a fake local AI.
  writeFileSync(
    join(dataDir, 'settings.json'),
    JSON.stringify({
      importHistory: false,
      learnTools: false,
      llmProvider: 'ollama',
      ollamaUrl: `http://127.0.0.1:${aiPort}`,
      ollamaModel: 'e2e-model',
      llmLearn: false,
      llmPanel: true,
    }),
  );
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  env.AUTOBOT_USER_DATA = dataDir;
  app = await electron.launch({ args: [root], cwd: root, env });
  page = await app.firstWindow();
  await prompt().waitFor({ timeout: 60_000 });
});

test.afterAll(async () => {
  await app?.close();
  ai?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const pane = () => page.locator('.pane[style*="flex"]');
const prompt = () => pane().locator('.input-area.mode-prompt');
const terminalText = () => pane().locator('.xterm-rows').innerText();
const ghost = () => pane().locator('.cm-ghost');
const dropdownLabels = () => page.locator('.cm-tooltip-autocomplete li .cm-completionLabel').allInnerTexts();

/** Editor text without the ghost suggestion. */
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

/** Types a command, runs it and waits until its output and the next prompt are there. */
async function run(command: string, expectOutput: string): Promise<void> {
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
  await expect.poll(terminalText).toContain(expectOutput);
  await prompt().waitFor();
}

test('opens the login shell (Linux) or PowerShell (Windows)', async () => {
  const expected = windows ? 'PowerShell' : (process.env.SHELL ?? '/bin/bash').split('/').pop()!;
  await expect(pane().locator('.prompt-bar .shell-label')).toContainText(expected);
});

test('runs a command and marks it successful', async () => {
  await run('echo e2e-hello', 'e2e-hello');
  await expect(pane().locator('.cmd-mark[data-status="ok"]').first()).toBeAttached();
});

test('shows the exit code of a failed command', async () => {
  await run(windows ? 'cmd /c "echo e2e-fail & exit 3"' : '(echo e2e-fail; exit 3)', 'e2e-fail');
  await expect(pane().locator('.prompt-bar .exit-code')).toHaveText('exit 3');
  await expect(pane().locator('.cmd-mark[data-status="fail"]').first()).toBeAttached();
});

test('offers ghost text from history; → accepts it', async () => {
  await run('echo e2e-ghost-42', 'e2e-ghost-42');
  await page.keyboard.type('echo e2e-gh');
  await expect(ghost()).toHaveText('ost-42');
  await page.keyboard.press('ArrowRight');
  expect(await editorText()).toBe('echo e2e-ghost-42');
  await clearLine();
});

test('the dropdown suggests options and Tab accepts', async () => {
  // On Linux the bundled data has GNU tools' long flags only for some (git has them); the rest are learned from
  // --help, which this profile turns off. (ls --color would insert "--color=": it takes an attached value.)
  const typed = windows ? 'Get-ChildItem -Rec' : 'git commit --amen';
  const expected = windows ? '-Recurse' : '--amend';
  await page.keyboard.type(typed);
  // PowerShell parameter metadata is fetched on first use; the dropdown appears once it is in.
  await expect.poll(dropdownLabels, { timeout: 20_000 }).toContain(expected);
  await page.keyboard.press('Tab');
  await expect.poll(editorText).toBe(`${typed.slice(0, typed.lastIndexOf(' ') + 1)}${expected} `);
  await clearLine();
});

test('Tab completes file paths', async () => {
  await page.keyboard.type(`${windows ? 'Get-Item' : 'cat'} ${files}${sep}e2e-uni`);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  await expect.poll(editorText).toContain(`e2e-unique-file.txt`);
  await clearLine();
});

test('Ctrl+Space opens the panel with examples', async () => {
  await page.keyboard.type('tar ');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Space');
  const panel = page.locator('.panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.panel-tool')).toHaveText('tar');
  await expect(panel.locator('.panel-section', { hasText: 'Examples' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await clearLine();
});

test('underlines a mistyped command and Alt+Enter fixes it', async () => {
  const typo = windows ? 'Get-ChildItm' : 'ecoh';
  const fixed = windows ? 'Get-ChildItem' : 'echo';
  // Command checks start once the shell's command list has loaded.
  await expect
    .poll(
      async () => {
        await clearLine();
        await page.keyboard.type(`${typo} x`);
        await page.waitForTimeout(600);
        return (await pane().locator('.hint').textContent()) ?? '';
      },
      { timeout: 30_000 },
    )
    .toContain(`Did you mean '${fixed}'?`);
  await expect(pane().locator('.cm-lintRange-error')).toHaveCount(1);
  await page.keyboard.press('Alt+Enter');
  await expect.poll(editorText).toBe(`${fixed} x`);
  await clearLine();
});

test('destructive commands need a second Enter; Esc cancels', async () => {
  // -WhatIf only prints what would happen, so the second Enter is safe to test on Windows.
  const line = windows ? 'Restart-Computer -WhatIf' : 'reboot --help';
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
  await expect(pane().locator('.banner-danger')).toBeVisible();
  await expect(prompt()).toBeVisible(); // not run yet
  await page.keyboard.press('Escape');
  await expect(pane().locator('.banner-danger')).toBeHidden();
  if (windows) {
    await page.keyboard.press('Enter');
    await expect(pane().locator('.banner-danger')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect.poll(terminalText).toContain('What if');
    await prompt().waitFor();
  } else {
    await clearLine();
  }
});

test('after a failure, the fix is offered as a banner and ghost text', async () => {
  const typo = windows ? 'Get-Proces' : 'ecoh e2e';
  const fixed = windows ? 'Get-Process' : 'echo e2e';
  await page.keyboard.type(typo);
  await page.keyboard.press('Enter');
  await expect(pane().locator('.banner-fix')).toContainText(`Did you mean`, { timeout: 20_000 });
  await expect(ghost()).toHaveText(fixed);
  await page.keyboard.press('ArrowRight');
  expect(await editorText()).toBe(fixed);
  await clearLine();
});

test('Ctrl+. asks the AI to fix the last failure, with secrets and home folder hidden', async () => {
  const failing = windows
    ? 'cmd /c "echo e2e-ai-fail %USERPROFILE% --password=hunter22 & exit 4"'
    : 'echo e2e-ai-fail $HOME --password=hunter22; (exit 4)';
  await run(failing, 'e2e-ai-fail');
  await expect(pane().locator('.prompt-bar .ai-hint')).toHaveText('Ctrl+. ask AI');
  aiRequests.length = 0;
  await page.keyboard.press('Control+Period');
  const banner = pane().locator('.banner-fix');
  await expect(banner).toContainText('e2e: the AI explains the failure.');
  await expect(banner.locator('.banner-badge')).toHaveText('AI');
  await expect(ghost()).toHaveText(AI_FIX);
  const sent = aiRequests.join('\n');
  expect(sent).toContain('e2e-ai-fail');
  expect(sent).not.toContain('hunter22');
  expect(sent.toLowerCase()).not.toContain(JSON.stringify(homedir()).slice(1, -1).toLowerCase());
  await page.keyboard.press('Escape');
  await expect(banner).toBeHidden();
});

test('the panel shows AI notes when turned on', async () => {
  await page.keyboard.type('tar ');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Space');
  await expect(page.locator('.panel .panel-ai-summary')).toHaveText('e2e: archives files.');
  await expect(page.locator('.panel .panel-entry', { hasText: 'tar -cf out.tar dir' })).toBeVisible();
  await page.keyboard.press('Escape');
  await clearLine();
});

test('the AI button opens the AI settings', async () => {
  await page.locator('.ai-button').click();
  const dialog = page.getByRole('dialog', { name: 'AI assistant' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.ai-status')).toContainText('Ready: e2e-model');
  await dialog.getByRole('button', { name: 'Test' }).click();
  await expect(dialog.locator('.ai-note')).toContainText('Ollama (e2e-model) is working.');
  await dialog.getByRole('radio', { name: 'Claude' }).click();
  await expect(dialog.getByLabel('API key')).toBeVisible();
  await dialog.getByRole('radio', { name: 'Ollama (local)' }).click();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(prompt()).toBeVisible();
});

test('Ctrl+Shift+T and Ctrl+Shift+W open and close tabs', async () => {
  await page.keyboard.press('Control+Shift+T');
  await expect(page.locator('.tab')).toHaveCount(2);
  await prompt().waitFor({ timeout: 60_000 });
  await page.keyboard.press('Control+Shift+W');
  await expect(page.locator('.tab')).toHaveCount(1);
});
