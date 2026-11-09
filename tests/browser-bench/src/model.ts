/**
 * The model every approach gets, over the OpenAI chat completions API: your local model
 * (mlx_lm.server, LM Studio, Ollama, llama.cpp) or Gemini through its OpenAI-compatible
 * endpoint. Token counts come from the server's own usage numbers, so they use that model's
 * tokenizer.
 */

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /**
   * Provider data to send back with the call. Gemini 3 returns a thought signature here
   * (`extra_content.google.thought_signature`) and refuses the next request without it.
   */
  extra?: Record<string, unknown>;
}

export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
        extra_content?: Record<string, unknown>;
      }>;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface Usage {
  input: number;
  output: number;
  cached: number;
  /** True when the server gave no usage and the bench estimated it from characters. */
  estimated: boolean;
}

export interface ModelReply {
  text: string;
  calls: ToolCall[];
  usage: Usage;
}

export interface Model {
  name: string;
  chat(messages: Message[], tools: ToolSpec[]): Promise<ModelReply>;
}

/** Characters / 4: rough, used only when a server reports no usage (and for the fake model). */
export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

export function openAiModel(opts: {
  url: string;
  model: string;
  /** A key, or a function giving the current one (short-lived gcloud tokens). */
  apiKey?: string | (() => string | undefined);
  timeoutMs?: number;
  temperature?: number;
}): Model {
  const endpoint = `${opts.url.replace(/\/$/, '')}/chat/completions`;
  return {
    name: opts.model,
    async chat(messages, tools) {
      const body = {
        model: opts.model,
        messages,
        tools: tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
        temperature: opts.temperature ?? 0,
        stream: false,
      };
      const key = typeof opts.apiKey === 'function' ? opts.apiKey() : opts.apiKey;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 600_000),
      });
      if (!res.ok) throw new Error(`model ${res.status}: ${(await res.text()).slice(0, 500)}`);
      const json = (await res.json()) as {
        choices?: Array<{
          message?: {
            content?: string | null;
            tool_calls?: Array<{
              id?: string;
              function?: { name?: string; arguments?: string | Record<string, unknown> };
              extra_content?: Record<string, unknown>;
            }>;
          };
        }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
        };
      };
      const msg = json.choices?.[0]?.message ?? {};
      const calls: ToolCall[] = (msg.tool_calls ?? []).map((c, i) => {
        const raw = c.function?.arguments ?? {};
        let args: Record<string, unknown> = {};
        try {
          args = typeof raw === 'string' ? (raw.trim() ? JSON.parse(raw) : {}) : raw;
        } catch {
          args = { _unparsed: raw };
        }
        return {
          id: c.id || `call_${Date.now()}_${i}`,
          name: c.function?.name ?? '',
          args,
          ...(c.extra_content ? { extra: c.extra_content } : {}),
        };
      });
      const u = json.usage;
      const usage: Usage = u?.prompt_tokens
        ? {
            input: u.prompt_tokens,
            output: u.completion_tokens ?? 0,
            cached: u.prompt_tokens_details?.cached_tokens ?? 0,
            estimated: false,
          }
        : {
            input: estimateTokens(JSON.stringify(body.messages) + JSON.stringify(body.tools)),
            output: estimateTokens(JSON.stringify(msg)),
            cached: 0,
            estimated: true,
          };
      return { text: msg.content ?? '', calls, usage };
    },
  };
}

/**
 * A scripted stand-in for a model, for checking the bench offline: it clicks the labels it is
 * given in order, finding each one's ref in the latest page text, takes a snapshot when it
 * has no page text to look at, types the search when asked, and calls done at the end. It
 * makes no decisions, so its numbers measure the plumbing and page sizes, not quality.
 */
export function scriptedModel(steps: Array<{ click: string } | { search: string }>): Model {
  return {
    name: 'scripted',
    async chat(messages, tools) {
      const usage: Usage = {
        input: estimateTokens(JSON.stringify(messages) + JSON.stringify(tools)),
        output: 30,
        cached: 0,
        estimated: true,
      };
      const names = new Set(tools.map((t) => t.name));
      const done = messages.filter(
        (m) => m.role === 'assistant' && m.tool_calls?.some((c) => isAction(c.function.name)),
      ).length;
      const call = (name: string, args: Record<string, unknown>): ModelReply => ({
        text: '',
        calls: [{ id: `c${messages.length}`, name, args }],
        usage,
      });
      if (!messages.some((m) => m.role === 'tool')) {
        const first = messages.find((m) => m.role === 'user');
        const start = first ? /Start page: (\S+)/.exec(first.content)?.[1] : undefined;
        return call(names.has('browser_navigate') ? 'browser_navigate' : 'open', { url: start });
      }
      const step = steps[done];
      if (!step) return call('done', { success: true, note: 'script finished' });
      const page = lastPage(messages);
      const label = 'click' in step ? step.click : 'Search for items';
      const ref = page ? refFor(page, label) : undefined;
      if (!ref) {
        const look = ['browser_snapshot', 'snapshot', 'browser_find'].find((n) => names.has(n));
        if (look === 'browser_find' && page !== undefined) return call(look, { text: label });
        if (look && look !== 'browser_find') return call(look, {});
        return call('done', { success: false, note: `no ref for ${label}` });
      }
      if ('click' in step)
        return call(names.has('browser_click') ? 'browser_click' : 'click', {
          element: label,
          target: ref,
          ref,
        });
      return call(names.has('browser_type') ? 'browser_type' : 'fill', {
        element: label,
        target: ref,
        ref,
        text: step.search,
        submit: true,
      });
    },
  };
}

const isAction = (n: string) =>
  /click|type|fill|^browser_press_key$|^press$|^browser_select_option$/.test(n);

function lastPage(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'tool' && /\[ref=|@e\d+/.test(m.content)) return m.content;
    if (m.role === 'assistant' && m.tool_calls?.some((c) => isAction(c.function.name))) return '';
  }
  return undefined;
}

function refFor(page: string, label: string): string | undefined {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const line = page.split('\n').find((l) => new RegExp(`"${esc}"`).test(l) && /ref=|@e\d+/.test(l));
  const m = line && /ref=(f?\d*e\d+)|(@e\d+)/.exec(line);
  return m ? (m[1] ?? m[2]) : undefined;
}
