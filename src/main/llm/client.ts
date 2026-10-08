import Anthropic from '@anthropic-ai/sdk';

/** A JSON schema for an object (the shape of an answer). */
export type ObjectSchema = { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: false };

export interface JsonRequest {
  system: string;
  prompt: string;
  /** The answer comes back as the input of this tool (strict schema), so it is always parseable JSON. */
  answer: { name: string; description: string; schema: ObjectSchema };
  maxTokens: number;
  /** Allow up to this many web searches (Claude only). */
  webSearches?: number;
  timeoutMs?: number;
}

export interface LlmError {
  kind: 'auth' | 'rate' | 'network' | 'refused' | 'empty' | 'other';
  message: string;
}

export type JsonResponse = { ok: true; value: unknown } | { ok: false; error: LlmError };

export interface LlmClient {
  /** For messages: "Claude (claude-haiku-4-5)". */
  readonly label: string;
  /** Identifies the model in caches, so answers from another model are asked again. */
  readonly model: string;
  readonly canSearch: boolean;
  json(req: JsonRequest): Promise<JsonResponse>;
}

/** A server-side web search can pause a long turn; it is resumed this many times at most. */
const MAX_CONTINUATIONS = 3;

export class AnthropicClient implements LlmClient {
  readonly canSearch = true;
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    readonly model: string,
    /** Tests replace the network. */
    fetchImpl?: typeof fetch,
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 1, timeout: 90_000, fetch: fetchImpl });
  }

  get label(): string {
    return `Claude (${this.model})`;
  }

  async json(req: JsonRequest): Promise<JsonResponse> {
    const tools: Anthropic.ToolUnion[] = [];
    if (req.webSearches) tools.push({ type: 'web_search_20250305', name: 'web_search', max_uses: req.webSearches });
    tools.push({ name: req.answer.name, description: req.answer.description, strict: true, input_schema: req.answer.schema });
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: req.prompt }];
    try {
      for (let turn = 0; turn <= MAX_CONTINUATIONS; turn++) {
        const response = await this.client.messages.create(
          { model: this.model, max_tokens: req.maxTokens, system: req.system, messages, tools, tool_choice: { type: 'auto' } },
          req.timeoutMs ? { timeout: Math.round(req.timeoutMs) } : undefined,
        );
        if (response.stop_reason === 'refusal') return fail('refused', 'The AI declined to answer this.');
        if (response.stop_reason === 'max_tokens') return fail('empty', 'The answer was cut off.');
        const answer = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === req.answer.name);
        if (answer) return { ok: true, value: answer.input };
        if (response.stop_reason !== 'pause_turn') break;
        // The server paused its search loop: send the turn back and it continues where it stopped.
        messages.push({ role: 'assistant', content: response.content });
      }
      return fail('empty', 'The AI gave no usable answer.');
    } catch (err) {
      return { ok: false, error: classify(err, this.model) };
    }
  }
}

function classify(err: unknown, model: string): LlmError {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return { kind: 'auth', message: 'Claude rejected the API key.' };
  }
  if (err instanceof Anthropic.RateLimitError) return { kind: 'rate', message: 'Claude is rate limiting requests; try again shortly.' };
  if (err instanceof Anthropic.NotFoundError) return { kind: 'other', message: `Claude does not know the model "${model}".` };
  if (err instanceof Anthropic.APIConnectionError) return { kind: 'network', message: 'Could not reach Claude (offline?).' };
  if (err instanceof Anthropic.APIError) return { kind: 'other', message: `Claude API error ${err.status ?? ''}`.trim() };
  return { kind: 'other', message: err instanceof Error ? err.message : String(err) };
}

/** A local model served by Ollama (`/api/chat` with a JSON schema as the output format). No web access. */
export class OllamaClient implements LlmClient {
  readonly canSearch = false;

  constructor(
    private readonly baseUrl: string,
    readonly model: string,
  ) {}

  get label(): string {
    return `Ollama (${this.model})`;
  }

  async json(req: JsonRequest): Promise<JsonResponse> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          format: req.answer.schema,
          options: { temperature: 0.2, num_predict: req.maxTokens },
          messages: [
            { role: 'system', content: `${req.system}\n\nReply only with JSON for ${req.answer.name}: ${req.answer.description}` },
            { role: 'user', content: req.prompt },
          ],
        }),
        signal: AbortSignal.timeout(req.timeoutMs ?? 120_000),
      });
    } catch {
      return fail('network', `Could not reach Ollama at ${this.baseUrl}.`);
    }
    if (res.status === 404) return fail('other', `Ollama has no model "${this.model}" (ollama pull ${this.model}).`);
    if (!res.ok) return fail('other', `Ollama error ${res.status}.`);
    try {
      const body = (await res.json()) as { message?: { content?: string } };
      return { ok: true, value: JSON.parse(body.message?.content ?? '') };
    } catch {
      return fail('empty', 'The local model did not answer with JSON.');
    }
  }
}

function fail(kind: LlmError['kind'], message: string): JsonResponse {
  return { ok: false, error: { kind, message } };
}
