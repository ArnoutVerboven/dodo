import type { Content, Part } from '@dodo/core';
import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ToolResultMessage,
  UserMessage,
} from '@earendil-works/pi-ai';

/**
 * pi keeps its conversation as its own messages; dodo stores a run's conversation as Gemini
 * contents, which every harness, the idle Compact button and a resume read. These two turn one
 * into the other, so a task can move between harnesses without starting over.
 */

const ZERO_USAGE: AssistantMessage['usage'] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as AssistantMessage['usage'];

/** A tool's response as the text pi hands the model: the JSON dodo's own loop would send. */
export const responseText = (response: Record<string, unknown>) => JSON.stringify(response);

/** The response object again: dodo's JSON as it was, anything else as `{ output }`. */
function responseObject(content: ToolResultMessage['content'], isError: boolean) {
  const text = content
    .filter((c): c is TextContent => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {}
  return isError ? { error: text } : { output: text };
}

/** Stored Gemini contents as pi messages, for a resumed or continued run. */
export function toPiMessages(contents: Content[], model: string): Message[] {
  const out: Message[] = [];
  // Gemini may leave out call ids; pi needs them, so unnamed calls get one and their
  // responses take them in order.
  const open: Array<{ id: string; name: string }> = [];
  let n = 0;
  const now = Date.now();
  for (const c of contents) {
    if (c.role === 'model') {
      const content: AssistantMessage['content'] = [];
      for (const p of c.parts) {
        if (p.functionCall) {
          const id = p.functionCall.id ?? `call_${n++}`;
          open.push({ id, name: p.functionCall.name });
          content.push({
            type: 'toolCall',
            id,
            name: p.functionCall.name,
            arguments: (p.functionCall.args ?? {}) as Record<string, never>,
            ...(p.thoughtSignature ? { thoughtSignature: p.thoughtSignature } : {}),
          });
        } else if (p.text !== undefined && p.thought) {
          content.push({
            type: 'thinking',
            thinking: p.text,
            ...(p.thoughtSignature ? { thinkingSignature: p.thoughtSignature } : {}),
          });
        } else if (p.text) {
          content.push({ type: 'text', text: p.text });
        }
      }
      if (!content.length) continue;
      out.push({
        role: 'assistant',
        content,
        api: 'google-generative-ai',
        provider: 'google',
        model,
        usage: ZERO_USAGE,
        stopReason: content.some((x) => x.type === 'toolCall') ? 'toolUse' : 'stop',
        timestamp: now,
      } as AssistantMessage);
      continue;
    }
    const texts: Array<TextContent | ImageContent> = [];
    for (const p of c.parts) {
      const fr = p.functionResponse;
      if (fr) {
        const at = fr.id
          ? open.findIndex((o) => o.id === fr.id)
          : open.findIndex((o) => o.name === fr.name);
        const call = at >= 0 ? open.splice(at, 1)[0] : undefined;
        out.push({
          role: 'toolResult',
          toolCallId: call?.id ?? fr.id ?? `call_${n++}`,
          toolName: fr.name,
          content: [{ type: 'text', text: responseText(fr.response) }],
          isError: 'error' in fr.response,
          timestamp: now,
        } as ToolResultMessage);
      } else if (p.text) {
        texts.push({ type: 'text', text: p.text });
      } else if (isInline(p)) {
        texts.push({ type: 'image', mimeType: p.inlineData.mimeType, data: p.inlineData.data });
      }
    }
    if (texts.length) out.push({ role: 'user', content: texts, timestamp: now } as UserMessage);
  }
  return out;
}

function isInline(p: Part): p is Part & { inlineData: { mimeType: string; data: string } } {
  const d = (p as { inlineData?: { mimeType?: unknown; data?: unknown } }).inlineData;
  return typeof d?.mimeType === 'string' && typeof d.data === 'string';
}

/** pi's conversation (as `convertToLlm` gives it) as Gemini contents to store. */
export function toGeminiContents(messages: Message[]): Content[] {
  const out: Content[] = [];
  const push = (role: Content['role'], parts: Part[]) => {
    if (!parts.length) return;
    const last = out.at(-1);
    // Gemini wants turns to alternate; pi keeps a tool result and a note as two messages.
    if (last?.role === role) last.parts.push(...parts);
    else out.push({ role, parts });
  };
  for (const m of messages) {
    if (m.role === 'user') {
      const parts: Part[] =
        typeof m.content === 'string'
          ? [{ text: m.content }]
          : m.content.map((c) =>
              c.type === 'text'
                ? { text: c.text }
                : ({ inlineData: { mimeType: c.mimeType, data: c.data } } as Part),
            );
      push('user', parts);
    } else if (m.role === 'assistant') {
      // A failed or cut-off call adds nothing the next one can build on.
      if (m.stopReason === 'error' || m.stopReason === 'aborted') continue;
      const parts: Part[] = [];
      for (const c of m.content) {
        if (c.type === 'text' && c.text) parts.push({ text: c.text });
        else if (c.type === 'thinking' && c.thinking && !c.redacted) {
          parts.push({
            text: c.thinking,
            thought: true,
            ...(c.thinkingSignature ? { thoughtSignature: c.thinkingSignature } : {}),
          });
        } else if (c.type === 'toolCall') {
          parts.push({
            functionCall: { id: c.id, name: c.name, args: c.arguments as Record<string, unknown> },
            ...(c.thoughtSignature ? { thoughtSignature: c.thoughtSignature } : {}),
          });
        }
      }
      push('model', parts);
    } else if (m.role === 'toolResult') {
      push('user', [
        {
          functionResponse: {
            id: m.toolCallId,
            name: m.toolName,
            response: responseObject(m.content, m.isError),
          },
        },
      ]);
    }
  }
  return out;
}
