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

/** A grounded search: one Gemini call with Google Search as its only tool. */
export interface SearchRequest {
  model: string;
  query: string;
  maxOutputTokens: number;
}

export interface SearchResult {
  answer: string;
  sources: Array<{ title: string; url: string }>;
  /** The queries Google ran for it; Gemini 3 bills each one when a source is cited. */
  queries: string[];
  usage: Usage;
}

export interface SearchProvider {
  search(req: SearchRequest): Promise<SearchResult>;
}

/** Push-to-talk: one Gemini call with the voice note as audio input, returning its words. */
export interface TranscribeRequest {
  model: string;
  /** Base64 audio. */
  audio: string;
  mimeType: string;
  language?: string;
  maxOutputTokens: number;
}

export interface TranscribeResult {
  text: string;
  usage: Usage;
}

export interface TranscribeProvider {
  transcribe(req: TranscribeRequest): Promise<TranscribeResult>;
}

const TRANSCRIBE_SYSTEM =
  'You transcribe voice notes that someone dictates into a task app: a new task or a reply to an agent. Write down what they say, in the language they speak, with punctuation and paragraphs where they pause. Leave out filler words (uh, um, euh) and false starts, but do not summarise, translate, answer or add anything. If there is no speech, return an empty response.';

const SEARCH_SYSTEM =
  'You are a web search tool for another agent. Search the web and answer the query with the facts the sources give: concise, specific (names, numbers, dates, prices, addresses), and say when sources disagree or nothing relevant was found. No preamble, no follow-up questions.';

export class VertexProvider implements ModelProvider, SearchProvider, TranscribeProvider {
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

  async transcribe(req: TranscribeRequest): Promise<TranscribeResult> {
    // Gemini wants the bare type: `audio/webm;codecs=opus` → `audio/webm`.
    const mimeType = req.mimeType.split(';')[0]?.trim() || 'audio/webm';
    const hint = req.language ? ` The speaker's device language is ${req.language}.` : '';
    const r = await this.ai.models.generateContent({
      model: req.model,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType, data: req.audio } },
            { text: `Transcribe this voice note.${hint}` },
          ],
        },
      ],
      config: {
        systemInstruction: TRANSCRIBE_SYSTEM,
        maxOutputTokens: req.maxOutputTokens,
        temperature: 0,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    const candidate = r.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join('')
      .trim();
    const u = r.usageMetadata;
    return {
      text,
      usage: {
        inputTokens: u?.promptTokenCount ?? 0,
        outputTokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
        thinkingTokens: u?.thoughtsTokenCount ?? 0,
        cachedInputTokens: u?.cachedContentTokenCount ?? 0,
      },
    };
  }

  async search(req: SearchRequest): Promise<SearchResult> {
    const r = await this.ai.models.generateContent({
      model: req.model,
      contents: [{ role: 'user', parts: [{ text: req.query }] }],
      config: {
        systemInstruction: SEARCH_SYSTEM,
        tools: [{ googleSearch: {} }],
        maxOutputTokens: req.maxOutputTokens,
        temperature: 0.2,
        // Thinking would come out of the same small output allowance; a lookup needs none.
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    const candidate = r.candidates?.[0];
    const answer = (candidate?.content?.parts ?? [])
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join('');
    const meta = candidate?.groundingMetadata;
    const seen = new Set<string>();
    const sources = (meta?.groundingChunks ?? []).flatMap((c) => {
      const url = c.web?.uri;
      if (!url || seen.has(url)) return [];
      seen.add(url);
      return [{ title: c.web?.title || c.web?.domain || url, url }];
    });
    const u = r.usageMetadata;
    return {
      answer,
      sources,
      queries: meta?.webSearchQueries ?? [],
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
export class FakeProvider implements ModelProvider, SearchProvider, TranscribeProvider {
  /** Whatever was said: one minute of audio's worth of tokens, a fixed sentence back. */
  async transcribe(_req: TranscribeRequest): Promise<TranscribeResult> {
    return {
      text: 'Fake transcript of your voice note.',
      usage: { inputTokens: 1920, outputTokens: 10, thinkingTokens: 0, cachedInputTokens: 0 },
    };
  }

  /** A canned answer with two sources; "nothing" in the query finds none (no query billed). */
  async search(req: SearchRequest): Promise<SearchResult> {
    const none = /nothing/i.test(req.query);
    return {
      answer: none ? 'No results.' : `Fake search results for: ${req.query}`,
      sources: none
        ? []
        : [
            { title: 'example.com', url: 'https://example.com/a' },
            { title: 'example.org', url: 'https://example.org/b' },
          ],
      queries: none ? [req.query] : [req.query, `${req.query} 2026`],
      usage: { inputTokens: 40, outputTokens: 60, thinkingTokens: 0, cachedInputTokens: 0 },
    };
  }

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
    // "Search: <query>" in the task runs web_search once; its answer goes into the summary.
    const wantsSearch = /Search: (.+)/.exec(firstUser)?.[1]?.trim();
    const searched = req.contents
      .flatMap((c) => c.parts)
      .map((p) => p.functionResponse)
      .find((r) => r?.name === 'web_search');
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
    } else if (wantsSearch && !searched) {
      parts = [call('web_search', { query: wantsSearch })];
    } else if (turns === 1 || ((wantsFetch || wantsRun || wantsSearch) && turns === 2)) {
      const done = ran ?? searched;
      const output = done ? `\n\nOutput:\n\`\`\`\n${JSON.stringify(done.response)}\n\`\`\`` : '';
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
