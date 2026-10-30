import { z } from 'zod';
import { MicroEur, Timestamp } from './model.js';

/**
 * Phase 2 run schemas: the live trace, the control-plane contracts (callables) and the
 * model-call shapes the gateway passes through to Gemini unchanged.
 */

/** A Gemini `Part`. Kept loose on purpose: the gateway is a passthrough. */
export const Part = z.looseObject({
  text: z.string().optional(),
  thought: z.boolean().optional(),
  thoughtSignature: z.string().optional(),
  functionCall: z
    .looseObject({
      id: z.string().optional(),
      name: z.string(),
      args: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  functionResponse: z
    .looseObject({
      id: z.string().optional(),
      name: z.string(),
      response: z.record(z.string(), z.unknown()),
    })
    .optional(),
});
export type Part = z.infer<typeof Part>;

export const Content = z.object({ role: z.enum(['user', 'model']), parts: z.array(Part) });
export type Content = z.infer<typeof Content>;

/** Tool declaration in Gemini's function-declaration format (JSON schema subset). */
export const FunctionDeclaration = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  /** Full JSON schema instead of `parameters` (MCP servers' own schemas, passed as they are). */
  parametersJsonSchema: z.record(z.string(), z.unknown()).optional(),
});
export type FunctionDeclaration = z.infer<typeof FunctionDeclaration>;

export const GenerateRequest = z.object({
  runId: z.string(),
  model: z.string(),
  systemInstruction: z.string().optional(),
  contents: z.array(Content).min(1),
  tools: z.array(FunctionDeclaration).optional(),
  /** Upper bound the caller wants; the gateway lowers it to what the budget allows. */
  maxOutputTokens: z.number().int().positive().optional(),
  thinkingBudget: z.number().int().nonnegative().optional(),
  temperature: z.number().min(0).max(2).optional(),
  /** `compact`: the call summarises the conversation, so it says nothing of its size. */
  purpose: z.enum(['step', 'compact']).optional(),
});
export type GenerateRequest = z.infer<typeof GenerateRequest>;

export const Usage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  thinkingTokens: z.number().int().nonnegative().default(0),
  cachedInputTokens: z.number().int().nonnegative().default(0),
});
export type Usage = z.infer<typeof Usage>;

export const GenerateResponse = z.object({
  content: Content,
  finishReason: z.string().optional(),
  usage: Usage,
  cost: MicroEur,
  /** Remaining task budget after this call, so the loop can decide to stop early. */
  remaining: MicroEur,
});
export type GenerateResponse = z.infer<typeof GenerateResponse>;

export const HeartbeatRequest = z.object({ runId: z.string() });
export const HeartbeatResponse = z.object({
  ok: z.boolean(),
  /** The run lost its lease or the run document changed state: the worker must stop. */
  reason: z.enum(['halted', 'interrupted', 'lease_lost', 'budget_exhausted']).optional(),
  remaining: MicroEur,
  /** User comments posted since the run started, for steering at the next model call. */
  pendingMessages: z
    .array(z.object({ id: z.string(), body: z.string(), createdAt: Timestamp }))
    .default([]),
  /** The owner asked to compact the conversation before the next model call. */
  compact: z.boolean().default(false),
  /** The answer to the question the run is holding for (see `RequestInputRequest.holdMs`). */
  answer: z
    .object({
      messageId: z.string(),
      prompt: z.string(),
      value: z.string(),
      suggestedRule: z.string().optional(),
      alwaysAllow: z.boolean().optional(),
    })
    .optional(),
});
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;

export const RunEndReason = z.enum([
  'finished',
  'waiting_input',
  'interrupted',
  'budget_exhausted',
  'halted',
  'lease_lost',
  'error',
  'max_steps',
  /** The agent asked for a browser mid-task: the run restarts with one, same session. */
  'needs_browser',
  /** The agent asked for the user's Mac mid-task: the run restarts there, same session. */
  'needs_device',
]);
export type RunEndReason = z.infer<typeof RunEndReason>;

export const FinishRequest = z.object({
  runId: z.string(),
  reason: RunEndReason,
  error: z.string().optional(),
  /** Conversation so far, stored for resumes. */
  session: z.array(Content),
  /** Set when the agent called `finish`: what the user should look at. */
  outcome: z.enum(['done', 'review', 'blocked']).optional(),
});
export type FinishRequest = z.infer<typeof FinishRequest>;

/** Image bytes a worker sends with a question: base64, at most ~6 MB decoded. */
export const ImageUpload = z.object({
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  data: z.string().min(1).max(8_000_000),
});
export type ImageUpload = z.infer<typeof ImageUpload>;

export const RequestInputRequest = z.object({
  runId: z.string(),
  kind: z.enum(['text', 'choice', 'approval']),
  prompt: z.string().min(1),
  options: z.array(z.string()).optional(),
  suggestedRule: z.string().optional(),
  /** The answer is a secret (an MFA code): it reaches the browser, never the model. */
  secret: z.boolean().optional(),
  costEstimate: MicroEur.optional(),
  /** A screenshot to show with the question (in the app and as a Telegram photo). */
  image: ImageUpload.optional(),
  session: z.array(Content),
  /**
   * Keep the run alive this long waiting for the answer, instead of ending it: the heartbeat
   * delivers the answer and the worker continues in the same session (a remote browser keeps
   * its page and logins). The worker parks the run with `finish(waiting_input)` when it runs out.
   */
  holdMs: z.number().int().positive().optional(),
});
export type RequestInputRequest = z.infer<typeof RequestInputRequest>;

export const RequestInputResponse = z.object({
  ok: z.boolean(),
  /** The question's thread message; the worker holds for its answer when it asked to. */
  messageId: z.string().optional(),
});
export type RequestInputResponse = z.infer<typeof RequestInputResponse>;

/**
 * The remote browser's logins (Playwright `storageState`: cookies and local storage) for the
 * run's task, kept between runs by the control plane, encrypted. `get` at the start of a run
 * with a browser, `put` at its end; the Mac keeps its own Chrome profile instead.
 */
export const BrowserStateRequest = z.object({
  runId: z.string(),
  action: z.enum(['get', 'put']),
  /** `put`: the storage state as JSON. */
  state: z.string().max(2_000_000).optional(),
  /** `put`: the page the agent was on when the run ended, as a hint for the next run. */
  lastUrl: z.string().max(2000).optional(),
});
export type BrowserStateRequest = z.infer<typeof BrowserStateRequest>;

export const BrowserStateResponse = z.object({
  ok: z.boolean(),
  /** `get`: the stored state as JSON, when the task has one. */
  state: z.string().optional(),
  lastUrl: z.string().optional(),
});
export type BrowserStateResponse = z.infer<typeof BrowserStateResponse>;

/** One step in the live trace of a run. Written per step, never per token. */
export const RunEventType = z.enum([
  'run_started',
  'model_call',
  'model_response',
  'tool_call',
  'tool_result',
  'steer',
  'compacted',
  'error',
  'run_finished',
]);
export const RunEvent = z.object({
  id: z.string(),
  runId: z.string(),
  seq: z.number().int().nonnegative(),
  type: RunEventType,
  /** Short human-readable line for the collapsed view. */
  summary: z.string(),
  data: z.record(z.string(), z.unknown()).default({}),
  cost: MicroEur.optional(),
  createdAt: Timestamp,
});
export type RunEvent = z.infer<typeof RunEvent>;
