import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { BundledKb } from '../src/main/kb/bundled';
import type { EnvRef } from '../src/main/kb/exec';
import { addAiDescriptions, Knowledge } from '../src/main/kb/knowledge';
import { KnowledgeStore } from '../src/main/kb/store';
import { AiService } from '../src/main/llm/ai';
import type { JsonRequest, JsonResponse, LlmClient } from '../src/main/llm/client';
import { KeyStore, type Encryptor } from '../src/main/llm/keystore';
import {
  cleanExamples,
  describeRequest,
  fixRequest,
  parseDescribe,
  parseExplain,
  parseFix,
  parseResearch,
} from '../src/main/llm/tasks';
import { DEFAULT_SETTINGS } from '../src/main/settings';
import type { KbSpec } from '../src/shared/kb-types';
import { redactOutput } from '../src/shared/redact';
import type { Settings } from '../src/shared/types';

const root = mkdtempSync(join(tmpdir(), 'autobot-ai-'));
const open: KnowledgeStore[] = [];
afterAll(() => {
  for (const s of open) s.close();
  rmSync(root, { recursive: true, force: true });
});

describe('AI answers are checked before use', () => {
  it('fix: one line, not the failed command, masked values not offered as a command', () => {
    expect(parseFix({ explanation: 'Typo in the subcommand.', command: 'git status' }, 'git stauts')).toEqual({
      title: 'Typo in the subcommand.',
      command: 'git status',
      source: 'ai',
    });
    expect(parseFix({ explanation: 'Same', command: 'git stauts' }, 'git stauts')?.command).toBeUndefined();
    expect(parseFix({ explanation: 'Two lines', command: 'cd x\nrm y' }, 'z')?.command).toBeUndefined();
    const masked = parseFix({ explanation: 'Wrong flag.', command: 'mysql -u root -p*** db' }, 'mysql -u root -x*** db');
    expect(masked?.command).toBeUndefined();
    expect(masked?.detail).toContain('mysql -u root -p*** db');
    expect(parseFix({ explanation: '', command: '' }, 'x')).toBeNull();
    expect(parseFix('nonsense', 'x')).toBeNull();
  });

  it('examples: for this tool, one line, only known options', () => {
    const allowed = new Set(['-l', '-a', '--color']);
    const examples = cleanExamples(
      [
        { command: 'ls -la {{path/to/dir}}', description: 'List all' },
        { command: 'ls --colour', description: 'Unknown option' },
        { command: 'rm -rf /', description: 'Other tool' },
        { command: 'ls\nrm x', description: 'Two lines' },
        { command: 'ls --color=auto', description: 'Value attached' },
      ],
      'ls',
      false,
      5,
      allowed,
    );
    expect(examples.map((e) => e.command)).toEqual(['ls -la {{path/to/dir}}', 'ls --color=auto']);
  });

  it('PowerShell examples compare names case-insensitively', () => {
    const ex = cleanExamples([{ command: 'get-childitem -recurse', description: 'x' }], 'Get-ChildItem', true, 5, new Set(['-recurse']));
    expect(ex).toHaveLength(1);
  });

  it('describe: descriptions only for names the tool listed', () => {
    const spec: KbSpec = { names: ['tool'], options: [{ names: ['-v', '--verbose'] }, { names: ['--json'] }], subcommands: [{ names: ['run'] }] };
    const input = { tool: 'tool', shell: 'bash' as const, os: 'Linux', spec };
    const notes = parseDescribe(
      {
        description: 'Runs things.',
        options: [
          { name: '--verbose', description: 'More output' },
          { name: '--made-up', description: 'Not real' },
        ],
        subcommands: [{ name: 'run', description: 'Run a job' }],
        examples: [
          { command: 'tool run --json', description: 'As JSON' },
          { command: 'tool --made-up', description: 'Invented' },
        ],
      },
      input,
      false,
    );
    expect(notes?.spec?.description).toBe('Runs things');
    expect(notes?.spec?.options).toEqual([{ names: ['-v', '--verbose'], description: 'More output' }]);
    expect(notes?.spec?.subcommands).toEqual([{ names: ['run'], description: 'Run a job' }]);
    expect(notes?.examples.map((e) => e.command)).toEqual(['tool run --json']);
  });

  it('research: unknown tools are remembered as unknown; option names must look like options', () => {
    expect(parseResearch({ known: false, description: '', subcommands: [], options: [], examples: [] }, 'zz', false)).toEqual({
      spec: null,
      examples: [],
      unknown: true,
    });
    const notes = parseResearch(
      {
        known: true,
        description: 'Fast file finder.',
        subcommands: [],
        options: [
          { names: ['-H', '--hidden'], description: 'Include hidden files', takesValue: false },
          { names: ['rm -rf /'], description: 'bad', takesValue: false },
          { names: ['-e', '--extension'], description: 'Filter by extension', takesValue: true },
        ],
        examples: [{ command: 'fd -e {{ext}}', description: 'By extension' }],
      },
      'fd',
      false,
    );
    expect(notes?.spec?.options?.map((o) => o.names[0])).toEqual(['-H', '-e']);
    expect(notes?.spec?.options?.[1].args).toEqual([{ name: 'value' }]);
    expect(notes?.examples).toHaveLength(1);
  });

  it('explain: summary and examples for the right tool', () => {
    expect(parseExplain({ summary: 'Lists pods.', examples: [{ command: 'kubectl get pods', description: 'All pods' }] }, 'kubectl', false)).toEqual({
      summary: 'Lists pods.',
      examples: [{ command: 'kubectl get pods', text: 'All pods' }],
    });
    expect(parseExplain({ summary: '', examples: [] }, 'kubectl', false)).toBeNull();
  });

  it('requests use strict answer schemas', () => {
    const req = fixRequest({ command: 'x', exitCode: 1, output: '', shell: 'bash', os: 'Ubuntu', packageManager: 'apt' });
    expect(req.answer.schema).toMatchObject({ type: 'object', additionalProperties: false, required: ['explanation', 'command'] });
    expect(req.prompt).toContain('(no output)');
    const d = describeRequest({ tool: 't', shell: 'bash', os: 'Linux', spec: { names: ['t'], options: [{ names: ['-a', '--all'] }] } });
    expect(d.prompt).toContain('-a|--all');
  });
});

describe('AI knowledge never adds what a tool accepts', () => {
  it('fills descriptions only', () => {
    const local: KbSpec = { names: ['t'], options: [{ names: ['--a'] }, { names: ['--b'], description: 'Own text' }], verified: true };
    const ai: KbSpec = { names: ['t'], description: 'AI text', options: [{ names: ['--a'], description: 'AI a' }, { names: ['--b'], description: 'AI b' }, { names: ['--c'], description: 'AI c' }] };
    expect(addAiDescriptions(local, ai)).toEqual({
      names: ['t'],
      description: 'AI text',
      options: [{ names: ['--a'], description: 'AI a' }, { names: ['--b'], description: 'Own text' }],
      subcommands: undefined,
      verified: true,
    });
  });

  it('uses the AI spec alone only for tools nothing else knows, unverified', () => {
    const kbDir = join(root, 'kb');
    mkdirSync(join(kbDir, 'fig'), { recursive: true });
    writeFileSync(join(kbDir, 'fig', 'tar.json.gz'), gzipSync(JSON.stringify({ names: ['tar'], options: [{ names: ['-x'] }] })));
    writeFileSync(join(kbDir, 'index.json'), JSON.stringify({ version: 1, generatedAt: '', fig: { tar: { file: 'fig/tar.json.gz' } } }));
    const store = new KnowledgeStore(join(root, 'k1.db'));
    const knowledge = new Knowledge(new BundledKb(kbDir), store);
    const aiSpec = (tool: string): KbSpec => ({ names: [tool], description: `${tool} by AI`, options: [{ names: ['--ai-only'], description: 'x' }] });
    for (const tool of ['tar', 'mytool', 'fd']) store.putAiNotes('linux', tool, { spec: aiSpec(tool), examples: [] }, 'm');
    store.put('linux', 'mytool', '', 'help', { names: ['mytool'], options: [{ names: ['--real'] }] }, null);

    const tar = knowledge.root('linux', 'tar');
    expect(tar?.options?.map((o) => o.names[0])).toEqual(['-x']);
    expect(tar?.description).toBe('tar by AI');
    const mine = knowledge.root('linux', 'mytool');
    expect(mine?.options?.map((o) => o.names[0])).toEqual(['--real']);
    const fd = knowledge.root('linux', 'fd');
    expect(fd?.options?.map((o) => o.names[0])).toEqual(['--ai-only']);
    expect(fd?.verified).toBe(false);
    expect(knowledge.source('linux', 'fd')).toBe('ai');
    store.close();
  });
});

describe('KeyStore', () => {
  const fake = (available = true): Encryptor => ({
    available: () => available,
    encrypt: (t) => Buffer.from(`enc:${Buffer.from(t).toString('base64')}`),
    decrypt: (b) => Buffer.from(b.toString().slice(4), 'base64').toString(),
  });
  const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz';

  it('stores the key encrypted, never in plain text', () => {
    const file = join(root, 'key1.bin');
    const keys = new KeyStore(file, fake(), {});
    keys.set(KEY);
    expect(readFileSync(file, 'utf8')).not.toContain(KEY);
    expect(new KeyStore(file, fake(), {}).get()).toEqual({ key: KEY, source: 'keychain' });
    keys.set('');
    expect(new KeyStore(file, fake(), {}).get()).toBeNull();
  });

  it('refuses to store without an OS key store, and falls back to ANTHROPIC_API_KEY', () => {
    const keys = new KeyStore(join(root, 'key2.bin'), fake(false), { ANTHROPIC_API_KEY: KEY });
    expect(() => keys.set('sk-ant-another-key-0123456789')).toThrow(/key store|keyring/);
    expect(keys.get()).toEqual({ key: KEY, source: 'env' });
  });

  it('rejects things that are not keys', () => {
    expect(() => new KeyStore(join(root, 'key3.bin'), fake(), {}).set('hello world')).toThrow();
  });
});

describe('AiService', () => {
  const env: EnvRef = { id: 'linux', kind: 'linux' };
  let calls: JsonRequest[];
  let answer: (req: JsonRequest) => JsonResponse;
  let settings: Settings;
  let store: KnowledgeStore;
  let knowledge: Knowledge;
  let n = 0;

  const fakeClient: LlmClient = {
    label: 'Fake',
    model: 'fake-1',
    canSearch: true,
    json: async (req) => {
      calls.push(req);
      return answer(req);
    },
  };

  function service(resolve: (tool: string) => string | null = () => '/usr/bin/x') {
    return new AiService({
      settings: () => settings,
      keys: new KeyStore(join(root, `none-${n}.bin`), { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' }, {}),
      store,
      knowledge,
      resolve: async (_env, tool) => resolve(tool),
      makeClient: (s) => (s.llmProvider === 'off' ? null : fakeClient),
    });
  }

  beforeEach(() => {
    n++;
    calls = [];
    settings = { ...DEFAULT_SETTINGS };
    const kbDir = join(root, `kb-${n}`);
    mkdirSync(kbDir, { recursive: true });
    writeFileSync(join(kbDir, 'index.json'), JSON.stringify({ version: 1, generatedAt: '', fig: {} }));
    store = new KnowledgeStore(join(root, `svc-${n}.db`));
    open.push(store);
    knowledge = new Knowledge(new BundledKb(kbDir), store);
  });

  it('turns an answer into a fix', async () => {
    answer = () => ({ ok: true, value: { explanation: 'Missing sudo.', command: 'sudo apt update' } });
    const res = await service().fix({ command: 'apt update', exitCode: 100, output: 'Permission denied', shell: 'bash', os: 'Ubuntu', packageManager: 'apt' });
    expect(res).toEqual({ ok: true, fix: { title: 'Missing sudo.', command: 'sudo apt update', source: 'ai' } });
  });

  it('reports a rejected key in the status', async () => {
    answer = () => ({ ok: false, error: { kind: 'auth', message: 'Claude rejected the API key.' } });
    const ai = service();
    const res = await ai.fix({ command: 'x', exitCode: 1, output: '', shell: 'bash', os: 'Linux', packageManager: null });
    expect(res).toEqual({ ok: false, message: 'Claude rejected the API key.' });
    expect(ai.status().lastError).toBe('Claude rejected the API key.');
  });

  it('says how to turn it on when off', async () => {
    settings.llmProvider = 'off';
    const res = await service().fix({ command: 'x', exitCode: 1, output: '', shell: 'bash', os: 'Linux', packageManager: null });
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('caches panel notes and asks once while a request is in flight', async () => {
    answer = () => ({ ok: true, value: { summary: 'Shows pods.', examples: [{ command: 'kubectl get pods', description: 'All' }] } });
    const ai = service();
    const input = { tool: 'kubectl', path: ['get'], shell: 'bash' as const, os: 'Linux', knownOptions: [] };
    const [a, b] = await Promise.all([ai.explain('linux', input), ai.explain('linux', input)]);
    expect(a).toMatchObject({ ok: true, summary: 'Shows pods.', cached: false });
    expect(b).toMatchObject({ ok: true, cached: false });
    expect(await ai.explain('linux', input)).toMatchObject({ ok: true, cached: true });
    expect(calls).toHaveLength(1);
  });

  it('describes tools in the background within the daily budget, only real programs', async () => {
    answer = (req) =>
      req.answer.name === 'save_tool_notes'
        ? { ok: true, value: { known: true, description: 'A tool', subcommands: [], options: [], examples: [] } }
        : { ok: false, error: { kind: 'other', message: 'unexpected' } };
    settings.llmDailyLimit = 1;
    const ai = service((tool) => (tool === 'myalias' ? null : `/usr/bin/${tool}`));
    ai.prefetch(env, 'bash', ['myalias', 'fd', 'rg', 'deploy.sh']);
    await new Promise((r) => setTimeout(r, 200));
    ai.dispose();
    // myalias is not a program, deploy.sh is a script name, rg is over the budget.
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain('Tool: fd');
    expect(calls[0].webSearches).toBe(3);
    expect(knowledge.description('linux', 'fd')).toBe('A tool');
    expect(ai.needsNotes(env, 'fd')).toBe(false);
  });

  it('does nothing in the background when learning is off', async () => {
    settings.llmLearn = false;
    answer = () => ({ ok: true, value: {} });
    const ai = service();
    ai.prefetch(env, 'bash', ['fd']);
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toHaveLength(0);
  });
});

describe('redactOutput', () => {
  it('masks secrets in output and hides the home folder', () => {
    const out = redactOutput(
      [
        'password: hunter22',
        '"api_key": "abcd1234efgh"',
        'export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
        '-----BEGIN RSA PRIVATE KEY-----',
        'MIIEow',
        '-----END RSA PRIVATE KEY-----',
        'open /home/ayon/project/file.txt: no such file',
      ].join('\n'),
      '/home/ayon',
    );
    expect(out).not.toMatch(/hunter22|abcd1234efgh|ghp_|MIIEow|\/home\/ayon/);
    expect(out).toContain('~/project/file.txt');
  });
});

describe('AnthropicClient (through the SDK, network replaced)', () => {
  type Sent = { url: string; body: Record<string, unknown>; headers: Headers };

  function fakeApi(responses: (() => Response)[]) {
    const sent: Sent[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
      return responses.shift()!();
    }) as typeof fetch;
    return { sent, fetchImpl };
  }
  const message = (content: unknown[], stop_reason: string) =>
    new Response(
      JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-4-5', content, stop_reason, usage: { input_tokens: 1, output_tokens: 1 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  const req: JsonRequest = {
    system: 'sys',
    prompt: 'hello',
    answer: { name: 'report_fix', description: 'd', schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false } },
    maxTokens: 100,
    webSearches: 2,
  };

  it('sends a strict answer tool and web search, and resumes a paused turn', async () => {
    const { AnthropicClient } = await import('../src/main/llm/client');
    const { sent, fetchImpl } = fakeApi([
      () => message([{ type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'x' } }], 'pause_turn'),
      () => message([{ type: 'tool_use', id: 'toolu_1', name: 'report_fix', input: { a: 'done' } }], 'tool_use'),
    ]);
    const client = new AnthropicClient('sk-ant-test-key-0123456789', 'claude-haiku-4-5', fetchImpl);
    expect(await client.json(req)).toEqual({ ok: true, value: { a: 'done' } });
    expect(sent).toHaveLength(2);
    expect(sent[0].url).toContain('/v1/messages');
    expect(sent[0].headers.get('x-api-key')).toBe('sk-ant-test-key-0123456789');
    expect(sent[0].body).toMatchObject({
      model: 'claude-haiku-4-5',
      max_tokens: 100,
      system: 'sys',
      tool_choice: { type: 'auto' },
      tools: [
        { type: 'web_search_20250305', name: 'web_search', max_uses: 2 },
        { name: 'report_fix', strict: true, input_schema: { type: 'object', additionalProperties: false } },
      ],
    });
    // The paused turn goes back as the assistant's message.
    expect((sent[1].body.messages as unknown[]).length).toBe(2);
  });

  it('maps a rejected key and a refusal', async () => {
    const { AnthropicClient } = await import('../src/main/llm/client');
    const unauthorized = () =>
      new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    let api = fakeApi([unauthorized, unauthorized]);
    expect(await new AnthropicClient('sk-ant-bad-key-0123456789', 'claude-haiku-4-5', api.fetchImpl).json(req)).toEqual({
      ok: false,
      error: { kind: 'auth', message: 'Claude rejected the API key.' },
    });
    api = fakeApi([() => message([], 'refusal')]);
    const refused = await new AnthropicClient('sk-ant-test-key-0123456789', 'claude-haiku-4-5', api.fetchImpl).json(req);
    expect(refused).toMatchObject({ ok: false, error: { kind: 'refused' } });
  });
});
