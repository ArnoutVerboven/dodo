import {
  answerTurn,
  COMPACT_SYSTEM,
  type Content,
  commentTurn,
  compactedSession,
  compactionRequest,
  compactThreshold,
  DEFAULT_DRIVE_FOLDER,
  headlessRestartedNote,
  isApproved,
  type Part,
  type RunEndReason,
  reposFor,
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
import { GOOGLE_TOOLS } from './google-tools.js';
import { NOTION_TOOLS } from './notion-tools.js';
import { systemPrompt, taskContext } from './prompt.js';
import { redactDeep, type SecretResolver } from './secrets.js';
import { RunSupervisor } from './supervisor.js';
import { ToolRuntime, truncate } from './tool-runtime.js';
import type { ToolContext, ToolDef } from './tools.js';
import { toDeclarations } from './tools.js';

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
  /**
   * How long heartbeats may keep failing (network, cold start) before the run gives up. Stays
   * under the server's lease; a lost lease ends the run at once whatever this says.
   */
  heartbeatToleranceMs?: number;
  /** The Drive folder the Google tools save to, for the system prompt. */
  googleFolder?: string;
  /** The Notion workspace the Notion tools reach, for the system prompt. */
  notionWorkspace?: string;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

export interface LoopResult {
  reason: RunEndReason;
  steps: number;
  session: Content[];
}

/**
 * The system prompt for a run: dodo's core rules, a section per tool family the run has, an
 * optional harness section (how that harness's own tools work), then the project.
 */
export function runSystemPrompt(
  input: Pick<RunInput, 'task' | 'project'>,
  opts: Pick<
    LoopOptions,
    'tools' | 'browserKind' | 'inputHoldMs' | 'googleFolder' | 'notionWorkspace'
  >,
  harness?: string,
): string {
  const { tools } = opts;
  const hasBrowser = tools.some((t) => t.name.startsWith('browser_'));
  return systemPrompt(input.task, input.project, {
    browser: hasBrowser ? (opts.browserKind ?? 'window') : undefined,
    holdMinutes: hasBrowser && opts.inputHoldMs ? Math.round(opts.inputHoldMs / 60_000) : undefined,
    canRequestBrowser: !hasBrowser && tools.some((t) => t.name === 'request_browser'),
    canRequestDevice: tools.some((t) => t.name === 'request_device'),
    github: tools.some((t) => t.name === 'open_pull_request')
      ? reposFor(input.task, input.project)
      : undefined,
    google: tools.some((t) => GOOGLE_TOOLS.includes(t.name as (typeof GOOGLE_TOOLS)[number]))
      ? (opts.googleFolder ?? DEFAULT_DRIVE_FOLDER)
      : undefined,
    notion: tools.some((t) => NOTION_TOOLS.includes(t.name as (typeof NOTION_TOOLS)[number]))
      ? { workspace: opts.notionWorkspace }
      : undefined,
    ...(harness ? { harness } : {}),
  });
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
  const system = runSystemPrompt(input, opts);
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
    if (a.suggestedRule && !a.alwaysAllow && isApproved(a.value)) {
      opts.policy?.allowOnce(a.suggestedRule);
    }
    session.push(user(answerTurn(a.prompt, a.value)));
  }

  // Heartbeat: lease renewal + infra metering + flags + steering, on a timer too.
  const supervisor = new RunSupervisor(control, {
    heartbeatMs: opts.heartbeatMs,
    heartbeatToleranceMs: opts.heartbeatToleranceMs,
    log,
  });
  supervisor.start();
  const runtime = new ToolRuntime({
    tools,
    store,
    trace,
    policy: opts.policy,
    workdir: opts.workdir,
    secrets: opts.secrets,
    screenshot: opts.screenshot,
    log,
  });

  // Tokens the conversation held at the last model call: the task's figure for a restored one.
  const window = input.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  let contextTokens = input.session.length ? (input.task.context?.tokens ?? 0) : 0;
  let autoCompact = true;

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
      await supervisor.beat();
      const stop = supervisor.stopReason();
      if (stop) {
        finishWith(stop.reason, stop.error ? { error: stop.error } : {});
        break;
      }
      // Steering: comments posted during the run go in before the next model call.
      for (const m of supervisor.takeSteering()) {
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
      const asked = supervisor.takeCompactRequest();
      if (
        (asked || (autoCompact && contextTokens >= compactThreshold(window))) &&
        session.length > 1
      ) {
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
        const step = await runtime.run(fc.name, fc.args);
        responses.push(functionResponse(fc, step.result));
        if (step.kind === 'continue') continue;
        // Every other step ends the run (or holds it): the tool responses so far go in first.
        session.push({ role: 'user', parts: [...responses] });
        responses.length = 0;
        if (step.kind === 'approval') {
          pendingInput = {
            kind: 'approval',
            prompt: step.prompt,
            suggestedRule: step.suggestedRule,
            session,
          };
          finishWith('waiting_input');
          break;
        }
        if (step.kind === 'ask_user') {
          const holdMs = holdTime(opts.inputHoldMs, opts.deadline);
          if (holdMs) {
            // Post the question now and wait here for the answer, lease kept by the
            // heartbeat. No answer in time: park the run exactly as without a hold.
            const answer = await supervisor.holdForAnswer(
              { ...step.askUser, session, holdMs },
              holdMs,
            );
            if (answer) {
              takeAnswer(answer);
              await trace.emit({
                type: 'steer',
                summary: `Answer: ${truncate(answer.value, 80)}`,
                data: { messageId: answer.messageId },
              });
            } else if (!supervisor.stopReason()) {
              parkRun = true;
              finishWith('waiting_input');
            }
            // A stop flag during the hold is handled at the top of the loop.
            break;
          }
          pendingInput = { ...step.askUser, session };
          finishWith('waiting_input');
          break;
        }
        finishWith(step.reason, {
          ...(step.outcome ? { outcome: step.outcome } : {}),
          ...(step.error ? { error: step.error } : {}),
        });
        break;
      }
      if (end) break;
      if (responses.length) session.push({ role: 'user', parts: responses });
    }
  } catch (err) {
    log('run failed', { err: String(err) });
    await trace.emit({ type: 'error', summary: truncate((err as Error).message, 200), data: {} });
    finishWith('error', { error: (err as Error).message });
  } finally {
    supervisor.stop();
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
