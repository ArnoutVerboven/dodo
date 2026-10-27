import type { Content, FunctionDeclaration, Usage } from '@dodo/core';
import { GoogleGenAI } from '@google/genai';

/** The one place that talks to Gemini. Everything else goes through the gateway. */
export interface ModelRequest {
  model: string;
  systemInstruction?: string;
  contents: Content[];
  tools?: FunctionDeclaration[];
  maxOutputTokens: number;
  thinkingBudget?: number;
  temperature?: number;
}

export interface ModelResult {
  content: Content;
  finishReason?: string;
  usage: Usage;
}

export interface ModelProvider {
  countTokens(
    req: Pick<ModelRequest, 'model' | 'contents' | 'systemInstruction' | 'tools'>,
  ): Promise<number>;
  generate(req: ModelRequest): Promise<ModelResult>;
}

export class VertexProvider implements ModelProvider {
  private readonly ai: GoogleGenAI;
  constructor(project: string, location: string) {
    this.ai = new GoogleGenAI({ vertexai: true, project, location });
  }

  async countTokens(req: Pick<ModelRequest, 'model' | 'contents' | 'systemInstruction' | 'tools'>) {
    const r = await this.ai.models.countTokens({ model: req.model, contents: req.contents });
    // countTokens ignores system instruction and tools; add a conservative estimate for them.
    const extra = Math.ceil(
      ((req.systemInstruction?.length ?? 0) + JSON.stringify(req.tools ?? []).length) / 3,
    );
    return (r.totalTokens ?? 0) + extra;
  }

  async generate(req: ModelRequest): Promise<ModelResult> {
    const r = await this.ai.models.generateContent({
      model: req.model,
      contents: req.contents,
      config: {
        systemInstruction: req.systemInstruction,
        tools: req.tools?.length ? [{ functionDeclarations: req.tools }] : undefined,
        maxOutputTokens: req.maxOutputTokens,
        temperature: req.temperature,
        thinkingConfig:
          req.thinkingBudget !== undefined ? { thinkingBudget: req.thinkingBudget } : undefined,
      },
    });
    const candidate = r.candidates?.[0];
    const parts = (candidate?.content?.parts ?? []).map((p) => ({ ...p })) as Content['parts'];
    const u = r.usageMetadata;
    return {
      content: { role: 'model', parts: parts.length ? parts : [{ text: '' }] },
      finishReason: candidate?.finishReason ? String(candidate.finishReason) : undefined,
      usage: {
        inputTokens: u?.promptTokenCount ?? 0,
        outputTokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
        thinkingTokens: u?.thoughtsTokenCount ?? 0,
        cachedInputTokens: u?.cachedContentTokenCount ?? 0,
      },
    };
  }
}

/**
 * Deterministic stand-in for the emulator and tests: no network, no cost. It follows a tiny
 * script so an end-to-end run exercises every tool: status → summary → message → finish.
 */
export class FakeProvider implements ModelProvider {
  async countTokens(req: Pick<ModelRequest, 'contents'>) {
    return Math.ceil(JSON.stringify(req.contents).length / 4);
  }
  async generate(req: ModelRequest): Promise<ModelResult> {
    const turns = req.contents.filter((c) => c.role === 'model').length;
    const lastUser =
      req.contents
        .at(-1)
        ?.parts.map((p) => p.text ?? '')
        .join(' ') ?? '';
    const call = (name: string, args: Record<string, unknown>) => ({
      functionCall: { name, args },
    });
    let parts: Content['parts'];
    const transcript = JSON.stringify(req.contents);
    const wantsFetch = /fetch http/i.test(transcript);
    // "Run: <command>" in the task runs it with the bash tool; the output goes into the summary
    // so a test can see what the sandbox let through.
    const firstUser = req.contents[0]?.parts.map((p) => p.text ?? '').join(' ') ?? '';
    const wantsRun = /Run: (.+)/.exec(firstUser)?.[1]?.trim();
    const ran = req.contents
      .flatMap((c) => c.parts)
      .map((p) => p.functionResponse)
      .find((r) => r?.name === 'bash');
    if (!req.tools?.length) {
      parts = [{ text: `Fake title for ${lastUser.slice(0, 30)}` }];
    } else if (/ask me|question/i.test(lastUser) && turns === 0) {
      parts = [
        call('ask_user', {
          kind: 'choice',
          prompt: 'Fake model: which option?',
          options: ['A', 'B'],
        }),
      ];
    } else if (
      wantsFetch &&
      !/"status":\d+|"text":"[^"]*fetched/.test(transcript) &&
      !/Not allowed/.test(transcript)
    ) {
      // Keeps asking for the fetch until it ran (approval flow) or was denied.
      const url =
        /fetch (https?:\/\/\S+)/i.exec(transcript)?.[1]?.replace(/[\\"']+$/, '') ??
        'https://example.com/';
      parts = [call('http_fetch', { url })];
    } else if (turns === 0) {
      parts = [
        call('set_status', { text: 'Fake model: reading the task', nextAction: 'write summary' }),
      ];
    } else if (wantsRun && !ran) {
      parts = [call('bash', { command: wantsRun })];
    } else if (turns === 1 || ((wantsFetch || wantsRun) && turns === 2)) {
      const output = ran ? `\n\nOutput:\n\`\`\`\n${JSON.stringify(ran.response)}\n\`\`\`` : '';
      parts = [
        call('update_summary', {
          markdown: `## Fake summary\n\nThe fake model read: ${lastUser.slice(0, 80)}${output}`,
        }),
        call('post_message', { body: 'Fake model here. This run used no real tokens.' }),
      ];
    } else {
      parts = [
        call('set_status', { text: 'Done (fake)', needsYou: false }),
        call('finish', { outcome: 'done' }),
      ];
    }
    const inputTokens = await this.countTokens(req);
    return {
      content: { role: 'model', parts },
      finishReason: 'STOP',
      usage: { inputTokens, outputTokens: 50, thinkingTokens: 0, cachedInputTokens: 0 },
    };
  }
}
