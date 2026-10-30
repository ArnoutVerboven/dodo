import type {
  FunctionDeclaration,
  GenerateRequest,
  GenerateResponse,
  HeartbeatResponse,
  Part,
} from '@dodo/core';
import type { ControlPlane } from './control-plane.js';

/**
 * The local model on a Mac, spoken to over the OpenAI chat completions API that mlx_lm.server,
 * LM Studio, Ollama and llama.cpp's server all offer. The session stays in Gemini's shape
 * (that is what the rest of dodo stores); this file translates it both ways.
 */

export interface LocalModelConfig {
  /** Base URL of the server, e.g. `http://localhost:8080/v1`. */
  url: string;
  /** The model name to ask the server for; some servers serve only one and ignore it. */
  model?: string;
  /** Per-call timeout; a 30B model on a laptop can take minutes for a long prompt. */
  timeoutMs?: number;
}

interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ChatRequest {
  model?: string;
  messages: ChatMessage[];
  tools?: Array<{
    type: 'function';
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }>;
  max_tokens?: number;
  temperature?: number;
  stream: false;
}

interface ChatResponse {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string | Record<string, unknown> };
      }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const IMAGE_NOTE = '[an image was here; the local model cannot see images]';

function partText(p: Part): string | undefined {
  if (p.thought) return undefined;
  if (p.text) return p.text;
  if ((p as { inlineData?: unknown }).inlineData || (p as { fileData?: unknown }).fileData)
    return IMAGE_NOTE;
  return undefined;
}

/** The conversation as chat messages: function calls and responses become tool calls. */
export function toChatRequest(
  req: Omit<GenerateRequest, 'runId'>,
  model: string | undefined,
): ChatRequest {
  const messages: ChatMessage[] = [];
  if (req.systemInstruction) messages.push({ role: 'system', content: req.systemInstruction });
  // Ids of the last assistant turn's calls not yet answered, by name, for responses without one.
  let open: Array<{ id: string; name: string }> = [];
  req.contents.forEach((c, turn) => {
    if (c.role === 'model') {
      const text = c.parts
        .map(partText)
        .filter((t): t is string => !!t)
        .join('');
      const calls = c.parts.flatMap((p, i) =>
        p.functionCall
          ? [
              {
                id: p.functionCall.id || `call_${turn}_${i}`,
                type: 'function' as const,
                function: {
                  name: p.functionCall.name,
                  arguments: JSON.stringify(p.functionCall.args ?? {}),
                },
              },
            ]
          : [],
      );
      open = calls.map((t) => ({ id: t.id, name: t.function.name }));
      messages.push({
        role: 'assistant',
        content: text || (calls.length ? null : ''),
        ...(calls.length ? { tool_calls: calls } : {}),
      });
      return;
    }
    const texts: string[] = [];
    for (const p of c.parts) {
      const r = p.functionResponse;
      if (r) {
        const at = r.id
          ? open.findIndex((o) => o.id === r.id)
          : open.findIndex((o) => o.name === r.name);
        const id = r.id ?? open[at]?.id ?? `call_${turn}_${r.name}`;
        if (at >= 0) open.splice(at, 1);
        messages.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(r.response) });
        continue;
      }
      const t = partText(p);
      if (t) texts.push(t);
    }
    if (texts.length) messages.push({ role: 'user', content: texts.join('\n\n') });
  });
  return {
    ...(model ? { model } : {}),
    messages,
    ...(req.tools?.length ? { tools: req.tools.map(toChatTool) } : {}),
    max_tokens: req.maxOutputTokens ?? 8192,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    stream: false,
  };
}

function toChatTool(d: FunctionDeclaration) {
  return {
    type: 'function' as const,
    function: {
      name: d.name,
      description: d.description,
      parameters: d.parametersJsonSchema ??
        d.parameters ?? { type: 'object', properties: {} as Record<string, unknown> },
    },
  };
}

const TOOL_CALL_BLOCK = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
const THINK_BLOCK = /<think>([\s\S]*?)<\/think>/g;

function parseArgs(raw: string | Record<string, unknown> | undefined): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    // The loop validates arguments against the tool's schema and tells the model what is wrong.
    return { _unparsed: raw };
  }
}

/**
 * The reply as a Gemini model turn. Qwen-style `<tool_call>{…}</tool_call>` blocks left in the
 * text (a server without a tool-call parser for the model) count as calls too, and `<think>`
 * blocks become thought parts that are never shown or sent back.
 */
export function fromChatResponse(
  res: ChatResponse,
  callPrefix: string,
): Omit<GenerateResponse, 'cost' | 'remaining'> {
  const choice = res.choices?.[0];
  const msg = choice?.message ?? {};
  const parts: Part[] = [];
  let text = msg.content ?? '';
  const reasoning = msg.reasoning_content ?? msg.reasoning;
  if (reasoning) parts.push({ text: reasoning, thought: true });
  text = text.replace(THINK_BLOCK, (_, t: string) => {
    if (t.trim()) parts.push({ text: t.trim(), thought: true });
    return '';
  });
  const inline: Array<{ name: string; args: Record<string, unknown> }> = [];
  text = text.replace(TOOL_CALL_BLOCK, (block, body: string) => {
    try {
      const v = JSON.parse(body) as { name?: string; arguments?: unknown };
      if (typeof v.name !== 'string') return block;
      inline.push({
        name: v.name,
        args: parseArgs(v.arguments as string | Record<string, unknown> | undefined),
      });
      return '';
    } catch {
      return block;
    }
  });
  text = text.trim();
  if (text) parts.push({ text });
  let n = 0;
  for (const tc of msg.tool_calls ?? []) {
    const name = tc.function?.name;
    if (!name) continue;
    parts.push({
      functionCall: {
        id: tc.id || `${callPrefix}_${n++}`,
        name,
        args: parseArgs(tc.function?.arguments),
      },
    });
  }
  for (const c of inline)
    parts.push({ functionCall: { id: `${callPrefix}_${n++}`, name: c.name, args: c.args } });
  const inputTokens = res.usage?.prompt_tokens ?? 0;
  const outputTokens = res.usage?.completion_tokens ?? 0;
  return {
    content: { role: 'model', parts: parts.length ? parts : [{ text: '' }] },
    finishReason: choice?.finish_reason ?? undefined,
    usage: { inputTokens, outputTokens, thinkingTokens: 0, cachedInputTokens: 0 },
  };
}

/** `http://localhost:8080` and `…/v1` both work; the path is added when missing. */
export function chatCompletionsUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  return /\/v\d+$/.test(trimmed) ? `${trimmed}/chat/completions` : `${trimmed}/v1/chat/completions`;
}

/** One call to the local server; errors say where it went and what came back. */
export async function generateLocal(
  config: LocalModelConfig,
  req: Omit<GenerateRequest, 'runId'>,
  fetchFn: typeof fetch = fetch,
  callPrefix = `call_${Date.now().toString(36)}`,
): Promise<Omit<GenerateResponse, 'cost' | 'remaining'>> {
  const url = chatCompletionsUrl(config.url);
  const body = toChatRequest(req, config.model);
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs ?? 10 * 60_000),
    });
  } catch (err) {
    throw new Error(
      `The local model at ${config.url} did not answer (${(err as Error).message}). Is the server running on this Mac? See \`dodo model\`.`,
    );
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 500);
    throw new Error(`The local model at ${config.url} answered HTTP ${res.status}: ${detail}`);
  }
  return fromChatResponse((await res.json()) as ChatResponse, callPrefix);
}

/**
 * The control plane for a run on the local model: model calls go to the Mac's own server and
 * cost nothing; everything else (heartbeat, questions, the end of the run) is the usual one.
 */
export class LocalModelControlPlane implements ControlPlane {
  private remaining = 0;
  private calls = 0;
  constructor(
    private readonly inner: ControlPlane,
    private readonly config: LocalModelConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}
  async generate(req: Omit<GenerateRequest, 'runId'>): Promise<GenerateResponse> {
    const r = await generateLocal(
      this.config,
      req,
      this.fetchFn,
      `call_${Date.now().toString(36)}_${++this.calls}`,
    );
    return { ...r, cost: 0, remaining: this.remaining };
  }
  async heartbeat(): Promise<HeartbeatResponse> {
    const r = await this.inner.heartbeat();
    this.remaining = r.remaining;
    return r;
  }
  requestInput(req: Parameters<ControlPlane['requestInput']>[0]) {
    return this.inner.requestInput(req);
  }
  finish(req: Parameters<ControlPlane['finish']>[0]) {
    return this.inner.finish(req);
  }
}
