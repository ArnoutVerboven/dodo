import type { Run } from '@dodo/core';
import { describe, expect, it } from 'vitest';
import type { GatewayDeps } from './gateway.js';
import {
  fromGeminiRest,
  type GeminiEndpointDeps,
  type GeminiHttpResponse,
  handleGeminiRequest,
} from './gateway-gemini.js';

/** An Express-like response that records what was sent. */
function recorder() {
  const out = { status: 0, headers: {} as Record<string, string>, body: '' };
  const res: GeminiHttpResponse = {
    headersSent: false,
    status(code) {
      out.status = code;
      return res;
    },
    setHeader(name, value) {
      out.headers[name] = value;
      return res;
    },
    write(chunk) {
      res.headersSent = true;
      out.body += chunk;
    },
    end(chunk) {
      res.headersSent = true;
      if (chunk) out.body += chunk;
    },
  };
  return { res, out };
}

const request = (
  body: unknown,
  headers: Record<string, string> = { 'x-goog-api-key': 'tok' },
  path = '/v1beta/models/gemini-3.8-flash:streamGenerateContent',
) => ({
  method: 'POST',
  path,
  header: (name: string) => headers[name.toLowerCase()],
  body,
});

const body = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };

describe('fromGeminiRest', () => {
  it('maps the system prompt, tools and limits pi sends', () => {
    const r = fromGeminiRest('gemini-3.8-flash', {
      contents: body.contents as never,
      systemInstruction: { parts: [{ text: 'Be brief.' }] },
      tools: [
        {
          functionDeclarations: [
            { name: 'bash', description: 'Run', parametersJsonSchema: { type: 'object' } },
          ],
        },
      ],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      generationConfig: {
        maxOutputTokens: 4000,
        temperature: 0.2,
        thinkingConfig: { thinkingLevel: 'LOW', includeThoughts: true },
      },
    });
    expect(r).toMatchObject({
      model: 'gemini-3.8-flash',
      systemInstruction: 'Be brief.',
      tools: [{ name: 'bash' }],
      maxOutputTokens: 4000,
      temperature: 0.2,
      thinkingBudget: 1024,
      includeThoughts: true,
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    });
  });

  it('keeps an explicit budget, and leaves dynamic thinking to the default', () => {
    const at = (thinkingBudget: number) =>
      fromGeminiRest('m', {
        contents: body.contents as never,
        generationConfig: { thinkingConfig: { thinkingBudget } },
      }).thinkingBudget;
    expect(at(0)).toBe(0);
    expect(at(-1)).toBeUndefined();
  });
});

describe('handleGeminiRequest refusals', () => {
  const deps = (over: Partial<GeminiEndpointDeps> = {}): GeminiEndpointDeps => ({
    gateway: {} as GatewayDeps,
    verifyToken: async () => ({ uid: 'run:r1', claims: { run: 'r1' } }),
    loadRun: async () => ({ id: 'r1', taskId: 't1' }) as Run,
    context: () => ({ scopes: [], description: 'x' }),
    ...over,
  });

  it('asks for the run token', async () => {
    const { res, out } = recorder();
    await handleGeminiRequest(deps(), request(body, {}), res);
    expect(out.status).toBe(401);
    expect(JSON.parse(out.body).error.status).toBe('UNAUTHENTICATED');
  });

  it('refuses a token that does not verify', async () => {
    const { res, out } = recorder();
    const bad = deps({
      verifyToken: async () => {
        throw new Error('expired');
      },
    });
    await handleGeminiRequest(bad, request(body), res);
    expect(out.status).toBe(401);
  });

  it('refuses a token that is not a run identity (the owner)', async () => {
    const { res, out } = recorder();
    const owner = deps({
      verifyToken: async () => ({ uid: 'u', claims: { dodo_owner: true } }),
    });
    await handleGeminiRequest(owner, request(body, { authorization: 'Bearer tok' }), res);
    expect(out.status).toBe(403);
  });

  it('refuses built-in Google tools, which would bill outside the budget', async () => {
    const { res, out } = recorder();
    await handleGeminiRequest(deps(), request({ ...body, tools: [{ googleSearch: {} }] }), res);
    expect(out.status).toBe(400);
  });

  it('answers 404 on anything but a model call', async () => {
    const { res, out } = recorder();
    await handleGeminiRequest(deps(), request(body, undefined, '/v1beta/models'), res);
    expect(out.status).toBe(404);
  });
});
