import type { CliConfig } from './config.js';

/**
 * The local model this Mac offers its runs: any server with the OpenAI chat completions API
 * on this machine. dodo does not start it; `dodo model set` only says where it is.
 */
export type LocalModelConfig = NonNullable<CliConfig['localModel']>;

/** mlx_lm.server's default port; LM Studio uses 1234, Ollama 11434. */
export const DEFAULT_LOCAL_MODEL_URL = 'http://localhost:8080/v1';

/** `http://localhost:8080` → `http://localhost:8080/v1`; a `/v1` already there stays. */
export function normaliseBaseUrl(url: string): string {
  const trimmed = url
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/, '');
  const parsed = new URL(trimmed);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`Not an http(s) URL: ${url}`);
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/** The host the worker connects to must be this Mac: the sandbox only lets it reach loopback. */
export function isLoopback(url: string): boolean {
  const host = new URL(url).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

export interface LocalModelCheck {
  ok: boolean;
  models: string[];
  /** The model called a tool when asked to: the agent can work with it. */
  toolCalls?: boolean;
  seconds?: number;
  problem?: string;
}

/**
 * Is the server up, which models does it list, and does the model call a tool when given one?
 * A model that cannot call tools can only talk, and dodo's agent works through tools.
 */
export async function checkLocalModel(
  config: LocalModelConfig,
  fetchFn: typeof fetch = fetch,
): Promise<LocalModelCheck> {
  const base = normaliseBaseUrl(config.url);
  let models: string[] = [];
  try {
    const r = await fetchFn(`${base}/models`, { signal: AbortSignal.timeout(5_000) });
    if (r.ok) {
      const body = (await r.json()) as { data?: Array<{ id?: string }> };
      models = (body.data ?? []).flatMap((m) => (m.id ? [m.id] : []));
    }
  } catch (err) {
    return {
      ok: false,
      models,
      problem: `nothing answers at ${base} (${(err as Error).message}); is the server running?`,
    };
  }
  const started = Date.now();
  try {
    const r = await fetchFn(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(300_000),
      body: JSON.stringify({
        ...(config.model ? { model: config.model } : {}),
        messages: [
          { role: 'system', content: 'You are a test. Always answer by calling a tool.' },
          { role: 'user', content: 'Set the status to "hello".' },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'set_status',
              description: 'Set the task status line',
              parameters: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text'],
              },
            },
          },
        ],
        max_tokens: 200,
        temperature: 0,
        stream: false,
      }),
    });
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    if (!r.ok) {
      const detail = (await r.text().catch(() => '')).slice(0, 300);
      return { ok: false, models, seconds, problem: `HTTP ${r.status}: ${detail}` };
    }
    const body = (await r.json()) as {
      choices?: Array<{ message?: { content?: string | null; tool_calls?: unknown[] } }>;
    };
    const msg = body.choices?.[0]?.message;
    const toolCalls = !!msg?.tool_calls?.length || /<tool_call>/.test(msg?.content ?? '');
    return { ok: true, models, toolCalls, seconds };
  } catch (err) {
    return { ok: false, models, problem: (err as Error).message };
  }
}
