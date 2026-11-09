import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  type AgentHarness,
  type ControlPlane,
  holdTime,
  type LoopOptions,
  type LoopResult,
  type RunInput,
  RunSupervisor,
  redactDeep,
  runSystemPrompt,
  ToolRuntime,
  type ToolStep,
  taskContext,
  truncate,
} from '@dodo/agent';
import {
  answerTurn,
  type Content,
  commentTurn,
  headlessRestartedNote,
  isApproved,
  type RunEndReason,
  steerTurn,
} from '@dodo/core';
import type { AssistantMessage, Message, Model } from '@earendil-works/pi-ai';
import { getModel } from '@earendil-works/pi-ai/compat';
import {
  type AgentSession,
  convertToLlm,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import { BUILTIN_TOOLS, builtinTools, claimFor, prepareDir, REPLACED_TOOLS } from './builtins.js';
import { responseText, toGeminiContents, toPiMessages } from './convert.js';

export { toGeminiContents, toPiMessages } from './convert.js';

/**
 * pi (pi.dev) as a dodo harness: pi runs the loop, its own file and shell tools, prompt caching
 * and compaction; dodo keeps what it must guarantee. Every model call goes through the gateway
 * (`gatewayGemini`, the run's token as the API key), every tool call through `ToolRuntime` or
 * its policy gate, and the run ends through the task contract like dodo's own loop.
 */

/** How pi's own tools work, as the harness section of the system prompt. */
export const PI_PROMPT_SECTION = `Files and shell (in the task folder):
- read: read a file (text with line numbers, or an image); use offset and limit for big files.
- edit: change a file by replacing exact text (oldText must match the file, whitespace included, and occur once); several edits to one file in one call.
- write: write a whole file (creates folders); prefer edit for a change to an existing file.
- bash: run a shell command (120 s at most). Read-only commands run at once; writes outside the folder and anything reaching the network need approval.
Use grep, find_files and list_dir to look around before reading.`;

/** Every model call asks for at most this much output, as dodo's loop does. */
const MAX_OUTPUT_TOKENS = 8192;
const NUDGE = 'Use the tools: update the Summary and Status, then call finish when you are done.';
const CONTINUE_AFTER_COMPACT =
  'The conversation was compacted to the summary above. Continue the task from there.';

type End = { reason: RunEndReason; outcome?: 'done' | 'review' | 'blocked'; error?: string };

/** A gateway refusal as pi reports it (the Gemini error body) as how the run ends. */
export function endForModelError(message: string): End {
  let status = '';
  let text = message;
  try {
    const e = (JSON.parse(message) as { error?: { status?: string; message?: string } }).error;
    status = e?.status ?? '';
    text = e?.message ?? message;
  } catch {
    status =
      /RESOURCE_EXHAUSTED|UNAVAILABLE|FAILED_PRECONDITION|PERMISSION_DENIED/.exec(message)?.[0] ??
      '';
  }
  if (status === 'RESOURCE_EXHAUSTED' || /budget_exhausted|rate_governor/.test(text)) {
    const rate = /rate_governor:\s*/.exec(text);
    return rate
      ? { reason: 'error', error: text.slice(rate.index + rate[0].length) }
      : { reason: 'budget_exhausted', error: text };
  }
  if (status === 'UNAVAILABLE' && /halted/.test(text)) return { reason: 'halted' };
  if (status === 'FAILED_PRECONDITION' || status === 'PERMISSION_DENIED') {
    return { reason: 'lease_lost' };
  }
  return { reason: 'error', error: truncate(text, 500) };
}

/** pi's catalog entry for the model, pointed at the gateway, or a plain one if pi lacks it. */
function gatewayModel(
  id: string,
  baseUrl: string,
  contextWindow?: number,
): Model<'google-generative-ai'> {
  const known = (() => {
    try {
      return getModel('google', id as never) as Model<'google-generative-ai'> | undefined;
    } catch {
      return undefined;
    }
  })();
  const base =
    known ??
    ({
      id,
      name: id,
      api: 'google-generative-ai',
      provider: 'google',
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: contextWindow ?? 1_048_576,
      maxTokens: MAX_OUTPUT_TOKENS,
    } as unknown as Model<'google-generative-ai'>);
  return {
    ...base,
    baseUrl,
    maxTokens: Math.min(base.maxTokens ?? MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS),
    ...(contextWindow ? { contextWindow } : {}),
  };
}

/** A JSON schema pi can validate against, from a dodo tool. */
function parametersOf(t: LoopOptions['tools'][number]): Record<string, unknown> {
  const raw =
    t.jsonSchema ??
    t.parameters ??
    (z.toJSONSchema(t.schema, { io: 'input' }) as Record<string, unknown>);
  const { $schema: _s, ...schema } = raw;
  return schema;
}

export async function runPi(input: RunInput, opts: LoopOptions): Promise<LoopResult> {
  const { control, store, trace } = opts;
  const log = opts.log ?? (() => {});
  const maxSteps = opts.maxSteps ?? 40;
  const workdir = opts.workdir ?? process.cwd();
  if (!control.geminiEndpoint) {
    throw new Error('This worker cannot run pi: its control plane has no Gemini endpoint.');
  }
  const endpoint = () => (control.geminiEndpoint as NonNullable<ControlPlane['geminiEndpoint']>)();
  const redact = <T>(v: T): T => (opts.secrets ? redactDeep(v, opts.secrets.redact) : v);

  // dodo's own file and shell tools give way to pi's; the rest go to pi as they are.
  const dodoTools = opts.tools.filter((t) => !REPLACED_TOOLS.includes(t.name));
  const usesBuiltins = opts.tools.some((t) => REPLACED_TOOLS.includes(t.name));
  const promptTools = usesBuiltins ? opts.tools : dodoTools;
  const system = runSystemPrompt(
    input,
    { ...opts, tools: promptTools },
    usesBuiltins ? PI_PROMPT_SECTION : undefined,
  );

  await trace.emit({
    type: 'run_started',
    summary: `Run started (${input.trigger}, ${input.model}, pi)`,
    data: { trigger: input.trigger, model: input.model, harness: 'pi' },
  });

  const supervisor = new RunSupervisor(control, {
    heartbeatMs: opts.heartbeatMs,
    heartbeatToleranceMs: opts.heartbeatToleranceMs,
    log,
  });
  const runtime = new ToolRuntime({
    tools: dodoTools,
    store,
    trace,
    policy: opts.policy,
    workdir,
    secrets: opts.secrets,
    screenshot: opts.screenshot,
    log,
  });

  let end: End | undefined;
  let pendingInput: Parameters<ControlPlane['requestInput']>[0] | undefined;
  /** ask_user from a tool: held or parked once pi has stopped. */
  let asked: Extract<ToolStep, { kind: 'ask_user' }> | undefined;
  let steps = 0;
  let parkRun = false;
  let compactAsked = false;
  let compacting = false;
  let session: AgentSession | undefined;

  const stopFor = (e: End) => {
    end ??= e;
    if (session?.isStreaming) void session.abort();
  };

  /** The step a dodo tool came to; anything but `continue` stops pi after this batch. */
  const onStep = (step: ToolStep) => {
    if (step.kind === 'continue') return false;
    if (step.kind === 'approval') {
      pendingInput = {
        kind: 'approval',
        prompt: step.prompt,
        suggestedRule: step.suggestedRule,
        session: [],
      };
      end ??= { reason: 'waiting_input' };
    } else if (step.kind === 'ask_user') {
      asked = step;
    } else {
      end ??= {
        reason: step.reason,
        ...(step.outcome ? { outcome: step.outcome } : {}),
        ...(step.error ? { error: step.error } : {}),
      };
    }
    return true;
  };

  const customTools: ToolDefinition[] = dodoTools.map(
    (t) =>
      ({
        name: t.name,
        label: t.name,
        description: t.description,
        parameters: parametersOf(t),
        executionMode: 'sequential',
        async execute(_id: string, params: Record<string, unknown>) {
          const step = await runtime.run(t.name, params);
          const stop = onStep(step);
          return {
            content: [{ type: 'text', text: responseText(step.result) }],
            details: undefined,
            ...(stop ? { terminate: true } : {}),
          };
        },
      }) as unknown as ToolDefinition,
  );
  if (usesBuiltins) customTools.push(...builtinTools(workdir));

  const dodoExtension: ExtensionFactory = (pi) => {
    pi.on('before_agent_start', async () => ({ systemPrompt: system }));

    // Every built-in call passes the policy first; once the run is ending, nothing else runs.
    pi.on('tool_call', async (event) => {
      if (end || asked)
        return { block: true, reason: 'Not run: the run is ending.', terminate: true };
      if (!(BUILTIN_TOOLS as readonly string[]).includes(event.toolName)) return undefined;
      const args = event.input as Record<string, unknown>;
      await trace.emit({
        type: 'tool_call',
        summary: `${event.toolName}(${truncate(JSON.stringify(args), 100)})`,
        data: { name: event.toolName, args },
      });
      const claim = claimFor(event.toolName, args, workdir);
      const decision = claim ? runtime.gate(claim) : { kind: 'allow' as const };
      if (decision.kind === 'deny') {
        await trace.emit({
          type: 'tool_result',
          summary: `${event.toolName} denied by ${decision.by}`,
          data: { name: event.toolName },
        });
        return { block: true, reason: `Not allowed (${decision.by}).` };
      }
      if (decision.kind === 'ask') {
        await trace.emit({
          type: 'tool_result',
          summary: `${event.toolName} needs approval: ${decision.suggestedRule}`,
          data: { name: event.toolName },
        });
        onStep({
          kind: 'approval',
          result: {},
          suggestedRule: decision.suggestedRule,
          prompt: `Allow \`${decision.suggestedRule}\`? ${decision.reason}`,
        });
        return {
          block: true,
          reason: 'Needs approval; the run pauses until the user answers.',
          terminate: true,
        };
      }
      if (event.toolName === 'bash') await prepareDir(workdir);
      return undefined;
    });

    // Built-in results: vault values out, then traced like dodo's own tools.
    pi.on('tool_result', async (event) => {
      if (!(BUILTIN_TOOLS as readonly string[]).includes(event.toolName)) return undefined;
      const content = redact(event.content);
      const text = content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
      await trace.emit({
        type: 'tool_result',
        summary: `${event.toolName} → ${truncate(text, 100)}`,
        data: { name: event.toolName, result: { text: truncate(text, 4000) } },
      });
      return { content };
    });

    // The run's token on every call (fresh, so a long run outlives the first one).
    pi.on('before_provider_headers', async (event) => {
      event.headers['x-goog-api-key'] = (await endpoint()).token;
      if (compacting) event.headers['x-dodo-purpose'] = 'compact';
    });

    pi.on('before_provider_request', async () => {
      if (compacting) return undefined;
      steps++;
      await trace.emit({ type: 'model_call', summary: `Model call ${steps}`, data: {} });
      return undefined;
    });

    // Before each model call: the lease and stop flags, and the step cap.
    pi.on('turn_start', async () => {
      await supervisor.beat();
      const stop = supervisor.stopReason();
      if (stop) stopFor({ reason: stop.reason, ...(stop.error ? { error: stop.error } : {}) });
      else if (steps >= maxSteps) stopFor({ reason: 'max_steps' });
    });

    // After each turn: comments go in before the next call; Compact stops the turn to compact.
    pi.on('turn_end', async () => {
      for (const m of supervisor.takeSteering()) {
        session?.steer(steerTurn(m.body));
        await trace.emit({
          type: 'steer',
          summary: `User: ${truncate(m.body, 80)}`,
          data: { messageId: m.id },
        });
      }
      if (supervisor.takeCompactRequest()) {
        compactAsked = true;
        if (session?.isStreaming) void session.abort();
      }
      return undefined;
    });

    // The model's reply: vault values out before it joins the conversation, then traced.
    pi.on('message_end', async (event) => {
      const m = event.message as Message;
      if (m.role !== 'assistant' || compacting) return undefined;
      const message = redact(m) as AssistantMessage;
      const calls = message.content.filter((c) => c.type === 'toolCall');
      const text = message.content
        .filter((c) => c.type === 'text')
        .map((c) => (c as { text: string }).text)
        .join('');
      await trace.emit({
        type: 'model_response',
        summary: message.errorMessage
          ? `Model call failed: ${truncate(message.errorMessage, 80)}`
          : calls.length
            ? `→ ${calls.map((c) => (c as { name: string }).name).join(', ')}`
            : `Text: ${truncate(text, 80)}`,
        data: {
          text: truncate(text, 2000),
          calls: calls.map((c) => (c as { name: string }).name),
          usage: {
            inputTokens: message.usage.input,
            outputTokens: message.usage.output,
            cachedInputTokens: message.usage.cacheRead,
          },
        },
      });
      return { message };
    });

    pi.on('session_before_compact', async () => {
      compacting = true;
      return undefined;
    });
    pi.on('session_compact', async (event) => {
      compacting = false;
      await trace.emit({
        type: 'compacted',
        summary: `Compacted the conversation (${event.reason === 'manual' ? 'asked' : 'automatic'})`,
        data: { asked: event.reason === 'manual' },
      });
    });
    pi.on('session_compact_failed', async (event) => {
      compacting = false;
      await trace.emit({
        type: 'compacted',
        summary: 'Compaction failed; continuing with the full conversation',
        data: { error: event.errorMessage },
      });
    });
  };

  const dir = await mkdtemp(path.join(os.tmpdir(), 'dodo-pi-'));
  const geminiSession = (): Content[] =>
    session ? toGeminiContents(convertToLlm(session.messages) as Message[]) : [...input.session];

  supervisor.start();
  try {
    const ep = await endpoint();
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(dir, 'auth.json'),
      modelsPath: path.join(dir, 'models.json'),
    });
    await modelRuntime.setRuntimeApiKey('google', ep.token);
    const settingsManager = SettingsManager.inMemory({
      // A failed call is a gateway refusal or a real failure: dodo decides, not a retry loop.
      retry: { enabled: false },
    } as Parameters<typeof SettingsManager.inMemory>[0]);
    const resourceLoader = new DefaultResourceLoader({
      cwd: workdir,
      agentDir: dir,
      settingsManager,
      extensionFactories: [dodoExtension],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();
    const sessionManager = SessionManager.inMemory(workdir);
    for (const m of toPiMessages(input.session, input.model)) sessionManager.appendMessage(m);

    ({ session } = await createAgentSession({
      cwd: workdir,
      agentDir: dir,
      model: gatewayModel(input.model, ep.baseUrl, input.contextWindow),
      thinkingLevel: 'low',
      modelRuntime,
      resourceLoader,
      customTools,
      tools: customTools.map((t) => t.name),
      sessionManager,
      settingsManager,
    }));
    await session.bindExtensions({});

    // The opening turn depends on the trigger, as in dodo's loop.
    const hasBrowser = opts.tools.some((t) => t.name.startsWith('browser_'));
    const opening: string[] = [];
    if (input.trigger === 'new' || input.session.length === 0) {
      const [messages, artifacts] = await Promise.all([
        store.recentMessages(30),
        store.listArtifacts(),
      ]);
      opening.push(taskContext(input.task, messages, artifacts));
    } else if (input.trigger === 'resume' && input.answer) {
      const a = input.answer;
      if (a.suggestedRule && !a.alwaysAllow && isApproved(a.value))
        opts.policy?.allowOnce(a.suggestedRule);
      opening.push(answerTurn(a.prompt, a.value));
    } else if (input.trigger === 'comment') {
      const messages = await store.recentMessages(5);
      opening.push(commentTurn(messages.filter((m) => m.author === 'user').at(-1)?.body));
    }
    if (
      input.trigger !== 'new' &&
      input.session.length > 1 &&
      hasBrowser &&
      opts.browserKind === 'headless'
    ) {
      opening.push(headlessRestartedNote(opts.browserRestored));
    }

    await supervisor.beat();
    const first = supervisor.stopReason();
    if (first) end = { reason: first.reason, ...(first.error ? { error: first.error } : {}) };
    for (const m of supervisor.takeSteering()) {
      opening.push(steerTurn(m.body));
      await trace.emit({
        type: 'steer',
        summary: `User: ${truncate(m.body, 80)}`,
        data: { messageId: m.id },
      });
    }

    let next: string | undefined = opening.join('\n\n') || 'Continue the task.';
    let nudges = 0;
    while (!end && next !== undefined) {
      const text = next;
      next = undefined;
      await session.prompt(text);
      if (end) break;

      if (compactAsked) {
        compactAsked = false;
        try {
          await session.compact();
        } catch (err) {
          log('compaction failed', { err: String(err) });
        }
        next = CONTINUE_AFTER_COMPACT;
        continue;
      }

      if (asked) {
        const step = asked;
        asked = undefined;
        const holdMs = holdTime(opts.inputHoldMs, opts.deadline);
        if (holdMs) {
          const answer = await supervisor.holdForAnswer(
            { ...step.askUser, session: geminiSession(), holdMs },
            holdMs,
          );
          if (answer) {
            await trace.emit({
              type: 'steer',
              summary: `Answer: ${truncate(answer.value, 80)}`,
              data: { messageId: answer.messageId },
            });
            if (answer.suggestedRule && !answer.alwaysAllow && isApproved(answer.value)) {
              opts.policy?.allowOnce(answer.suggestedRule);
            }
            next = answerTurn(answer.prompt, answer.value);
            continue;
          }
          const stop = supervisor.stopReason();
          if (stop) end = { reason: stop.reason, ...(stop.error ? { error: stop.error } : {}) };
          else {
            parkRun = true;
            end = { reason: 'waiting_input' };
          }
          break;
        }
        pendingInput = { ...step.askUser, session: [] };
        end = { reason: 'waiting_input' };
        break;
      }

      const last = session.messages.at(-1) as Message | undefined;
      if (last?.role === 'assistant') {
        if (last.stopReason === 'error') {
          end = endForModelError(last.errorMessage ?? 'Model call failed');
          break;
        }
        if (last.stopReason === 'aborted') {
          const stop = supervisor.stopReason();
          end = stop
            ? { reason: stop.reason, ...(stop.error ? { error: stop.error } : {}) }
            : { reason: 'interrupted' };
          break;
        }
        const calls = last.content.some((c) => c.type === 'toolCall');
        if (!calls) {
          // A text-only reply has no effect on the task. Nudge once, then stop for review.
          if (nudges++ < 1) {
            next = NUDGE;
            continue;
          }
          const reply = last.content
            .filter((c) => c.type === 'text')
            .map((c) => (c as { text: string }).text)
            .join('')
            .trim();
          if (reply) await store.postMessage(reply);
          end = { reason: 'finished', outcome: 'review' };
          break;
        }
      }
      end = { reason: 'error', error: 'pi stopped without finishing the task' };
    }
  } catch (err) {
    log('run failed', { err: String(err) });
    await trace.emit({ type: 'error', summary: truncate((err as Error).message, 200), data: {} });
    end ??= { reason: 'error', error: (err as Error).message };
  } finally {
    supervisor.stop();
  }

  const final = end ?? { reason: 'error' as const, error: 'pi ended without a reason' };
  const contents = geminiSession();
  session?.dispose();
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);

  await trace.emit({
    type: 'run_finished',
    summary: `Run ended: ${final.reason}`,
    data: { steps, outcome: final.outcome },
  });
  if (pendingInput) {
    await control.requestInput({ ...pendingInput, session: contents });
  } else if (final.reason !== 'waiting_input' || parkRun) {
    try {
      await control.finish({
        reason: final.reason,
        error: final.error,
        session: contents,
        outcome: final.outcome,
      });
    } catch (err) {
      log('finish failed', { err: String(err) });
    }
  }
  return { reason: final.reason, steps, session: contents };
}

export const piHarness: AgentHarness = {
  id: 'pi',
  capabilities: {
    modelFormats: ['gemini'],
    localModel: false,
    builtinTools: [...BUILTIN_TOOLS],
    steering: true,
    programmaticCompaction: true,
    // Stored as Gemini contents, like dodo's loop, so a task moves between them freely.
    sessionFormat: 'gemini-contents',
  },
  run: runPi,
};
