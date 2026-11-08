import type { RunEndReason } from '@dodo/core';
import type { Decision, PolicyEngine } from '@dodo/policy';
import {
  GatewayBudgetError,
  GatewayHaltedError,
  LeaseLostError,
  type TaskStore,
  type TraceSink,
} from './control-plane.js';
import { redactDeep, type SecretResolver } from './secrets.js';
import { findTool, type PolicyClaim, type ToolContext, type ToolDef } from './tools.js';

type AskUser = Extract<Awaited<ReturnType<ToolDef['execute']>>, { askUser: unknown }>['askUser'];

/**
 * What one tool call came to. `result` always goes back to the model; the kind says what the
 * harness must do next. Anything but `continue` ends the run (or, for `ask_user` with a hold,
 * pauses it), however the harness is built.
 */
export type ToolStep =
  | { kind: 'continue'; result: Record<string, unknown> }
  /** The policy asks first: an approval card, then the run ends waiting for the answer. */
  | { kind: 'approval'; result: Record<string, unknown>; suggestedRule: string; prompt: string }
  /** The agent asked the user a question (ask_user). */
  | { kind: 'ask_user'; result: Record<string, unknown>; askUser: AskUser }
  /** The run ends: finish, request_browser, request_device, or a refused paid tool. */
  | {
      kind: 'end';
      result: Record<string, unknown>;
      reason: RunEndReason;
      outcome?: 'done' | 'review' | 'blocked';
      error?: string;
    };

export interface ToolRuntimeOptions {
  tools: ToolDef[];
  store: TaskStore;
  trace: TraceSink;
  policy?: PolicyEngine;
  workdir?: string;
  secrets?: SecretResolver;
  screenshot?: ToolContext['screenshot'];
  log?: (message: string, data?: Record<string, unknown>) => void;
}

/**
 * The one way a tool runs, whichever harness asks: argument checks, the policy decision,
 * the call itself, redaction of vault values, and the trace. A harness hands it the name and
 * arguments the model chose and acts on the step it returns.
 */
export class ToolRuntime {
  readonly tools: ToolDef[];
  private readonly log: NonNullable<ToolRuntimeOptions['log']>;

  constructor(private readonly opts: ToolRuntimeOptions) {
    this.tools = opts.tools;
    this.log = opts.log ?? (() => {});
  }

  /** Vault values never go back to the model, the trace or the task. */
  redact<T>(v: T): T {
    return this.opts.secrets ? redactDeep(v, this.opts.secrets.redact) : v;
  }

  /**
   * The policy decision for an action, for tools a harness brings itself (its own shell or
   * file tools): the same rules, approvals and deny lists as dodo's tools. No engine: deny.
   */
  gate(claim: PolicyClaim): Decision {
    return this.opts.policy?.decide(claim) ?? { kind: 'deny', by: 'no policy engine' };
  }

  async run(name: string, args: Record<string, unknown> | undefined): Promise<ToolStep> {
    const { trace } = this.opts;
    await trace.emit({
      type: 'tool_call',
      summary: `${name}(${truncate(JSON.stringify(args ?? {}), 100)})`,
      data: { name, args: args ?? {} },
    });
    const tool = findTool(this.tools, name);
    if (!tool) return this.done(name, { error: `Unknown tool ${name}` });
    const parsed = tool.schema.safeParse(args ?? {});
    if (!parsed.success) {
      return this.done(name, {
        error: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      });
    }
    try {
      const ctx: ToolContext = {
        store: this.opts.store,
        policy: this.opts.policy,
        workdir: this.opts.workdir,
        secrets: this.opts.secrets,
        screenshot: this.opts.screenshot,
      };
      const claim = tool.policy?.(parsed.data, ctx);
      const decision: Decision = claim ? this.gate(claim) : { kind: 'allow' };
      if (decision.kind === 'deny') {
        await trace.emit({
          type: 'tool_result',
          summary: `${name} denied by ${decision.by}`,
          data: { name },
        });
        return { kind: 'continue', result: { error: `Not allowed (${decision.by}).` } };
      }
      if (decision.kind === 'ask') {
        await trace.emit({
          type: 'tool_result',
          summary: `${name} needs approval: ${decision.suggestedRule}`,
          data: { name },
        });
        return {
          kind: 'approval',
          result: { ok: false, note: 'Needs approval; the run pauses until the user answers.' },
          suggestedRule: decision.suggestedRule,
          prompt: `Allow \`${decision.suggestedRule}\`? ${decision.reason}`,
        };
      }
      const outcome = await tool.execute(parsed.data, { ...ctx, decision });
      const result = this.redact(outcome.result);
      if ('askUser' in outcome) {
        await trace.emit({
          type: 'tool_result',
          summary: `ask_user: ${truncate(outcome.askUser.prompt, 80)}${outcome.askUser.image ? ' (with screenshot)' : ''}`,
          data: { name },
        });
        return { kind: 'ask_user', result, askUser: outcome.askUser };
      }
      if ('needsDevice' in outcome) {
        await trace.emit({
          type: 'tool_result',
          summary: "request_device: moving to the user's Mac",
          data: { name },
        });
        return { kind: 'end', result, reason: 'needs_device' };
      }
      if ('needsBrowser' in outcome) {
        await trace.emit({
          type: 'tool_result',
          summary: 'request_browser: restarting with a browser',
          data: { name },
        });
        return { kind: 'end', result, reason: 'needs_browser' };
      }
      if ('finish' in outcome) {
        await trace.emit({
          type: 'tool_result',
          summary: `finish: ${outcome.finish.outcome}`,
          data: { name },
        });
        return { kind: 'end', result, reason: 'finished', outcome: outcome.finish.outcome };
      }
      return this.done(name, result, outcome.cost);
    } catch (err) {
      // A paid tool the budget, the kill switch or a lost lease refused ends the run the way
      // a refused model call does (a budget end offers the top-up).
      const stop =
        err instanceof GatewayBudgetError
          ? ('budget_exhausted' as const)
          : err instanceof GatewayHaltedError
            ? ('halted' as const)
            : err instanceof LeaseLostError
              ? ('lease_lost' as const)
              : undefined;
      const message = (err as Error).message;
      if (stop) {
        await trace.emit({
          type: 'tool_result',
          summary: `${name} refused: ${truncate(message, 100)}`,
          data: { name },
        });
        return {
          kind: 'end',
          result: { error: `Not run: ${message}` },
          reason: stop,
          ...(stop === 'budget_exhausted' ? { error: message } : {}),
        };
      }
      this.log('tool failed', { tool: name, err: String(err) });
      return this.done(name, this.redact({ error: `Tool failed: ${message}` }));
    }
  }

  /** An ordinary result: traced with its cost, and the run goes on. */
  private async done(
    name: string,
    result: Record<string, unknown>,
    cost?: number,
  ): Promise<ToolStep> {
    await this.opts.trace.emit({
      type: 'tool_result',
      summary: `${name} → ${truncate(JSON.stringify(result), 100)}`,
      data: { name, result: truncateValue(result) },
      ...(cost !== undefined ? { cost } : {}),
    });
    return { kind: 'continue', result };
  }
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function truncateValue(v: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(v);
  return json.length > 4000 ? { truncated: truncate(json, 4000) } : v;
}
