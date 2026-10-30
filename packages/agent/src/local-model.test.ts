import { describe, expect, it } from 'vitest';
import {
  chatCompletionsUrl,
  fromChatResponse,
  generateLocal,
  LocalModelControlPlane,
  toChatRequest,
} from './local-model.js';
import { FakeControlPlane } from './testing.js';

describe('toChatRequest', () => {
  it('turns function calls and responses into tool calls with matching ids', () => {
    const req = toChatRequest(
      {
        model: 'local',
        systemInstruction: 'You are dodo.',
        contents: [
          { role: 'user', parts: [{ text: 'Do the task' }] },
          {
            role: 'model',
            parts: [
              { text: 'thinking out loud', thought: true },
              { text: 'On it.' },
              { functionCall: { name: 'set_status', args: { text: 'Reading' } } },
              { functionCall: { id: 'abc', name: 'bash', args: { command: 'ls' } } },
            ],
          },
          {
            role: 'user',
            parts: [
              { functionResponse: { name: 'set_status', response: { ok: true } } },
              { functionResponse: { id: 'abc', name: 'bash', response: { stdout: 'a' } } },
              { inlineData: { mimeType: 'image/png', data: 'xx' } } as never,
            ],
          },
        ],
        tools: [
          {
            name: 'set_status',
            description: 'Set the status',
            parameters: { type: 'object', properties: { text: { type: 'string' } } },
          },
          { name: 'mcp_x', description: 'x', parametersJsonSchema: { type: 'object' } },
        ],
        maxOutputTokens: 1000,
      },
      'qwen',
    );
    expect(req.model).toBe('qwen');
    expect(req.max_tokens).toBe(1000);
    expect(req.messages).toEqual([
      { role: 'system', content: 'You are dodo.' },
      { role: 'user', content: 'Do the task' },
      {
        role: 'assistant',
        content: 'On it.',
        tool_calls: [
          {
            id: 'call_1_2',
            type: 'function',
            function: { name: 'set_status', arguments: '{"text":"Reading"}' },
          },
          {
            id: 'abc',
            type: 'function',
            function: { name: 'bash', arguments: '{"command":"ls"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1_2', content: '{"ok":true}' },
      { role: 'tool', tool_call_id: 'abc', content: '{"stdout":"a"}' },
      { role: 'user', content: '[an image was here; the local model cannot see images]' },
    ]);
    expect(req.tools?.map((t) => t.function.parameters)).toEqual([
      { type: 'object', properties: { text: { type: 'string' } } },
      { type: 'object' },
    ]);
  });
});

describe('fromChatResponse', () => {
  it('reads tool calls, usage and reasoning', () => {
    const r = fromChatResponse(
      {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: '<think>hmm</think>Working.',
              tool_calls: [
                { id: 't1', function: { name: 'set_status', arguments: '{"text":"Hi"}' } },
                { function: { name: 'finish', arguments: 'not json' } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 120, completion_tokens: 30 },
      },
      'c',
    );
    expect(r.content.parts).toEqual([
      { text: 'hmm', thought: true },
      { text: 'Working.' },
      { functionCall: { id: 't1', name: 'set_status', args: { text: 'Hi' } } },
      { functionCall: { id: 'c_0', name: 'finish', args: { _unparsed: 'not json' } } },
    ]);
    expect(r.usage).toMatchObject({ inputTokens: 120, outputTokens: 30 });
    expect(r.finishReason).toBe('tool_calls');
  });

  it('picks up Qwen tool-call blocks a server left in the text', () => {
    const r = fromChatResponse(
      {
        choices: [
          {
            message: {
              content:
                'Sure.\n<tool_call>\n{"name": "post_message", "arguments": {"body": "hi"}}\n</tool_call>',
            },
          },
        ],
      },
      'c',
    );
    expect(r.content.parts).toEqual([
      { text: 'Sure.' },
      { functionCall: { id: 'c_0', name: 'post_message', args: { body: 'hi' } } },
    ]);
  });
});

describe('generateLocal', () => {
  it('posts to the chat completions endpoint', async () => {
    let seen: { url: string; body: Record<string, unknown> } | undefined;
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(String(init.body)) };
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'hello' } }], usage: {} }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const r = await generateLocal(
      { url: 'http://localhost:8080', model: 'm' },
      { model: 'local', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      fetchFn,
    );
    expect(seen?.url).toBe('http://localhost:8080/v1/chat/completions');
    expect(seen?.body.model).toBe('m');
    expect(r.content.parts).toEqual([{ text: 'hello' }]);
  });

  it('says where the server was when it does not answer', async () => {
    const fetchFn = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(
      generateLocal(
        { url: 'http://localhost:9' },
        { model: 'local', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
        fetchFn,
      ),
    ).rejects.toThrow(/localhost:9 did not answer.*ECONNREFUSED/);
  });

  it('builds the endpoint from any base url', () => {
    expect(chatCompletionsUrl('http://localhost:1234/v1/')).toBe(
      'http://localhost:1234/v1/chat/completions',
    );
    expect(chatCompletionsUrl('http://localhost:11434/v1/chat/completions')).toBe(
      'http://localhost:11434/v1/chat/completions',
    );
  });
});

describe('LocalModelControlPlane', () => {
  it('answers model calls locally at no cost and passes the rest through', async () => {
    const inner = new FakeControlPlane([{ text: 'from the gateway' }]);
    const fetchFn = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'local' } }] }), {
        status: 200,
      })) as unknown as typeof fetch;
    const cp = new LocalModelControlPlane(inner, { url: 'http://localhost:8080' }, fetchFn);
    await cp.heartbeat();
    const r = await cp.generate({
      model: 'local',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    });
    expect(r.cost).toBe(0);
    expect(r.content.parts).toEqual([{ text: 'local' }]);
    expect(inner.requests).toHaveLength(0);
    expect(inner.heartbeats).toBe(1);
  });
});
