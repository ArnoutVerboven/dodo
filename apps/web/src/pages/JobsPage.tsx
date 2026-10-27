import {
  type GmailFollowupConfig,
  gmailConfig,
  type JobRun,
  type RunEntry,
} from '@dodo/jobs/model';
import { ChevronRight, FlaskConical, Loader2, Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { SourceIcon } from '@/components/SourceIcon';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Input, Label, Select, Textarea } from '@/components/ui/input';
import { useBudgets, useProjects } from '@/lib/data';
import {
  connectGoogle,
  disconnectGoogle,
  runJobNow,
  saveJob,
  useConnector,
  useJob,
  useJobRuns,
} from '@/lib/jobs';
import { cn, formatEur, timeAgo } from '@/lib/utils';

const GMAIL_JOB = 'gmail-followup';

const CONNECT_RESULT: Record<string, string> = {
  connected: 'Google is connected.',
  missing_scopes: 'Some permissions were not granted. Connect again and tick every box.',
  cancelled: 'Connecting Google was cancelled.',
  invalid_state: 'That sign-in link expired. Try again.',
  not_configured: 'Google is not set up for this deployment yet.',
  error: 'Connecting Google failed. Try again.',
};

/** The Jobs tab: pipelines that watch your mail and put tasks on the board (docs/JOBS.md). */
export function JobsPage() {
  const [params, setParams] = useSearchParams();
  const result = params.get('google');
  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Jobs</h1>
        <p className="text-sm text-muted-foreground">
          Jobs watch your inbox and turn messages that need you into tasks, with a reply drafted for
          your approval. Nothing is sent without your Yes.
        </p>
      </div>
      {result && (
        <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <span>{CONNECT_RESULT[result] ?? result}</span>
          <Button size="sm" variant="ghost" onClick={() => setParams({})}>
            Dismiss
          </Button>
        </div>
      )}
      <GoogleCard />
      <GmailJobCard />
      <Card className="opacity-70">
        <CardHeader title="WhatsApp follow-ups" />
        <CardBody className="flex items-center gap-2 text-sm text-muted-foreground">
          <SourceIcon source={{ kind: 'whatsapp' }} />
          Not built yet. There is no official WhatsApp API for personal accounts; see docs/JOBS.md
          for the options.
        </CardBody>
      </Card>
    </div>
  );
}

function GoogleCard() {
  const { data: connector, loading } = useConnector('google');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
    setBusy(false);
  };
  const connected = connector?.status === 'connected';
  return (
    <Card>
      <CardHeader
        title="Google account"
        action={
          !loading && (
            <div className="flex gap-1">
              {connected && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => act(disconnectGoogle)}
                >
                  Disconnect
                </Button>
              )}
              <Button
                size="sm"
                variant={connected ? 'outline' : 'default'}
                disabled={busy}
                onClick={() => act(connectGoogle)}
              >
                {connector && connector.status !== 'disconnected' ? 'Reconnect' : 'Connect Google'}
              </Button>
            </div>
          )
        }
      />
      <CardBody className="space-y-1 text-sm">
        {connected ? (
          <p className="flex items-center gap-2">
            <SourceIcon source={{ kind: 'gmail' }} />
            Connected as <b>{connector.email ?? 'your account'}</b>
            <span className="text-xs text-muted-foreground">
              · Gmail (read, drafts) and Calendar (free/busy, events you approve)
            </span>
          </p>
        ) : (
          <p className="text-muted-foreground">
            {connector?.error ??
              'Connect the Google account whose inbox the jobs should watch. Jobs read the inbox, write drafts and read your free/busy time; they never archive, label or delete mail.'}
          </p>
        )}
        {error && <p className="text-danger">{error}</p>}
      </CardBody>
    </Card>
  );
}

function GmailJobCard() {
  const { data: job, loading } = useJob(GMAIL_JOB);
  const { data: connector } = useConnector('google');
  const { data: budgets } = useBudgets();
  const { data: runs } = useJobRuns(GMAIL_JOB);
  const [running, setRunning] = useState<'run' | 'dry' | undefined>();
  const [error, setError] = useState<string>();
  const [showSettings, setShowSettings] = useState(false);
  if (loading) return null;
  const config = gmailConfig(job?.config);
  const month = new Date().toISOString().slice(0, 7);
  const spend = budgets.find((b) => b.id === `job_${GMAIL_JOB}_${month}`);
  const connected = connector?.status === 'connected';
  const run = async (dryRun: boolean) => {
    setRunning(dryRun ? 'dry' : 'run');
    setError(undefined);
    try {
      if (!job) await saveJob(GMAIL_JOB, 'gmail-followup', false, {});
      const res = await runJobNow(GMAIL_JOB, dryRun);
      if (res.state === 'skipped' || res.state === 'failed') setError(res.error ?? res.state);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(undefined);
    }
  };
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <SourceIcon source={{ kind: 'gmail' }} /> Email follow-ups
          </span>
        }
        action={
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={!!job?.enabled}
              disabled={!connected && !job?.enabled}
              onChange={(e) =>
                saveJob(GMAIL_JOB, 'gmail-followup', !!job, { enabled: e.target.checked })
              }
            />
            {job?.enabled ? 'On' : 'Off'}
          </label>
        }
      />
      <CardBody className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Every {config.intervalMinutes} minutes: inbox threads
          {config.primaryOnly ? ' in Primary' : ''} whose last message is someone else's and at
          least {config.unansweredMinutes} minutes old (looking back {config.lookbackDays} days).
          Each message is handled once; at most {config.maxItemsPerRun} per run and{' '}
          {config.maxTasksPerDay} new tasks a day.
        </p>
        {job?.state.pausedReason && !job.enabled && (
          <p className="text-danger">{job.state.pausedReason}</p>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>
            Last run:{' '}
            {job?.state.lastRunAt
              ? `${timeAgo(job.state.lastRunAt)} · ${job.state.lastResult ?? ''}`
              : 'never'}
          </span>
          <span>
            This month: {formatEur(spend?.spent ?? 0)} of {formatEur(config.monthlyBudget)}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={!connected || !!running} onClick={() => run(false)}>
            {running === 'run' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            Run now
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!connected || !!running}
            onClick={() => run(true)}
          >
            {running === 'dry' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FlaskConical className="h-3.5 w-3.5" />
            )}
            Dry run
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setShowSettings((v) => !v)}>
            {showSettings ? 'Hide settings' : 'Settings'}
          </Button>
        </div>
        {error && <p className="text-danger">{error}</p>}
        {showSettings && (
          <GmailSettings
            config={config}
            onSave={(c) => saveJob(GMAIL_JOB, 'gmail-followup', !!job, { config: c })}
          />
        )}
        <RunList runs={runs} />
      </CardBody>
    </Card>
  );
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function GmailSettings({
  config,
  onSave,
}: {
  config: GmailFollowupConfig;
  onSave: (c: GmailFollowupConfig) => Promise<void>;
}) {
  const { data: projects } = useProjects();
  const [draft, setDraft] = useState(config);
  const [saved, setSaved] = useState(false);
  useEffect(() => setDraft(config), [config]);
  const set = <K extends keyof GmailFollowupConfig>(k: K, v: GmailFollowupConfig[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));
  const num = (k: keyof GmailFollowupConfig, label: string, min: number, max: number) => (
    <label>
      <Label>{label}</Label>
      <Input
        type="number"
        min={min}
        max={max}
        value={String(draft[k])}
        onChange={(e) =>
          set(k, Math.min(max, Math.max(min, Number(e.target.value) || min)) as never)
        }
      />
    </label>
  );
  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-3">
      <div className="grid gap-3 sm:grid-cols-3">
        {num('unansweredMinutes', 'Unanswered for (minutes)', 15, 10080)}
        {num('lookbackDays', 'Look back (days)', 1, 14)}
        {num('intervalMinutes', 'Run every (minutes)', 15, 1440)}
        {num('maxItemsPerRun', 'Max messages per run', 1, 25)}
        {num('maxTasksPerDay', 'Max new tasks per day', 1, 50)}
        <label>
          <Label>Monthly budget (EUR, max 10)</Label>
          <Input
            type="number"
            min={0}
            max={10}
            step={0.5}
            value={draft.monthlyBudget / 1e6}
            onChange={(e) =>
              set(
                'monthlyBudget',
                Math.round(Math.min(10, Math.max(0, Number(e.target.value))) * 1e6),
              )
            }
          />
        </label>
        <label>
          <Label>Project for new tasks</Label>
          <Select
            value={draft.projectId ?? ''}
            onChange={(e) => set('projectId', e.target.value || undefined)}
          >
            <option value="">No project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </label>
        <label>
          <Label>Tags</Label>
          <Input
            value={draft.tags.join(', ')}
            onChange={(e) =>
              set(
                'tags',
                e.target.value
                  .split(',')
                  .map((t) => t.trim())
                  .filter(Boolean),
              )
            }
          />
        </label>
        <label>
          <Label>Time zone (empty: your calendar's)</Label>
          <Input
            placeholder="Europe/Brussels"
            value={draft.timezone ?? ''}
            onChange={(e) => set('timezone', e.target.value.trim() || undefined)}
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-xs font-medium text-muted-foreground">Propose times</span>
        <Input
          className="h-8 w-24"
          type="time"
          aria-label="Earliest time"
          value={draft.workingHours.start}
          onChange={(e) => set('workingHours', { ...draft.workingHours, start: e.target.value })}
        />
        <span className="text-xs">to</span>
        <Input
          className="h-8 w-24"
          type="time"
          aria-label="Latest time"
          value={draft.workingHours.end}
          onChange={(e) => set('workingHours', { ...draft.workingHours, end: e.target.value })}
        />
        <span className="flex gap-1">
          {DAYS.map((d, i) => {
            const day = i + 1;
            const on = draft.workingHours.days.includes(day);
            return (
              <button
                key={d}
                type="button"
                aria-pressed={on}
                className={cn(
                  'rounded px-1.5 py-0.5 text-xs',
                  on ? 'bg-primary text-primary-foreground' : 'bg-muted',
                )}
                onClick={() =>
                  set('workingHours', {
                    ...draft.workingHours,
                    days: on
                      ? draft.workingHours.days.filter((x) => x !== day)
                      : [...draft.workingHours.days, day].sort(),
                  })
                }
              >
                {d}
              </button>
            );
          })}
        </span>
      </div>
      <label className="block">
        <Label>
          About you (the agent reads this with every email: schedule, preferences, people)
        </Label>
        <Textarea
          rows={3}
          value={draft.context}
          maxLength={2000}
          onChange={(e) => set('context', e.target.value)}
        />
      </label>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {(
          [
            ['primaryOnly', 'Primary tab only'],
            ['skipBulk', 'Skip newsletters and automated mail'],
            ['draftReplies', 'Draft replies'],
            ['notify', 'Notify me (push, Telegram)'],
          ] as const
        ).map(([k, label]) => (
          <label key={k} className="flex items-center gap-1.5">
            <input type="checkbox" checked={draft[k]} onChange={(e) => set(k, e.target.checked)} />
            {label}
          </label>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={async () => {
            await onSave(draft);
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
          }}
        >
          Save
        </Button>
        {saved && <span className="text-xs text-muted-foreground">Saved</span>}
      </div>
    </div>
  );
}

const DECISION_LABEL: Record<RunEntry['decision'], string> = {
  create: 'New task',
  update: 'Updated',
  ignore: 'Ignored',
  skip: 'Skipped',
  error: 'Failed',
};

function RunList({ runs }: { runs: JobRun[] }) {
  if (!runs.length) return <p className="text-xs text-muted-foreground">No runs yet.</p>;
  return (
    <div>
      <h4 className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Recent runs
      </h4>
      <ul className="divide-y rounded-md border">
        {runs.map((r) => (
          <RunRow key={r.id} run={r} />
        ))}
      </ul>
    </div>
  );
}

function RunRow({ run }: { run: JobRun }) {
  const [open, setOpen] = useState(false);
  const c = run.counts;
  const parts = [
    c.created && `${c.created} new`,
    c.updated && `${c.updated} updated`,
    c.resolved && `${c.resolved} closed`,
    c.ignored && `${c.ignored} ignored`,
    c.skipped && `${c.skipped} skipped`,
    c.failed && `${c.failed} failed`,
  ].filter(Boolean);
  return (
    <li className="px-3 py-2">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left text-xs"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ChevronRight className={cn('h-3 w-3 transition', open && 'rotate-90')} />
        <span className="w-16 text-muted-foreground">{timeAgo(run.startedAt)}</span>
        {run.dryRun && <span className="rounded bg-muted px-1">dry run</span>}
        <span className={cn(run.state === 'failed' && 'text-danger')}>
          {run.state === 'running'
            ? 'Running…'
            : run.state === 'succeeded'
              ? ''
              : `${run.state.replace('_', ' ')} · `}
          {run.state !== 'running' && (parts.length ? parts.join(', ') : 'nothing new')}
        </span>
        <span className="ml-auto text-muted-foreground">{formatEur(run.spent, 3)}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-2 pl-5 text-xs">
          {run.error && <p className="text-danger">{run.error}</p>}
          {run.entries.length === 0 && !run.error && (
            <p className="text-muted-foreground">No messages needed a look.</p>
          )}
          {run.entries.map((e) => (
            <div key={`${e.threadId}-${e.decision}-${e.subject}`} className="space-y-0.5">
              <p>
                <b>{DECISION_LABEL[e.decision]}</b> · {e.from} · {e.subject}
                {e.taskId && (
                  <>
                    {' · '}
                    <Link className="underline" to={`/tasks/${e.taskId}`}>
                      {e.title ?? 'task'}
                    </Link>
                  </>
                )}
                {!e.taskId && e.title && ` · ${e.title}`}
              </p>
              {e.reason && <p className="text-muted-foreground">{e.reason}</p>}
              {e.draft && run.dryRun && (
                <pre className="whitespace-pre-wrap rounded bg-muted/50 p-2 font-sans">
                  {e.draft}
                </pre>
              )}
              {e.event && <p className="text-muted-foreground">Calendar: {e.event}</p>}
            </div>
          ))}
        </div>
      )}
    </li>
  );
}
