import { COMPACTED_HEADER } from './prompts.js';
import type { Content, FunctionDeclaration } from './run.js';
import { BUILTIN_TOOLS, GROUPS } from './tools.js';

/**
 * What the context is made of, for the task view's breakdown. Gemini reports one total for a
 * call; the split between system prompt, tools and conversation is estimated from their size
 * and scaled so the parts add up to that measured total.
 */
export interface ContextPart {
  /** `system`, `tools`, `conversation` or `reply`: the section the part is listed under. */
  kind: 'system' | 'tools' | 'conversation' | 'reply';
  label: string;
  tokens: number;
}

/** Gemini bills an image as a fixed number of tokens, whatever its size in base64. */
const IMAGE_TOKENS = 1_100;

const GROUP_OF = new Map(BUILTIN_TOOLS.map((t) => [t.name, t.group]));

/** The toolset a declaration came from: a built-in group, or the MCP server it proxies. */
export function toolsetLabel(name: string): string {
  const mcp = /^mcp__(.+?)__/.exec(name);
  if (mcp) return `MCP: ${mcp[1]}`;
  const group = GROUP_OF.get(name) ?? (name.startsWith('browser_') ? 'browser' : undefined);
  return group ? GROUPS[group].label : 'Other tools';
}

/**
 * Splits a model call's context into parts. `promptTokens` is the measured input; `replyTokens`
 * the reply that joins the conversation (the task's Context figure counts both).
 */
export function contextBreakdown(
  req: { systemInstruction?: string; tools?: FunctionDeclaration[]; contents: Content[] },
  promptTokens: number,
  replyTokens = 0,
): ContextPart[] {
  // Weights in characters (images in tokens, turned to characters at about 4 a token).
  const weights = new Map<string, { kind: ContextPart['kind']; label: string; w: number }>();
  const add = (kind: ContextPart['kind'], label: string, w: number) => {
    if (w <= 0) return;
    const key = `${kind}:${label}`;
    const e = weights.get(key);
    if (e) e.w += w;
    else weights.set(key, { kind, label, w });
  };
  add('system', 'System prompt', req.systemInstruction?.length ?? 0);
  for (const t of req.tools ?? []) add('tools', toolsetLabel(t.name), JSON.stringify(t).length);
  req.contents.forEach((c, i) => {
    for (const p of c.parts) {
      const raw = p as Record<string, unknown>;
      if (raw.inlineData || raw.fileData) add('conversation', 'Images', IMAGE_TOKENS * 4);
      if (p.functionResponse)
        add('conversation', 'Tool results', JSON.stringify(p.functionResponse).length);
      if (p.functionCall) add('conversation', 'Tool calls', JSON.stringify(p.functionCall).length);
      if (!p.text) continue;
      if (c.role === 'model')
        add('conversation', p.thought ? 'Agent thinking' : 'Agent replies', p.text.length);
      else if (i === 0 && p.text.startsWith(COMPACTED_HEADER))
        add('conversation', 'Summary (compacted)', p.text.length);
      else if (i === 0) add('conversation', 'Task and thread', p.text.length);
      else add('conversation', 'Your messages and answers', p.text.length);
    }
  });
  const total = [...weights.values()].reduce((s, e) => s + e.w, 0);
  const parts: ContextPart[] = [...weights.values()].map((e) => ({
    kind: e.kind,
    label: e.label,
    tokens: total ? Math.round((e.w / total) * promptTokens) : 0,
  }));
  if (replyTokens > 0) parts.push({ kind: 'reply', label: 'Latest reply', tokens: replyTokens });
  return parts.filter((p) => p.tokens > 0);
}
