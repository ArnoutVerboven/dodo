import type { Content, Part, RunEndReason } from '@dodo/core';
import type { PolicyEngine } from '@dodo/policy';
import {
  type ControlPlane,
  GatewayBudgetError,
  GatewayHaltedError,
  LeaseLostError,
  type RunInput,
  type TaskStore,
  type TraceSink,
} from './control-plane.js';
import { systemPrompt, taskContext } from './prompt.js';
import { findTool, type ToolDef, toDeclarations } from './tools.js';

export interface LoopOptions {
  control: ControlPlane;
  store: TaskStore;
  trace: TraceSink;
  tools: ToolDef[];
  policy?: PolicyEngine;
  workdir?: string;
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
  const system = systemPrompt(input.task, input.project);

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
    const a = input.answer;
    // An approval answered "yes" (without "always allow", which is already a stored rule)
    // permits that exact call once.
    if (a.suggestedRule && !a.alwaysAllow && /^(y|yes|ok|approve|allow)/i.test(a.value.trim())) {
      opts.policy?.allowOnce(a.suggestedRule);
    }
    session.push(user(`Answer to your question "${a.prompt}":\n${a.value}`));
  } else if (input.trigger === 'comment') {
    const messages = await store.recentMessages(5);
    const latest = messages.filter((m) => m.author === 'user').at(-1);
    session.push(
      user(latest ? `The user commented:\n${latest.body}` : 'The user asked you to continue.'),
    );
  }

  // Heartbeat: lease renewal + infra metering + flags + steering. Also on a timer so a long
  // tool call cannot let the lease expire.
  let latestFlags: Awaited<ReturnType<ControlPlane['heartbeat']>> | undefined;
  let heartbeatError: Error | undefined;
  const beat = async () => {
    try {
      latestFlags = await control.heartbeat();
    } catch (err) {
      heartbeatError = err as Error;
    }
  };
  const timer = opts.heartbeatMs ? setInterval(beat, opts.heartbeatMs) : undefined;
  const seenMessages = new Set<string>();

  let steps = 0;
  let nudges = 0;
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
        session.push(user(`The user commented while you were working:\n${m.body}`));
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
          finishWith('budget_exhausted');
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
      session.push(response.content);
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
              const ctx = { store, policy: opts.policy, workdir: opts.workdir };
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
              result = outcome.result;
              if ('askUser' in outcome) {
                responses.push(functionResponse(fc, result));
                session.push({ role: 'user', parts: responses });
                await trace.emit({
                  type: 'tool_result',
                  summary: `ask_user: ${truncate(outcome.askUser.prompt, 80)}`,
                  data: { name: fc.name },
                });
                pendingInput = { ...outcome.askUser, session };
                finishWith('waiting_input');
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
              result = { error: `Tool failed: ${(err as Error).message}` };
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
      session.push({ role: 'user', parts: responses });
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
  } else if (final.reason !== 'waiting_input') {
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
