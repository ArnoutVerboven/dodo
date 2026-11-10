import { type Run, RunEvent } from '@dodo/core';
import { getBytes, ref } from 'firebase/storage';
import { useEffect, useState } from 'react';
import { useRunEvents } from '@/lib/data';
import { storage } from '@/lib/firebase';
import { argsLine, type StepStatus, showValue, type TraceStep, traceSteps } from '@/lib/trace';
import { cn, formatEur } from '@/lib/utils';

export const LIVE_STATES: Run['state'][] = ['queued', 'dispatching', 'claimed', 'running'];

export const RUN_STATE_LABEL: Record<Run['state'], string> = {
  queued: 'Queued',
  dispatching: 'Starting',
  claimed: 'Starting',
  running: 'Working',
  waiting_input: 'Waiting for you',
  interrupted: 'Stopped',
  budget_exhausted: 'Budget used up',
  succeeded: 'Finished',
  failed: 'Failed',
};

/** "22:41:07": when an event happened, to line a screenshot up with the user's own clock. */
export const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export const isLive = (run: Run) => LIVE_STATES.includes(run.state);

/** "5 steps · €0.012 · gemini-3.8-flash" */
export function runStats(run: Run): string {
  return `${run.steps} ${run.steps === 1 ? 'step' : 'steps'} · ${formatEur(run.spent, 3)} · ${run.model}`;
}

/**
 * The events of a run: live from Firestore while it runs, from the archived JSON blob after.
 * Only mounted when someone opens a trace, so nothing is fetched up front.
 */
function useTrace(run: Run): { events: RunEvent[]; loading: boolean; error?: string } {
  const live = useRunEvents(run.id);
  const [archived, setArchived] = useState<{
    events: RunEvent[];
    loading: boolean;
    error?: string;
  }>({ events: [], loading: !!run.tracePath });
  useEffect(() => {
    if (!run.tracePath) return;
    let cancelled = false;
    getBytes(ref(storage, run.tracePath))
      .then((buf) => {
        const raw = JSON.parse(new TextDecoder().decode(buf)) as unknown[];
        const events = raw.flatMap((e) => {
          const p = RunEvent.safeParse(e);
          return p.success ? [p.data] : [];
        });
        if (!cancelled) setArchived({ events, loading: false });
      })
      .catch((e: Error) => {
        if (!cancelled) setArchived({ events: [], loading: false, error: e.message });
      });
    return () => {
      cancelled = true;
    };
  }, [run.tracePath]);
  if (live.data.length > 0 || !run.tracePath) return { events: live.data, loading: live.loading };
  return archived;
}

/** The steps of a run, optionally only those in a time window (the steps behind one message). */
export function RunTrace({ run, from, to }: { run: Run; from?: number; to?: number }) {
  const { events, loading, error } = useTrace(run);
  const shown = events.filter(
    (e) => (from === undefined || e.createdAt > from) && (to === undefined || e.createdAt <= to),
  );
  return (
    <div className="mt-2 rounded-md border-l-2 border-border pl-3">
      {run.error && <p className="mb-1 text-xs text-danger">{run.error}</p>}
      {loading ? (
        <p className="text-xs text-muted-foreground">Loading steps…</p>
      ) : error ? (
        <p className="text-xs text-danger">Could not load the trace: {error}</p>
      ) : shown.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {isLive(run) ? 'Starting…' : 'No steps recorded.'}
        </p>
      ) : (
        <ol className="space-y-0.5 text-xs">
          {traceSteps(shown).map((step) => (
            <StepLine key={step.id} step={step} />
          ))}
        </ol>
      )}
    </div>
  );
}

const EVENT_STYLE: Partial<Record<RunEvent['type'], string>> = {
  error: 'text-danger',
  steer: 'text-attention',
  run_finished: 'font-medium',
};

const STATUS_STYLE: Record<StepStatus, string> = {
  pending: 'text-muted-foreground',
  ok: 'text-blue-600 dark:text-blue-400',
  error: 'text-danger',
  blocked: 'text-attention',
};

/** One step: a single line that opens to show the full arguments and result. */
function StepLine({ step }: { step: TraceStep }) {
  const [open, setOpen] = useState(false);
  const detail = stepDetail(step);
  return (
    <li>
      <button
        type="button"
        className={cn(
          'flex w-full min-w-0 items-baseline gap-2 rounded px-1 py-0.5 text-left',
          detail && 'hover:bg-accent',
        )}
        onClick={() => detail && setOpen((v) => !v)}
        aria-expanded={detail ? open : undefined}
      >
        <span className="min-w-0 flex-1 truncate">{stepTitle(step)}</span>
        {step.cost !== undefined && step.cost > 0 && (
          <span className="shrink-0 text-muted-foreground tabular-nums">
            {formatEur(step.cost, 4)}
          </span>
        )}
        <span className="hidden shrink-0 text-muted-foreground tabular-nums sm:inline">
          {clock(step.at)}
        </span>
      </button>
      {open && detail && (
        <div className="mt-1 mb-2 space-y-2 rounded bg-muted p-2 font-mono">
          <p className="font-sans text-muted-foreground sm:hidden">{clock(step.at)}</p>
          {detail.map((d) => (
            <div key={d.label}>
              <p className="mb-0.5 font-sans font-medium text-muted-foreground">{d.label}</p>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">
                {d.value}
              </pre>
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

function stepTitle(step: TraceStep) {
  if (step.kind === 'tool') {
    return (
      <span className="font-mono">
        <span className={cn('font-medium', STATUS_STYLE[step.status])}>{step.name}</span>
        <span className="text-muted-foreground">({argsLine(step.args)})</span>
        {step.status === 'pending' && <span className="text-muted-foreground"> …</span>}
      </span>
    );
  }
  if (step.kind === 'text') return <span className="italic">{step.text}</span>;
  return <span className={EVENT_STYLE[step.type]}>{step.summary}</span>;
}

/** What the open row shows; nothing when there is nothing more than the line itself. */
function stepDetail(step: TraceStep): { label: string; value: string }[] | undefined {
  if (step.kind === 'tool') {
    const parts: { label: string; value: string }[] = [];
    if (Object.keys(step.args).length > 0)
      parts.push({ label: 'Arguments', value: showValue(step.args) });
    if (step.note) parts.push({ label: 'Outcome', value: step.note });
    if (step.result !== undefined) parts.push({ label: 'Result', value: showValue(step.result) });
    return parts.length > 0 ? parts : undefined;
  }
  if (step.kind === 'text') return [{ label: 'Reply', value: step.text }];
  return Object.keys(step.data).length > 0
    ? [{ label: 'Details', value: showValue(step.data) }]
    : undefined;
}
