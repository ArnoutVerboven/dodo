import { GeminiRestRequest, type GenerateRequest, type Run } from '@dodo/core';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  type GatewayContext,
  type GatewayDeps,
  generateWithBudget,
  type StreamExtras,
  streamWithBudget,
} from './gateway.js';

/**
 * The gateway in Gemini's own REST shape, for a harness that brings its own Gemini client (pi).
 * Its base URL is `<function url>/v1beta`; the client sends the run's Firebase ID token as its
 * API key (`x-goog-api-key`). Behind it is the same reserve → call → settle as
 * `gatewayGenerate`, so the budget, the hourly governor and the run's lease hold the same way.
 */

export interface GeminiHttpRequest {
  method: string;
  path: string;
  header(name: string): string | undefined;
  body: unknown;
}

/** The part of an Express response the endpoint uses. */
export interface GeminiHttpResponse {
  status(code: number): GeminiHttpResponse;
  setHeader(name: string, value: string): unknown;
  write(chunk: string): unknown;
  end(chunk?: string): unknown;
  flushHeaders?(): void;
  headersSent: boolean;
}

export interface GeminiEndpointDeps {
  gateway: GatewayDeps;
  /** Verifies a Firebase ID token: the caller's uid and custom claims. */
  verifyToken(token: string): Promise<{ uid: string; claims: Record<string, unknown> }>;
  /** The run the caller holds the lease of (`loadRunForCaller`). */
  loadRun(caller: { uid: string; claims: Record<string, unknown> }, runId: string): Promise<Run>;
  context(run: Run, model: string): GatewayContext;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

const PATH = /\/models\/([^/:]+):(streamGenerateContent|generateContent)$/;

/** Gemini 3 thinking levels as budgets, so the gateway can cap them like any other call. */
const LEVEL_BUDGET: Record<string, number> = {
  minimal: 128,
  low: 1024,
  medium: 4096,
  high: 8192,
};

/** A Gemini REST body as the gateway's own request, plus what streaming passes through. */
export function fromGeminiRest(
  model: string,
  body: GeminiRestRequest,
  purpose?: GenerateRequest['purpose'],
): Omit<GenerateRequest, 'runId'> & StreamExtras {
  const sys = body.systemInstruction;
  const systemInstruction =
    typeof sys === 'string'
      ? sys
      : sys?.parts
          .map((p) => p.text ?? '')
          .join('\n')
          .trim() || undefined;
  const tools = body.tools?.flatMap((t) => t.functionDeclarations);
  const gen = body.generationConfig;
  const thinking = gen?.thinkingConfig;
  const level = thinking?.thinkingLevel?.toLowerCase();
  const thinkingBudget =
    thinking?.thinkingBudget !== undefined && thinking.thinkingBudget >= 0
      ? thinking.thinkingBudget
      : level
        ? LEVEL_BUDGET[level]
        : undefined;
  return {
    model,
    contents: body.contents,
    ...(systemInstruction ? { systemInstruction } : {}),
    ...(tools?.length ? { tools } : {}),
    ...(gen?.maxOutputTokens !== undefined ? { maxOutputTokens: gen.maxOutputTokens } : {}),
    ...(gen?.temperature !== undefined ? { temperature: gen.temperature } : {}),
    ...(thinkingBudget !== undefined ? { thinkingBudget } : {}),
    ...(body.toolConfig ? { toolConfig: body.toolConfig } : {}),
    ...(thinking?.includeThoughts ? { includeThoughts: true } : {}),
    ...(purpose ? { purpose } : {}),
  };
}

/** An error the way Gemini's API sends one, so the client's own error handling applies. */
function sendError(res: GeminiHttpResponse, err: unknown) {
  const e =
    err instanceof HttpsError
      ? err
      : new HttpsError('unknown', `Model call failed: ${String(err).slice(0, 500)}`);
  const status = e.httpErrorCode.status;
  const body = {
    error: { code: status, message: e.message, status: e.httpErrorCode.canonicalName },
  };
  if (res.headersSent) {
    // Mid-stream: the status is already 200, so the error goes in as a last event.
    res.write(`data: ${JSON.stringify(body)}\r\n\r\n`);
    res.end();
    return;
  }
  res.status(status).setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

export async function handleGeminiRequest(
  deps: GeminiEndpointDeps,
  req: GeminiHttpRequest,
  res: GeminiHttpResponse,
): Promise<void> {
  let runId: string | undefined;
  try {
    if (req.method !== 'POST') throw new HttpsError('not-found', 'Only POST model calls');
    const match = PATH.exec(req.path);
    if (!match) throw new HttpsError('not-found', `No such endpoint: ${req.path}`);
    const [, model, action] = match as unknown as [string, string, string];

    const bearer = /^Bearer\s+(.+)$/i.exec(req.header('authorization') ?? '')?.[1];
    const token = req.header('x-goog-api-key') || bearer;
    if (!token) throw new HttpsError('unauthenticated', 'Send the run token as the API key');
    let caller: Awaited<ReturnType<GeminiEndpointDeps['verifyToken']>>;
    try {
      caller = await deps.verifyToken(token);
    } catch {
      throw new HttpsError('unauthenticated', 'Invalid or expired run token');
    }
    // Only a run's own identity: the gateway charges a run, and an owner token has none.
    runId = typeof caller.claims.run === 'string' ? caller.claims.run : undefined;
    if (!runId) throw new HttpsError('permission-denied', 'Not a run token');
    const run = await deps.loadRun(caller, runId);

    const parsed = GeminiRestRequest.safeParse(req.body);
    if (!parsed.success) throw new HttpsError('invalid-argument', parsed.error.message);
    const purpose = req.header('x-dodo-purpose') === 'compact' ? 'compact' : undefined;
    const call = fromGeminiRest(decodeURIComponent(model), parsed.data, purpose);
    const ctx = deps.context(run, call.model);

    if (action === 'generateContent') {
      const r = await generateWithBudget(deps.gateway, ctx, call);
      res.status(200).setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          candidates: [{ content: r.content, finishReason: r.finishReason, index: 0 }],
          usageMetadata: {
            promptTokenCount: r.usage.inputTokens,
            candidatesTokenCount: r.usage.outputTokens - r.usage.thinkingTokens,
            thoughtsTokenCount: r.usage.thinkingTokens,
            cachedContentTokenCount: r.usage.cachedInputTokens,
            totalTokenCount: r.usage.inputTokens + r.usage.outputTokens,
          },
        }),
      );
      return;
    }

    // Headers wait for the first chunk: a refusal before it (budget, governor) is a plain
    // HTTP error the client reads as one.
    await streamWithBudget(deps.gateway, ctx, call, (chunk) => {
      if (!res.headersSent) {
        res.status(200);
        res.setHeader('content-type', 'text/event-stream');
        res.setHeader('cache-control', 'no-cache');
        res.flushHeaders?.();
      }
      res.write(`data: ${JSON.stringify(chunk)}\r\n\r\n`);
    });
    if (!res.headersSent) res.status(200).setHeader('content-type', 'text/event-stream');
    res.end();
  } catch (err) {
    if (!(err instanceof HttpsError)) {
      deps.log?.('gemini gateway failed', { runId, err: String(err) });
    }
    sendError(res, err);
  }
}
