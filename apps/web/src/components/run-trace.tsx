import { type Run, RunEvent } from '@dodo/core';
import { getBytes, ref } from 'firebase/storage';
import { useEffect, useState } from 'react';
import { useRunEvents } from '@/lib/data';
import { storage } from '@/lib/firebase';
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
        <ol className="space-y-0.5 font-mono text-xs">
          {shown.map((e) => (
            <EventLine key={e.id} event={e} />
          ))}
        </ol>
      )}
    </div>
  );
}

const EVENT_STYLE: Partial<Record<RunEvent['type'], string>> = {
  tool_call: 'text-blue-600 dark:text-blue-400',
  error: 'text-danger',
  steer: 'text-attention',
  run_finished: 'font-medium',
};

function EventLine({ event }: { event: RunEvent }) {
  const [open, setOpen] = useState(false);
  const hasData = Object.keys(event.data).length > 0;
  return (
    <li>
      <button
        type="button"
        className={cn(
          'w-full rounded px-1 text-left',
          hasData && 'hover:bg-accent',
          EVENT_STYLE[event.type],
        )}
        onClick={() => hasData && setOpen((v) => !v)}
        aria-expanded={hasData ? open : undefined}
      >
        <span className="text-muted-foreground">{String(event.seq).padStart(3, '0')} </span>
        {event.summary}
        {event.cost !== undefined && (
          <span className="text-muted-foreground"> · {formatEur(event.cost, 4)}</span>
        )}
      </button>
      {open && (
        <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted p-2 whitespace-pre-wrap">
          {JSON.stringify(event.data, null, 2)}
        </pre>
      )}
    </li>
  );
}
