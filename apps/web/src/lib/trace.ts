import type { RunEvent } from '@dodo/core';

/** How a tool step ended, for its colour. `pending` while the tool still runs. */
export type StepStatus = 'pending' | 'ok' | 'error' | 'blocked';

/** One row of the trace: a tool call with its result, or a single other event. */
export type TraceStep =
  | {
      kind: 'tool';
      id: string;
      at: number;
      name: string;
      args: Record<string, unknown>;
      /** The result as the tool returned it, or the result line when there is no data. */
      result?: unknown;
      /** The result line ("bash denied by rule …"), shown when the result is not ok. */
      note?: string;
      status: StepStatus;
      /** The model call that chose this tool plus the tool's own cost. */
      cost?: number;
    }
  | {
      kind: 'text';
      id: string;
      at: number;
      text: string;
      cost?: number;
    }
  | {
      kind: 'event';
      id: string;
      at: number;
      type: RunEvent['type'];
      summary: string;
      data: Record<string, unknown>;
      cost?: number;
    };

const addCost = (a: number | undefined, b: number | undefined) =>
  a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);

/** A tool result that did not run the tool, or that came back as an error. */
function resultStatus(e: RunEvent): StepStatus {
  if (/ (denied by|needs approval:|refused:) /.test(e.summary)) return 'blocked';
  const result = e.data.result;
  if (result && typeof result === 'object' && 'error' in result) return 'error';
  return 'ok';
}

/**
 * The events of a run as the steps a person reads: each tool call joined with its result and
 * the cost of the model call that chose it. Model calls go away; a text-only reply stays.
 */
export function traceSteps(events: RunEvent[]): TraceStep[] {
  const steps: TraceStep[] = [];
  // The model's cost waits for the first tool call it chose.
  let modelCost: number | undefined;
  // Tool calls still waiting for their result, oldest first.
  const open: Extract<TraceStep, { kind: 'tool' }>[] = [];

  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    switch (e.type) {
      case 'model_call':
        break;
      case 'model_response': {
        const calls = Array.isArray(e.data.calls) ? e.data.calls : [];
        const text = typeof e.data.text === 'string' ? e.data.text.trim() : '';
        if (calls.length > 0) {
          modelCost = addCost(modelCost, e.cost);
        } else if (e.summary.startsWith('Model call failed')) {
          steps.push({ kind: 'event', id: e.id, at: e.createdAt, type: 'error', summary: e.summary, data: e.data, cost: e.cost });
        } else if (text) {
          steps.push({ kind: 'text', id: e.id, at: e.createdAt, text, cost: e.cost });
        } else if (e.cost) {
          modelCost = addCost(modelCost, e.cost);
        }
        break;
      }
      case 'tool_call': {
        const name = typeof e.data.name === 'string' ? e.data.name : e.summary.replace(/\(.*$/s, '');
        const args =
          e.data.args && typeof e.data.args === 'object'
            ? (e.data.args as Record<string, unknown>)
            : {};
        const step: Extract<TraceStep, { kind: 'tool' }> = {
          kind: 'tool',
          id: e.id,
          at: e.createdAt,
          name,
          args,
          status: 'pending',
          cost: addCost(modelCost, e.cost),
        };
        modelCost = undefined;
        open.push(step);
        steps.push(step);
        break;
      }
      case 'tool_result': {
        const name = typeof e.data.name === 'string' ? e.data.name : undefined;
        const i = open.findIndex((s) => name === undefined || s.name === name);
        const status = resultStatus(e);
        const step = i === -1 ? undefined : open.splice(i, 1)[0];
        if (!step) {
          // Its call is outside the shown window: the result line alone.
          steps.push({ kind: 'event', id: e.id, at: e.createdAt, type: e.type, summary: e.summary, data: e.data, cost: e.cost });
          break;
        }
        step.status = status;
        step.cost = addCost(step.cost, e.cost);
        if ('result' in e.data) step.result = e.data.result;
        if (status !== 'ok' || !('result' in e.data)) step.note = e.summary;
        break;
      }
      default:
        steps.push({ kind: 'event', id: e.id, at: e.createdAt, type: e.type, summary: e.summary, data: e.data, cost: e.cost });
    }
  }
  return steps;
}

/** `{"url":"https://…"}` for the collapsed row; the row itself cuts it to the screen width. */
export function argsLine(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return '';
  return JSON.stringify(args);
}

/** A result for the expanded view: plain text as text, anything else as indented JSON. */
export function showValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && Object.keys(v).length === 1 && 'text' in v) {
    const text = (v as { text: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return JSON.stringify(v, null, 2);
}
