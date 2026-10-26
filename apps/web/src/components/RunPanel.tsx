import type { Run, RunEvent } from '@dodo/core';
import { ChevronDown, ChevronRight, Square } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { interruptRun, useRunEvents, useRuns } from '@/lib/data';
import { cn, formatEur, timeAgo } from '@/lib/utils';

const LIVE: Run['state'][] = ['queued', 'dispatching', 'claimed', 'running'];

const STATE_LABEL: Record<Run['state'], string> = {
  queued: 'Queued',
  dispatching: 'Starting',
  claimed: 'Starting',
  running: 'Running',
  waiting_input: 'Waiting for you',
  interrupted: 'Stopped',
  budget_exhausted: 'Budget used up',
  succeeded: 'Finished',
  failed: 'Failed',
};

/** Agent activity on a task: the live trace of the current run and the history of past runs. */
export function RunPanel({ taskId }: { taskId: string }) {
  const { data: runs } = useRuns(taskId);
  if (runs.length === 0) return null;
  const [latest, ...older] = runs as [Run, ...Run[]];
  return (
    <Card>
      <CardHeader title="Agent activity" />
      <CardBody className="space-y-3">
        <RunRow run={latest} open />
        {older.length > 0 && (
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">
              {older.length} earlier {older.length === 1 ? 'run' : 'runs'}
            </summary>
            <div className="mt-2 space-y-2">
              {older.map((r) => (
                <RunRow key={r.id} run={r} />
              ))}
            </div>
          </details>
        )}
      </CardBody>
    </Card>
  );
}

function RunRow({ run, open = false }: { run: Run; open?: boolean }) {
  const [expanded, setExpanded] = useState(open);
  const live = LIVE.includes(run.state);
  return (
    <div className="rounded-md border text-sm">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          className="flex items-center gap-1 text-left"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          <span
            className={cn(
              'rounded px-1.5 text-xs font-medium',
              live ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
            )}
          >
            {STATE_LABEL[run.state]}
          </span>
        </button>
        <span className="text-xs text-muted-foreground">
          {run.model} · {run.steps} {run.steps === 1 ? 'step' : 'steps'} · {formatEur(run.spent, 3)}{' '}
          · {timeAgo(run.endedAt ?? run.updatedAt)}
        </span>
        <span className="flex-1" />
        {live && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => interruptRun(run.id)}
            disabled={run.interrupt}
          >
            <Square className="mr-1 h-3 w-3" /> {run.interrupt ? 'Stopping…' : 'Stop'}
          </Button>
        )}
      </div>
      {expanded && (
        <div className="border-t px-3 py-2">
          {run.error && <p className="mb-2 text-xs text-destructive">{run.error}</p>}
          {live ? (
            <LiveTrace runId={run.id} />
          ) : (
            <p className="text-xs text-muted-foreground">
              {run.endReason ? `Ended: ${run.endReason}.` : ''}{' '}
              {run.tracePath ? 'The full trace is archived with the task.' : 'No trace recorded.'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function LiveTrace({ runId }: { runId: string }) {
  const { data: events } = useRunEvents(runId);
  if (events.length === 0) return <p className="text-xs text-muted-foreground">Starting…</p>;
  return (
    <ol className="space-y-1 font-mono text-xs">
      {events.map((e) => (
        <EventLine key={e.id} event={e} />
      ))}
    </ol>
  );
}

const EVENT_STYLE: Partial<Record<RunEvent['type'], string>> = {
  tool_call: 'text-primary',
  error: 'text-destructive',
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
        className={cn('w-full text-left hover:underline', EVENT_STYLE[event.type])}
        onClick={() => hasData && setOpen((v) => !v)}
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
