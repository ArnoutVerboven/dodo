import {
  answerTurn,
  COMPACT_SYSTEM,
  type Content,
  commentTurn,
  compactedSession,
  compactionRequest,
  compactThreshold,
  type HeartbeatResponse,
  headlessRestartedNote,
  type Part,
  type RunEndReason,
  repoFor,
  steerTurn,
  summaryText,
} from '@dodo/core';
import type { PolicyEngine } from '@dodo/policy';
import {
  type ControlPlane,
  GatewayBudgetError,
  GatewayHaltedError,
  GatewayRateLimitError,
  LeaseLostError,
  type RunInput,
  type TaskStore,
  type TraceSink,
} from './control-plane.js';
import { systemPrompt, taskContext } from './prompt.js';
import { redactDeep, type SecretResolver } from './secrets.js';
import { findTool, type ToolContext, type ToolDef, toDeclarations } from './tools.js';

export interface LoopOptions {
  control: ControlPlane;
  store: TaskStore;
  trace: TraceSink;
  tools: ToolDef[];
  policy?: PolicyEngine;
  workdir?: string;
  /** Vault values for tools that type into sites; every value it hands out is redacted. */
  secrets?: SecretResolver;
  /** Screenshots of the browser page for ask_user; absent when the run has no browser. */
  screenshot?: ToolContext['screenshot'];
  /** What the browser is, for the system prompt: a window on the user's Mac, or headless remote. */
  browserKind?: 'window' | 'headless';
  /** Headless: what came back from the task's earlier runs (logins; where the agent was). */
  browserRestored?: { logins: boolean; lastUrl?: string };
  /**
   * After ask_user, stay alive this long for the answer (delivered by the heartbeat) instead
   * of ending the run: a remote browser keeps its page and logins across the question.
   */
  inputHoldMs?: number;
  /**
   * When the worker is killed (epoch ms). A hold never runs past it: the run parks in time
   * instead of dying mid-hold with the question unanswerable until its lease expires.
   */
  deadline?: number;
  /** Hard stop on the number of model calls per run. */
  maxSteps?: number;
  /** Heartbeat timer interval in ms; 0 disables the timer (heartbeats still happen per step). */
  heartbeatMs?: number;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

export interface LoopResult {
  reason: RunEndReason;
  steps: number;
  session: Content[];
}

/**
 * The agent loop: build the request, call the gateway, run the tools it asks for, repeat.
 * Hooks are not bolted on: budget, lease, halt, interrupt and steering are all checked here.
 */
export async function runAgent(input: RunInput, opts: LoopOptions): Promise<LoopResult> {
  const { control, store, trace, tools } = opts;
  const maxSteps = opts.maxSteps ?? 40;
  const log = opts.log ?? (() => {});
  const session: Content[] = [...input.session];
  const declarations = toDeclarations(tools);
  const hasBrowser = tools.some((t) => t.name.startsWith('browser_'));
  const system = systemPrompt(input.task, input.project, {
    browser: hasBrowser ? (opts.browserKind ?? 'window') : undefined,
    holdMinutes: hasBrowser && opts.inputHoldMs ? Math.round(opts.inputHoldMs / 60_000) : undefined,
    canRequestBrowser: !hasBrowser && tools.some((t) => t.name === 'request_browser'),
    canRequestDevice: tools.some((t) => t.name === 'request_device'),
    github: tools.some((t) => t.name === 'open_pull_request')
      ? repoFor(input.task, input.project)
      : undefined,
  });
  // Vault values never go back to the model, the trace or the task: cut them out of every
  // tool argument and result.
  const redact = <T>(v: T): T => (opts.secrets ? redactDeep(v, opts.secrets.redact) : v);

  await trace.emit({
    type: 'run_started',
    summary: `Run started (${input.trigger}, ${input.model})`,
    data: { trigger: input.trigger, model: input.model },
  });

  // Opening turn depends on the trigger.
  if (input.trigger === 'new' || session.length === 0) {
    const [messages, artifacts] = await Promise.all([
      store.recentMessages(30),
      store.listArtifacts(),
    ]);
    session.push(user(taskContext(input.task, messages, artifacts)));
  } else if (input.trigger === 'resume' && input.answer) {
    takeAnswer(input.answer);
  } else if (input.trigger === 'comment') {
    const messages = await store.recentMessages(5);
    const latest = messages.filter((m) => m.author === 'user').at(-1);
    session.push(user(commentTurn(latest?.body)));
  }
  // A continued conversation with a headless browser: the pages of the earlier run are gone
  // with it, whatever the conversation says. Say so, or the agent takes one look at the blank
  // page and gives up.
  if (
    input.trigger !== 'new' &&
    session.length > 1 &&
    hasBrowser &&
    opts.browserKind === 'headless'
  ) {
    const note = headlessRestartedNote(opts.browserRestored);
    const last = session.at(-1);
    if (last?.role === 'user') last.parts.push({ text: note });
    else session.push(user(note));
  }

  /** The user's answer goes into the conversation; a "yes" to an approval permits that call once. */
  function takeAnswer(a: NonNullable<RunInput['answer']>) {
    if (a.suggestedRule && !a.alwaysAllow && /^(y|yes|ok|approve|allow)/i.test(a.value.trim())) {
      opts.policy?.allowOnce(a.suggestedRule);
    }
    session.push(user(answerTurn(a.prompt, a.value)));
  }

  // Heartbeat: lease renewal + infra metering + flags + steering. Also on a timer so a long
  // tool call cannot let the lease expire.
  let latestFlags: Awaited<ReturnType<ControlPlane['heartbeat']>> | undefined;
  let heartbeatError: Error | undefined;
  // The server hands a compaction request over once, possibly to a timer beat: keep it.
  let compactAsked = false;
  /** An answer the heartbeat delivered during a hold; kept until the hold takes it. */
  let heldAnswer: HeartbeatResponse['answer'];
  const beat = async () => {
    try {
      latestFlags = await control.heartbeat();
      if (latestFlags.compact) compactAsked = true;
      if (latestFlags.answer) heldAnswer = latestFlags.answer;
    } catch (err) {
      heartbeatError = err as Error;
    }
  };
  const timer = opts.heartbeatMs ? setInterval(beat, opts.heartbeatMs) : undefined;
  const seenMessages = new Set<string>();

  // Tokens the conversation held at the last model call: the task's figure for a restored one.
  const window = input.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  let contextTokens = input.session.length ? (input.task.context?.tokens ?? 0) : 0;
  let autoCompact = true;
  /**
   * ask_user with a hold: post the question, then poll the heartbeat until the answer comes,
   * the hold runs out, or the run is told to stop (flags are read by the main loop after).
   */
  async function holdForAnswer(
    req: Parameters<ControlPlane['requestInput']>[0],
    holdMs: number,
  ): Promise<NonNullable<RunInput['answer'] & { messageId: string }> | undefined> {
    const posted = await control.requestInput(req);
    const messageId = posted && 'messageId' in posted ? posted.messageId : undefined;
    const until = Date.now() + holdMs;
    const every = opts.heartbeatMs || 1000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, Math.min(every, Math.max(0, until - Date.now()))));
      await beat();
      if (heartbeatError || (latestFlags && !latestFlags.ok)) return undefined;
      const a = heldAnswer;
      if (a && (!messageId || a.messageId === messageId)) {
        heldAnswer = undefined;
        return a;
      }
    }
    return undefined;
  }

  let steps = 0;
  let nudges = 0;
  /** The hold ran out: the question is posted, the run must still be parked. */
  let parkRun = false;
  let pendingInput: Parameters<ControlPlane['requestInput']>[0] | undefined;
  let end:
    | { reason: RunEndReason; outcome?: 'done' | 'review' | 'blocked'; error?: string }
    | undefined;

  const finishWith = (
    reason: RunEndReason,
    extra: { error?: string; outcome?: 'done' | 'review' | 'blocked' } = {},
  ) => {
    end = { reason, ...extra };
  };

  try {
    while (!end) {
      await beat();
      if (heartbeatError) {
        finishWith(heartbeatError instanceof LeaseLostError ? 'lease_lost' : 'error', {
          error: heartbeatError.message,
        });
        break;
      }
      if (latestFlags && !latestFlags.ok) {
        finishWith(
          latestFlags.reason === 'halted'
            ? 'halted'
            : latestFlags.reason === 'interrupted'
              ? 'interrupted'
              : latestFlags.reason === 'budget_exhausted'
                ? 'budget_exhausted'
                : 'lease_lost',
        );
        break;
      }
      // Steering: comments posted during the run go in before the next model call.
      for (const m of latestFlags?.pendingMessages ?? []) {
        if (seenMessages.has(m.id)) continue;
        seenMessages.add(m.id);
        session.push(user(steerTurn(m.body)));
        await trace.emit({
          type: 'steer',
          summary: `User: ${truncate(m.body, 80)}`,
          data: { messageId: m.id },
        });
      }
      if (steps >= maxSteps) {
        finishWith('max_steps');
        break;
      }

      // Compaction: on request, or before the conversation grows past the threshold.
      const asked = compactAsked;
      if (
        (asked || (autoCompact && contextTokens >= compactThreshold(window))) &&
        session.length > 1
      ) {
        compactAsked = false;
        const before = contextTokens;
        const replaced = session.length;
        let summary = '';
        try {
          const reply = await control.generate({
            model: input.model,
            systemInstruction: COMPACT_SYSTEM,
            contents: compactionRequest(session),
            purpose: 'compact',
          });
          summary = summaryText(redact(reply.content));
        } catch (err) {
          if (err instanceof GatewayBudgetError) {
            finishWith('budget_exhausted', { error: err.message });
            break;
          }
          if (err instanceof GatewayHaltedError) {
            finishWith('halted');
            break;
          }
          if (err instanceof LeaseLostError) {
            finishWith('lease_lost');
            break;
          }
          log('compaction failed', { err: String(err) });
        }
        // An empty or failed summary keeps the conversation as it is; the next step goes on.
        if (summary) session.splice(0, session.length, ...compactedSession(summary));
        else autoCompact = false; // no retry on every step
        contextTokens = 0;
        await trace.emit({
          type: 'compacted',
          summary: summary
            ? `Compacted the conversation (${asked ? 'asked' : 'automatic'}): ${replaced} turns, ${Math.round(before / 1000)}k tokens → a summary`
            : 'Compaction failed; continuing with the full conversation',
          data: { asked, before, turns: replaced, summary: truncate(summary, 2000) },
        });
      }

      steps++;
      await trace.emit({
        type: 'model_call',
        summary: `Model call ${steps}`,
        data: { turns: session.length },
      });
      let response: Awaited<ReturnType<ControlPlane['generate']>>;
      try {
        response = await control.generate({
          model: input.model,
          systemInstruction: system,
          contents: session,
          tools: declarations,
        });
      } catch (err) {
        if (err instanceof GatewayBudgetError) {
          finishWith('budget_exhausted', { error: err.message });
          break;
        }
        if (err instanceof GatewayRateLimitError) {
          finishWith('error', { error: err.message });
          break;
        }
        if (err instanceof GatewayHaltedError) {
          finishWith('halted');
          break;
        }
        if (err instanceof LeaseLostError) {
          finishWith('lease_lost');
          break;
        }
        throw err;
      }
      response = { ...response, content: redact(response.content) };
      session.push(response.content);
      contextTokens = response.usage.inputTokens + response.usage.outputTokens;
      const calls = response.content.parts.filter((p) => p.functionCall);
      const text = response.content.parts
        .filter((p) => p.text && !p.thought)
        .map((p) => p.text)
        .join('');
      await trace.emit({
        type: 'model_response',
        summary: calls.length
          ? `→ ${calls.map((c) => c.functionCall?.name).join(', ')}`
          : `Text: ${truncate(text, 80)}`,
        data: {
          text: truncate(text, 2000),
          calls: calls.map((c) => c.functionCall?.name),
          usage: response.usage,
        },
        cost: response.cost,
      });

      if (calls.length === 0) {
        // A text-only reply has no effect on the task. Nudge once, then stop for review.
        if (nudges++ < 1) {
          session.push(
            user(
              'Use the tools: update the Summary and Status, then call finish when you are done.',
            ),
          );
          continue;
        }
        if (text.trim()) await store.postMessage(text.trim());
        finishWith('finished', { outcome: 'review' });
        break;
      }

      const responses: Part[] = [];
      for (const part of calls) {
        const fc = part.functionCall as NonNullable<Part['functionCall']>;
        const tool = findTool(tools, fc.name);
        await trace.emit({
          type: 'tool_call',
          summary: `${fc.name}(${truncate(JSON.stringify(fc.args ?? {}), 100)})`,
          data: { name: fc.name, args: fc.args ?? {} },
        });
        let result: Record<string, unknown>;
        if (!tool) {
          result = { error: `Unknown tool ${fc.name}` };
        } else {
          const parsed = tool.schema.safeParse(fc.args ?? {});
          if (!parsed.success) {
            result = {
              error: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
            };
          } else {
            try {
              const ctx = {
                store,
                policy: opts.policy,
                workdir: opts.workdir,
                secrets: opts.secrets,
                screenshot: opts.screenshot,
              };
              const claim = tool.policy?.(parsed.data, ctx);
              const decision = claim
                ? (opts.policy?.decide(claim) ?? { kind: 'deny' as const, by: 'no policy engine' })
                : { kind: 'allow' as const };
              if (decision.kind === 'deny') {
                result = { error: `Not allowed (${decision.by}).` };
                responses.push(functionResponse(fc, result));
                await trace.emit({
                  type: 'tool_result',
                  summary: `${fc.name} denied by ${decision.by}`,
                  data: { name: fc.name },
                });
                continue;
              }
              if (decision.kind === 'ask') {
                result = {
                  ok: false,
                  note: 'Needs approval; the run pauses until the user answers.',
                };
                responses.push(functionResponse(fc, result));
                session.push({ role: 'user', parts: responses });
                await trace.emit({
                  type: 'tool_result',
                  summary: `${fc.name} needs approval: ${decision.suggestedRule}`,
                  data: { name: fc.name },
                });
                pendingInput = {
                  kind: 'approval',
                  prompt: `Allow \`${decision.suggestedRule}\`? ${decision.reason}`,
                  suggestedRule: decision.suggestedRule,
                  session,
                };
                finishWith('waiting_input');
                break;
              }
              const outcome = await tool.execute(parsed.data, ctx);
              result = redact(outcome.result);
              if ('askUser' in outcome) {
                responses.push(functionResponse(fc, result));
                session.push({ role: 'user', parts: [...responses] });
                await trace.emit({
                  type: 'tool_result',
                  summary: `ask_user: ${truncate(outcome.askUser.prompt, 80)}${outcome.askUser.image ? ' (with screenshot)' : ''}`,
                  data: { name: fc.name },
                });
                const holdMs = holdTime(opts.inputHoldMs, opts.deadline);
                if (holdMs) {
                  // Post the question now and wait here for the answer, lease kept by the
                  // heartbeat. No answer in time: park the run exactly as without a hold.
                  const answer = await holdForAnswer(
                    { ...outcome.askUser, session, holdMs },
                    holdMs,
                  );
                  // The tool responses are already in the session; the answer is the next turn.
                  responses.length = 0;
                  if (answer) {
                    takeAnswer(answer);
                    await trace.emit({
                      type: 'steer',
                      summary: `Answer: ${truncate(answer.value, 80)}`,
                      data: { messageId: answer.messageId },
                    });
                  } else if (!heartbeatError && latestFlags?.ok !== false) {
                    parkRun = true;
                    finishWith('waiting_input');
                  }
                  // A stop flag during the hold is handled at the top of the loop.
                  break;
                }
                pendingInput = { ...outcome.askUser, session };
                finishWith('waiting_input');
                break;
              }
              if ('needsDevice' in outcome) {
                responses.push(functionResponse(fc, result));
                session.push({ role: 'user', parts: responses });
                await trace.emit({
                  type: 'tool_result',
                  summary: "request_device: moving to the user's Mac",
                  data: { name: fc.name },
                });
                finishWith('needs_device');
                break;
              }
              if ('needsBrowser' in outcome) {
                responses.push(functionResponse(fc, result));
                session.push({ role: 'user', parts: responses });
                await trace.emit({
                  type: 'tool_result',
                  summary: 'request_browser: restarting with a browser',
                  data: { name: fc.name },
                });
                finishWith('needs_browser');
                break;
              }
              if ('finish' in outcome) {
                responses.push(functionResponse(fc, result));
                session.push({ role: 'user', parts: responses });
                await trace.emit({
                  type: 'tool_result',
                  summary: `finish: ${outcome.finish.outcome}`,
                  data: { name: fc.name },
                });
                finishWith('finished', { outcome: outcome.finish.outcome });
                break;
              }
            } catch (err) {
              log('tool failed', { tool: fc.name, err: String(err) });
              result = redact({ error: `Tool failed: ${(err as Error).message}` });
            }
          }
        }
        responses.push(functionResponse(fc, result));
        await trace.emit({
          type: 'tool_result',
          summary: `${fc.name} → ${truncate(JSON.stringify(result), 100)}`,
          data: { name: fc.name, result: truncateValue(result) },
        });
      }
      if (end) break;
      if (responses.length) session.push({ role: 'user', parts: responses });
    }
  } catch (err) {
    log('run failed', { err: String(err) });
    await trace.emit({ type: 'error', summary: truncate((err as Error).message, 200), data: {} });
    finishWith('error', { error: (err as Error).message });
  } finally {
    if (timer) clearInterval(timer);
  }

  const final = end as {
    reason: RunEndReason;
    outcome?: 'done' | 'review' | 'blocked';
    error?: string;
  };
  await trace.emit({
    type: 'run_finished',
    summary: `Run ended: ${final.reason}`,
    data: { steps, outcome: final.outcome },
  });
  // The trace event above must be written while the run is still live; state changes last.
  if (pendingInput) {
    await control.requestInput(pendingInput);
  } else if (final.reason !== 'waiting_input' || parkRun) {
    try {
      await control.finish({
        reason: final.reason,
        error: final.error,
        session,
        outcome: final.outcome,
      });
    } catch (err) {
      log('finish failed', { err: String(err) });
    }
  }
  return { reason: final.reason, steps, session };
}

/** Every current Gemini model takes 1M input tokens. */
const DEFAULT_CONTEXT_WINDOW = 1_048_576;

const user = (text: string): Content => ({ role: 'user', parts: [{ text }] });

function functionResponse(
  fc: NonNullable<Part['functionCall']>,
  response: Record<string, unknown>,
): Part {
  return { functionResponse: { ...(fc.id ? { id: fc.id } : {}), name: fc.name, response } };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function truncateValue(v: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(v);
  return json.length > 4000 ? { truncated: truncate(json, 4000) } : v;
}

/** Time a hold leaves before the worker's deadline, to park the run and stop the browser. */
export const HOLD_DEADLINE_MARGIN_MS = 60_000;

/** How long to hold for an answer: the wanted hold, cut to the time left before the deadline. */
export function holdTime(
  inputHoldMs: number | undefined,
  deadline: number | undefined,
  now = Date.now(),
): number | undefined {
  if (!inputHoldMs) return undefined;
  if (deadline === undefined) return inputHoldMs;
  const left = deadline - HOLD_DEADLINE_MARGIN_MS - now;
  return left >= 60_000 ? Math.min(inputHoldMs, left) : undefined;
}
