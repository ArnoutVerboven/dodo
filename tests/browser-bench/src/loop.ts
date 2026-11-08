import { createInterface } from 'node:readline/promises';
import type { Driver } from './drivers/types.ts';
import type { Message, Model, ToolSpec } from './model.ts';

/**
 * The loop every in-house approach shares: one system prompt, the task, and the driver's
 * tools plus done and ask_user. Only the driver changes between approaches, so differences
 * in calls and tokens come from how the page is shown, not from the prompt.
 */

export const SYSTEM = [
  'You control a web browser to reach a goal. Use the tools; each element has a ref in the page text.',
  'Be efficient: act directly when the page you have shows what you need, and look at the page again only when you cannot tell what happened.',
  'Dismiss cookie banners and pop-ups that block the page (choose the minimal or essential option).',
  'When the goal is reached, call done. If a step needs the person (a password, a code, a CAPTCHA, an approval on their phone), call ask_user and wait.',
  'Never type passwords or personal data unless the goal says so.',
].join(' ');

const DONE: ToolSpec = {
  name: 'done',
  description: 'Finish: call when the goal is reached, or when it cannot be reached.',
  parameters: {
    type: 'object',
    properties: { success: { type: 'boolean' }, note: { type: 'string' } },
    required: ['success'],
  },
};
const ASK: ToolSpec = {
  name: 'ask_user',
  description:
    'Ask the person to do something only they can (log in, enter a code, solve a CAPTCHA, approve on their phone) in the open browser window, and wait for their answer.',
  parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
};

export interface CallLog {
  input: number;
  output: number;
  cached: number;
  ms: number;
  tools: string[];
  estimated: boolean;
}

export interface LoopResult {
  calls: CallLog[];
  agentSaysDone: boolean;
  asked: number;
  error?: string;
  /** Characters of tool output the model was shown, summed over the run. */
  observedChars: number;
  toolSchemaChars: number;
}

export async function runLoop(opts: {
  model: Model;
  driver: Driver;
  goal: string;
  start: string;
  maxCalls: number;
  /** Ask the person in the terminal; otherwise ask_user answers that nobody is there. */
  interactive: boolean;
}): Promise<LoopResult> {
  const tools = [...opts.driver.tools, DONE, ASK];
  const messages: Message[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Start page: ${opts.start}\nGoal: ${opts.goal}` },
  ];
  const result: LoopResult = {
    calls: [],
    agentSaysDone: false,
    asked: 0,
    observedChars: 0,
    toolSchemaChars: JSON.stringify(tools).length,
  };
  for (let i = 0; i < opts.maxCalls; i++) {
    opts.driver.prune?.(messages);
    const t0 = Date.now();
    let reply: Awaited<ReturnType<Model['chat']>>;
    try {
      reply = await opts.model.chat(messages, tools);
    } catch (e) {
      result.error = (e as Error).message;
      break;
    }
    result.calls.push({
      ...reply.usage,
      ms: Date.now() - t0,
      tools: reply.calls.map((c) => c.name),
    });
    messages.push({
      role: 'assistant',
      content: reply.text || null,
      ...(reply.calls.length
        ? {
            tool_calls: reply.calls.map((c) => ({
              id: c.id,
              type: 'function' as const,
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          }
        : {}),
    });
    if (!reply.calls.length) {
      messages.push({
        role: 'user',
        content: 'Use the tools to continue, or call done when the goal is reached.',
      });
      continue;
    }
    let finished = false;
    for (const c of reply.calls) {
      let content: string;
      if (c.name === 'done') {
        finished = true;
        result.agentSaysDone = c.args.success !== false;
        content = 'ok';
      } else if (c.name === 'ask_user') {
        result.asked++;
        content = opts.interactive
          ? await askInTerminal(String(c.args.prompt ?? ''))
          : 'The person is not available in this test. Continue without them if you can, or call done.';
      } else {
        try {
          const res = await opts.driver.call(c.name, c.args);
          content = res.isError ? `Error: ${res.text}` : res.text;
        } catch (e) {
          content = `Error: ${(e as Error).message}`;
        }
      }
      result.observedChars += content.length;
      messages.push({ role: 'tool', tool_call_id: c.id, content });
    }
    if (finished) break;
  }
  return result;
}

async function askInTerminal(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `\n  The agent asks: ${prompt}\n  Do it in the browser window, then type your answer: `,
    );
    return answer || 'done';
  } finally {
    rl.close();
  }
}
