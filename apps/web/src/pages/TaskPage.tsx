import {
  type AiConfig,
  type Artifact,
  type Run,
  resolveAiConfig,
  type Task,
  type TaskPriority,
  type TaskStatus,
  type ThreadMessage,
} from '@dodo/core';
import {
  ArrowDown,
  ArrowLeft,
  Bot,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  Folder,
  Link2,
  Loader2,
  type LucideIcon,
  Paperclip,
  Pencil,
  Plus,
  Send,
  Settings2,
  Square,
  Trash2,
  Upload,
  User,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Link, useNavigate, useParams } from 'react-router';
import remarkGfm from 'remark-gfm';
import { AiConfigFields } from '@/components/AiConfigFields';
import { ArtifactPreview, canPreview, downloadArtifact } from '@/components/ArtifactPreview';
import { parseTags } from '@/components/NewTaskDialog';
import { isLive, RUN_STATE_LABEL, RunTrace, runStats } from '@/components/run-trace';
import { SourceLink } from '@/components/SourceIcon';
import {
  dueTone,
  formatDue,
  PRIORITIES,
  priorityMeta,
  STATUSES,
  statusMeta,
} from '@/components/task-meta';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Meter } from '@/components/ui/progress';
import {
  addFileArtifact,
  addLinkArtifact,
  answerInput,
  deleteArtifact,
  deleteTask,
  interruptRun,
  postUserMessage,
  replaceArtifact,
  updateTask,
  useArtifacts,
  useBudgets,
  useMessages,
  useProjects,
  useRuns,
  useSettings,
  useTask,
} from '@/lib/data';
import { pendingInputs } from '@/lib/thread';
import { cn, formatEur, isTyping, timeAgo } from '@/lib/utils';

const PENDING_INPUT_ID = 'pending-input';
const REPLY_ID = 'thread-reply';

export function TaskPage() {
  const { id } = useParams();
  const { data: task, loading } = useTask(id);
  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!task)
    return (
      <p className="text-sm">
        Task not found.{' '}
        <Link className="underline" to="/">
          Back to tasks
        </Link>
      </p>
    );
  return <TaskView task={task} />;
}

function TaskView({ task }: { task: Task }) {
  const navigate = useNavigate();
  // Esc goes back to the task list, unless you are typing somewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || isTyping(e.target)) return;
      navigate('/');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);
  return (
    <div className="space-y-4">
      <Link
        to="/"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        title="Back to tasks (Esc)"
      >
        <ArrowLeft className="h-4 w-4" /> Tasks
      </Link>
      <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
        <div className="min-w-0 space-y-4">
          <div className="space-y-2">
            <TitleEditor task={task} />
            {task.source && <SourceLink source={task.source} />}
            <Description task={task} />
            <PropertyBar task={task} />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <StatusCard task={task} />
            <SummaryCard task={task} />
          </div>
          <Thread taskId={task.id} />
        </div>
        <aside className="space-y-4">
          <AiCard task={task} />
          <ArtifactsCard taskId={task.id} />
          <DangerZone taskId={task.id} />
        </aside>
      </div>
    </div>
  );
}

function TitleEditor({ task }: { task: Task }) {
  const [title, setTitle] = useState(task.title);
  useEffect(() => {
    setTitle(task.title);
  }, [task.title]);
  return (
    <label className="group flex items-center gap-2">
      <textarea
        aria-label="Title"
        rows={1}
        className="-mx-1 w-full resize-none rounded-md bg-transparent px-1 text-xl font-semibold outline-none field-sizing-content hover:bg-accent/50 focus:bg-accent/50"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() =>
          title.trim() &&
          title !== task.title &&
          updateTask(task.id, { title: title.trim(), titleSource: 'user' })
        }
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          }
          if (e.key === 'Escape') {
            setTitle(task.title);
            e.currentTarget.blur();
          }
        }}
      />
      <Pencil className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100" />
    </label>
  );
}

/** One compact row of editable properties in place of a form of labelled boxes. */
function PropertyBar({ task }: { task: Task }) {
  const { data: projects } = useProjects();
  const status = statusMeta(task.status);
  const priority = priorityMeta(task.priority);
  const closed = task.status === 'done' || task.status === 'cancelled';
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <SelectChip
        label="Status"
        icon={status.icon}
        tone={status.tone}
        text={status.label}
        value={task.status}
        options={STATUSES}
        onChange={(v) => updateTask(task.id, { status: v as TaskStatus })}
      />
      <SelectChip
        label="Priority"
        icon={priority.icon}
        tone={priority.tone}
        text={task.priority === 'none' ? 'Priority' : priority.label}
        muted={task.priority === 'none'}
        value={task.priority}
        options={PRIORITIES}
        onChange={(v) => updateTask(task.id, { priority: v as TaskPriority })}
      />
      <DueChip task={task} closed={closed} />
      <SelectChip
        label="Project"
        icon={Folder}
        text={projects.find((p) => p.id === task.projectId)?.name ?? 'Project'}
        muted={!task.projectId}
        value={task.projectId ?? ''}
        options={[
          { value: '', label: 'No project' },
          ...projects.map((p) => ({ value: p.id, label: p.name })),
        ]}
        onChange={(v) => updateTask(task.id, { projectId: v || undefined })}
      />
      <TagEditor task={task} />
    </div>
  );
}

const chip =
  'relative inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition hover:bg-accent focus-within:ring-2 focus-within:ring-primary/30';

/** A chip that opens a native select: looks light, stays accessible and works on mobile. */
function SelectChip({
  label,
  icon: Icon,
  tone,
  text,
  muted = false,
  value,
  options,
  onChange,
}: {
  label: string;
  icon: LucideIcon;
  tone?: string;
  text: string;
  muted?: boolean;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <span className={cn(chip, muted ? 'text-muted-foreground' : 'bg-muted/60')} title={label}>
      <Icon className={cn('h-3.5 w-3.5', tone)} />
      <span>{text}</span>
      <select
        aria-label={label}
        className="absolute inset-0 cursor-pointer opacity-0"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}

function DueChip({ task, closed }: { task: Task; closed: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const open = () => {
    const el = input.current;
    if (!el) return;
    try {
      el.showPicker();
    } catch {
      el.focus();
    }
  };
  return (
    <span
      className={cn(chip, task.dueDate ? 'bg-muted/60' : 'text-muted-foreground')}
      title={task.dueDate ? `Due ${task.dueDate}` : 'Due date'}
    >
      <button type="button" className="inline-flex items-center gap-1.5" onClick={open}>
        <CalendarDays
          className={cn('h-3.5 w-3.5', task.dueDate && dueTone(task.dueDate, closed))}
        />
        <span className={cn(task.dueDate && dueTone(task.dueDate, closed))}>
          {task.dueDate ? formatDue(task.dueDate) : 'Due date'}
        </span>
      </button>
      {task.dueDate && (
        <button
          type="button"
          aria-label="Clear due date"
          className="rounded text-muted-foreground hover:text-foreground"
          onClick={() => updateTask(task.id, { dueDate: undefined })}
        >
          <X className="h-3 w-3" />
        </button>
      )}
      <input
        ref={input}
        type="date"
        aria-label="Due date"
        tabIndex={-1}
        className="pointer-events-none absolute bottom-0 left-0 h-0 w-0 opacity-0"
        value={task.dueDate ?? ''}
        onChange={(e) => updateTask(task.id, { dueDate: e.target.value || undefined })}
      />
    </span>
  );
}

function TagEditor({ task }: { task: Task }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const commit = () => {
    const tags = parseTags([...task.tags, draft].join(','));
    if (tags.length !== task.tags.length) void updateTask(task.id, { tags });
    setDraft('');
  };
  return (
    <>
      {task.tags.map((t) => (
        <span
          key={t}
          className="group inline-flex h-7 items-center gap-1 rounded-md bg-muted/60 px-2 text-xs text-muted-foreground"
        >
          #{t}
          <button
            type="button"
            aria-label={`Remove tag ${t}`}
            className="hidden hover:text-foreground group-hover:inline"
            onClick={() => updateTask(task.id, { tags: task.tags.filter((x) => x !== t) })}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      {adding ? (
        <input
          // biome-ignore lint/a11y/noAutofocus: opened by an explicit click on "Tag"
          autoFocus
          aria-label="New tag"
          className="h-7 w-28 rounded-md border bg-card px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
          placeholder="tag, Enter"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              commit();
            }
            if (e.key === 'Escape') {
              setDraft('');
              setAdding(false);
            }
          }}
          onBlur={() => {
            commit();
            setAdding(false);
          }}
        />
      ) : (
        <button
          type="button"
          className={cn(chip, 'text-muted-foreground')}
          onClick={() => setAdding(true)}
        >
          <Plus className="h-3.5 w-3.5" /> Tag
        </button>
      )}
    </>
  );
}

function StatusCard({ task }: { task: Task }) {
  const s = task.statusLine;
  const needsYou = task.status === 'needs_input' || s?.needsYou;
  return (
    <Card className={cn(needsYou && 'border-attention bg-attention-bg')}>
      <CardHeader
        title={needsYou ? 'Needs you' : 'Status'}
        action={
          needsYou && (
            <Button
              size="sm"
              variant="ghost"
              className="-my-1 h-7"
              onClick={() => {
                // The latest open question, or the reply box when you already answered in the thread.
                const target =
                  document.getElementById(PENDING_INPUT_ID) ?? document.getElementById(REPLY_ID);
                target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                if (target?.id === REPLY_ID) target.focus({ preventScroll: true });
              }}
            >
              Answer <ArrowDown className="h-3.5 w-3.5" />
            </Button>
          )
        }
      />
      <CardBody className="space-y-1 text-sm">
        {s ? (
          <>
            <p>{s.text}</p>
            {s.nextAction && (
              <p className="text-muted-foreground">
                <span className="font-medium text-foreground">Next: </span>
                {s.nextAction}
              </p>
            )}
          </>
        ) : (
          <p className="text-muted-foreground">
            {task.ai.enabled
              ? 'Waiting for the agent to pick this up.'
              : 'AI is off for this task. Turn it on to delegate.'}
          </p>
        )}
      </CardBody>
    </Card>
  );
}

function SummaryCard({ task }: { task: Task }) {
  return (
    <Card>
      <CardHeader title="Summary" />
      <CardBody className="prose-sm max-h-80 overflow-y-auto text-sm">
        {task.summary ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{task.summary}</ReactMarkdown>
        ) : (
          <p className="text-muted-foreground">
            The agent keeps a top-down summary of results and decisions here.
          </p>
        )}
      </CardBody>
    </Card>
  );
}

/** The description sits right under the title as plain text; long ones fold to a few lines. */
function Description({ task }: { task: Task }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(task.description);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setText(task.description);
  }, [task.description]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the text changes
  useEffect(() => {
    const el = body.current;
    if (el) setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [task.description, editing]);
  const save = () => updateTask(task.id, { description: text }).then(() => setEditing(false));
  const cancel = () => {
    setText(task.description);
    setEditing(false);
  };
  if (editing)
    return (
      <div className="space-y-2">
        <Textarea
          autoFocus
          rows={6}
          aria-label="Description"
          className="field-sizing-content"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save();
            if (e.key === 'Escape') cancel();
          }}
        />
        <div className="flex items-center justify-end gap-2">
          <span className="mr-auto text-xs text-muted-foreground">⌘/Ctrl+Enter to save</span>
          <Button size="sm" variant="ghost" onClick={cancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={save}>
            Save
          </Button>
        </div>
      </div>
    );
  return (
    <div className="group relative">
      {task.description ? (
        <div
          ref={body}
          className={cn(
            'prose-sm pr-16 text-sm text-muted-foreground',
            !expanded && 'line-clamp-4',
          )}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{task.description}</ReactMarkdown>
        </div>
      ) : (
        <button
          type="button"
          className="text-sm text-muted-foreground hover:text-foreground"
          onClick={() => setEditing(true)}
        >
          Add a description…
        </button>
      )}
      {(overflows || expanded) && (
        <button
          type="button"
          className="mt-0.5 inline-flex items-center gap-0.5 text-xs font-medium text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? (
            <>
              <ChevronDown className="h-3.5 w-3.5 rotate-180" /> Show less
            </>
          ) : (
            <>
              <ChevronDown className="h-3.5 w-3.5" /> Show more
            </>
          )}
        </button>
      )}
      {task.description && (
        <Button
          size="sm"
          variant="ghost"
          className="absolute top-0 right-0 h-7 text-muted-foreground opacity-60 group-hover:opacity-100"
          onClick={() => setEditing(true)}
        >
          <Pencil className="h-3.5 w-3.5" /> Edit
        </Button>
      )}
    </div>
  );
}

type TimelineItem =
  | { kind: 'message'; at: number; message: ThreadMessage }
  | { kind: 'run'; at: number; run: Run };

/**
 * Messages and agent runs as one timeline. Clicking an agent message opens the steps behind
 * it; a run that ended without a message gets its own row, and a running one sits at the end.
 */
function Thread({ taskId }: { taskId: string }) {
  const { data: messages, loading } = useMessages(taskId);
  const { data: runs } = useRuns(taskId);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const seen = useRef<number | null>(null);
  // Follow new messages as they arrive, but don't jump down to the thread when the page opens.
  useEffect(() => {
    if (loading) return;
    if (seen.current !== null && messages.length > seen.current) {
      end.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    seen.current = messages.length;
  }, [loading, messages.length]);

  const runById = new Map(runs.map((r) => [r.id, r]));
  const byRun = new Map<string, ThreadMessage[]>();
  for (const m of messages) if (m.runId) byRun.set(m.runId, [...(byRun.get(m.runId) ?? []), m]);
  const liveRun = runs.find(isLive);
  const inputs = pendingInputs(messages);
  const items: TimelineItem[] = [
    ...messages.map((m) => ({ kind: 'message' as const, at: m.createdAt, message: m })),
    ...runs
      .filter((r) => !isLive(r) && !byRun.has(r.id))
      .map((r) => ({ kind: 'run' as const, at: r.endedAt ?? r.updatedAt, run: r })),
  ].sort((a, b) => a.at - b.at);

  const send = async () => {
    const text = body.trim();
    if (!text || sending) return;
    setSending(true);
    setBody('');
    try {
      await postUserMessage(taskId, text);
    } catch (err) {
      setBody(text);
      console.error('Could not send the message', err);
    } finally {
      setSending(false);
    }
  };
  return (
    <Card>
      <CardHeader title="Thread" />
      <CardBody className="space-y-1">
        {items.length === 0 && !liveRun && (
          <p className="text-sm text-muted-foreground">No messages yet.</p>
        )}
        {items.map((item) => {
          if (item.kind === 'run') return <RunRow key={item.run.id} run={item.run} />;
          const m = item.message;
          const run = m.runId ? runById.get(m.runId) : undefined;
          // The steps behind a message are those since the run's previous message.
          const siblings = (m.runId && byRun.get(m.runId)) || [];
          const i = siblings.indexOf(m);
          const from = i > 0 ? siblings[i - 1]?.createdAt : undefined;
          const to = i === siblings.length - 1 ? undefined : m.createdAt;
          return (
            <MessageView
              key={m.id}
              taskId={taskId}
              message={m}
              run={run}
              traceFrom={from}
              traceTo={to}
              inputOpen={inputs.open.has(m.id)}
              inputLatest={inputs.latest === m.id}
            />
          );
        })}
        {liveRun && <RunRow run={liveRun} />}
        <div ref={end} />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          className="pt-3"
        >
          <div className="flex items-end gap-2 rounded-lg border bg-card p-1.5 focus-within:ring-2 focus-within:ring-primary/30">
            <Textarea
              id={REPLY_ID}
              rows={1}
              className="max-h-48 min-h-9 resize-none border-0 field-sizing-content focus-visible:ring-0"
              placeholder={
                liveRun ? 'Steer the agent while it works…' : 'Reply or steer the agent…'
              }
              aria-label="Reply"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends; Shift+Enter adds a line. Leave Enter alone while an IME is composing.
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <Button
              type="submit"
              size="icon"
              aria-label="Send"
              title="Send (Enter)"
              disabled={!body.trim() || sending}
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
          <p className="mt-1 px-1 text-xs text-muted-foreground">
            Enter to send · Shift+Enter for a new line
          </p>
        </form>
      </CardBody>
    </Card>
  );
}

/** Clicks on links, buttons, fields or selected text should not toggle the trace. */
function isPlainClick(e: React.MouseEvent): boolean {
  if (window.getSelection()?.toString()) return false;
  return !(e.target as HTMLElement).closest('a,button,input,select,textarea,pre');
}

function StepsToggle({ run, open, onClick }: { run: Run; open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      title={open ? 'Hide steps' : 'Show the steps behind this'}
      className={cn(
        'inline-flex items-center gap-0.5 rounded px-1 hover:bg-muted hover:text-foreground',
        !open && 'opacity-70 group-hover:opacity-100',
      )}
    >
      <ChevronRight className={cn('h-3 w-3 transition', open && 'rotate-90')} />
      {runStats(run)}
    </button>
  );
}

function MessageView({
  taskId,
  message: m,
  run,
  traceFrom,
  traceTo,
  inputOpen,
  inputLatest,
}: {
  taskId: string;
  message: ThreadMessage;
  run?: Run;
  traceFrom?: number;
  traceTo?: number;
  /** An unanswered question with no later message from you. */
  inputOpen: boolean;
  /** The latest such question: the "Answer" button takes you here. */
  inputLatest: boolean;
}) {
  const [open, setOpen] = useState(false);
  const Icon = m.author === 'user' ? User : Bot;
  const toggle = run ? () => setOpen((v) => !v) : undefined;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a shortcut for the steps button in the header
    // biome-ignore lint/a11y/useKeyWithClickEvents: the steps button in the header is the keyboard path
    <div
      onClick={(e) => toggle && isPlainClick(e) && toggle()}
      className={cn(
        'group -mx-2 flex gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-accent/60',
        inputOpen && 'bg-attention-bg/50',
        run && 'cursor-pointer',
        open && 'bg-accent/40',
      )}
    >
      <div
        className={cn(
          'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted transition-colors',
          m.author === 'user' ? 'group-hover:bg-primary/10' : 'group-hover:bg-blue-500/15',
        )}
      >
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">
            {m.author === 'user' ? 'You' : m.author === 'agent' ? 'Agent' : 'System'}
          </span>
          <time title={new Date(m.createdAt).toLocaleString()}>{timeAgo(m.createdAt)}</time>
          {run && toggle && <StepsToggle run={run} open={open} onClick={toggle} />}
        </div>
        <div className="prose-sm cursor-auto text-sm">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.body}</ReactMarkdown>
        </div>
        {open && run && <RunTrace run={run} from={traceFrom} to={traceTo} />}
        {m.input && (
          <InputRequestView taskId={taskId} message={m} open={inputOpen} latest={inputLatest} />
        )}
      </div>
    </div>
  );
}

/** A run with no message of its own: the one working now, or one that ended silently. */
function RunRow({ run }: { run: Run }) {
  const [open, setOpen] = useState(false);
  const live = isLive(run);
  const failed = run.state === 'failed';
  return (
    <div className="group -mx-2 flex gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-accent/60">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted">
        {live ? (
          <Loader2 className="h-4 w-4 animate-spin text-blue-600 dark:text-blue-400" />
        ) : (
          <Bot className="h-4 w-4" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span
            className={cn(
              'font-medium',
              live
                ? 'text-blue-600 dark:text-blue-400'
                : failed
                  ? 'text-danger'
                  : 'text-foreground',
            )}
          >
            Agent · {RUN_STATE_LABEL[run.state]}
            {live && '…'}
          </span>
          <time title={new Date(run.updatedAt).toLocaleString()}>
            {timeAgo(run.endedAt ?? run.updatedAt)}
          </time>
          <StepsToggle run={run} open={open} onClick={() => setOpen((v) => !v)} />
          {live && (
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-6 px-2 text-xs"
              onClick={() => interruptRun(run.id)}
              disabled={run.interrupt}
            >
              <Square className="h-3 w-3" /> {run.interrupt ? 'Stopping…' : 'Stop'}
            </Button>
          )}
        </div>
        {!live && (run.error || run.endReason) && (
          <p className={cn('text-sm', failed ? 'text-danger' : 'text-muted-foreground')}>
            {run.error ?? `Ended: ${run.endReason?.replace('_', ' ')}.`}
          </p>
        )}
        {open && <RunTrace run={run} />}
      </div>
    </div>
  );
}

function InputRequestView({
  taskId,
  message,
  open,
  latest,
}: {
  taskId: string;
  message: ThreadMessage;
  open: boolean;
  latest: boolean;
}) {
  const req = message.input;
  const [reopened, setReopened] = useState(false);
  const [text, setText] = useState('');
  const [rule, setRule] = useState(req?.suggestedRule ?? '');
  // A vault entry is approved per task: the server ignores project and global rules for it.
  const isVault = req?.suggestedRule?.startsWith('Vault(') ?? false;
  const [scope, setScope] = useState<'task' | 'project' | 'global'>(isVault ? 'task' : 'project');
  const [showRule, setShowRule] = useState(false);
  if (!req) return null;
  if (req.answer) {
    return (
      <p className="mt-2 rounded-md bg-muted px-3 py-2 text-sm">
        Answered: <b>{req.answer.value}</b>
        {req.answer.alwaysAllow &&
          ` (always allow ${req.answer.alwaysAllow.rule} in ${req.answer.alwaysAllow.scope})`}
      </p>
    );
  }
  if (!open && !reopened) {
    // You posted a later message in the thread, which replies to this one.
    return (
      <p className="mt-2 text-xs text-muted-foreground">
        You replied in the thread.{' '}
        <button
          type="button"
          className="underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => setReopened(true)}
        >
          Answer this anyway
        </button>
      </p>
    );
  }
  const answer = (value: string, alwaysAllow?: { rule: string; scope: typeof scope }) =>
    answerInput(taskId, message.id, req, value, alwaysAllow);
  const sendText = () => {
    if (!text.trim()) return;
    void answer(req.kind === 'approval' ? `deny: ${text.trim()}` : text.trim());
  };
  return (
    <div
      id={latest ? PENDING_INPUT_ID : undefined}
      className="mt-2 scroll-mt-20 space-y-2 rounded-md border border-attention bg-attention-bg p-3 text-sm"
    >
      {req.prompt.trim() !== message.body.trim() && <p className="font-medium">{req.prompt}</p>}
      {req.costEstimate !== undefined && (
        <p className="text-xs">Estimated cost: {formatEur(req.costEstimate)}</p>
      )}
      {req.kind === 'choice' && (
        <div className="flex flex-wrap gap-2">
          {req.options?.map((o) => (
            <Button key={o} size="sm" variant="outline" onClick={() => answer(o)}>
              {o}
            </Button>
          ))}
        </div>
      )}
      {req.kind === 'approval' && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => answer('approve')}>
              Approve once
            </Button>
            <Button size="sm" variant="outline" onClick={() => answer('deny')}>
              Deny
            </Button>
            {req.suggestedRule !== undefined && (
              <button
                type="button"
                className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                onClick={() => setShowRule((v) => !v)}
              >
                {showRule ? 'Hide' : 'Always allow…'}
              </button>
            )}
          </div>
          {req.suggestedRule !== undefined && showRule && (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="h-8 w-56 font-mono text-xs"
                value={rule}
                onChange={(e) => setRule(e.target.value)}
              />
              <Select
                className="h-8 w-auto text-xs"
                value={scope}
                onChange={(e) => setScope(e.target.value as typeof scope)}
              >
                <option value="task">this task</option>
                {!isVault && <option value="project">this project</option>}
                {!isVault && <option value="global">everywhere</option>}
              </Select>
              <Button
                size="sm"
                variant="outline"
                disabled={!rule.trim()}
                onClick={() => answer('approve', { rule: rule.trim(), scope })}
              >
                Always allow
              </Button>
            </div>
          )}
        </div>
      )}
      {(req.kind === 'text' || req.kind === 'approval') && (
        <div className="flex gap-2">
          <Input
            className="h-8"
            placeholder={req.kind === 'approval' ? 'Deny and tell the agent why…' : 'Your answer…'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                sendText();
              }
            }}
          />
          <Button size="sm" disabled={!text.trim()} onClick={sendText}>
            Send
          </Button>
        </div>
      )}
    </div>
  );
}

function AiCard({ task }: { task: Task }) {
  const { data: projects } = useProjects();
  const { data: settings } = useSettings();
  const { data: budgets } = useBudgets();
  const spend = budgets.find((b) => b.id === `task_${task.id}`) ?? { spent: 0, reserved: 0 };
  const [draft, setDraft] = useState<Partial<AiConfig>>(task.ai);
  useEffect(() => {
    setDraft(task.ai);
  }, [task.ai]);
  const project = projects.find((p) => p.id === task.projectId);
  const resolved = resolveAiConfig(task, project, settings);
  const { enabled: _a, ...draftRest } = draft;
  const { enabled: _b, ...savedRest } = task.ai;
  const dirty = JSON.stringify(draftRest) !== JSON.stringify(savedRest);
  return (
    <Card>
      <CardHeader
        title="AI"
        action={
          <Switch
            label="Let AI work on this task"
            checked={task.ai.enabled}
            onChange={(enabled) => updateTask(task.id, { ai: { ...task.ai, enabled } })}
          />
        }
      />
      <CardBody className="space-y-3">
        <div>
          <div className="mb-1 flex justify-between text-xs">
            <span className="text-muted-foreground">Spent</span>
            <span>
              {formatEur(spend.spent)} of {formatEur(resolved.budget)}
            </span>
          </div>
          <Meter value={spend.spent + spend.reserved} max={resolved.budget} />
          {spend.reserved > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              {formatEur(spend.reserved)} reserved by a running step
            </p>
          )}
        </div>
        <details className="group/adv" open={dirty || undefined}>
          <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <Settings2 className="h-3.5 w-3.5" />
            <span className="min-w-0 flex-1 truncate">
              {resolved.model} · {resolved.device}
            </span>
            <ChevronRight className="h-3.5 w-3.5 transition group-open/adv:rotate-90" />
          </summary>
          <div className="mt-3 space-y-3">
            <AiConfigFields value={draft} onChange={setDraft} showEnabled={false} />
            {dirty && (
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setDraft(task.ai)}>
                  Reset
                </Button>
                <Button
                  size="sm"
                  onClick={() =>
                    updateTask(task.id, { ai: { ...draft, enabled: task.ai.enabled } })
                  }
                >
                  Save
                </Button>
              </div>
            )}
          </div>
        </details>
      </CardBody>
    </Card>
  );
}

function Switch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:outline-none',
        checked ? 'bg-success' : 'bg-muted-foreground/30',
      )}
    >
      <span
        className={cn(
          'inline-block h-4 w-4 rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-4.5' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

function ArtifactsCard({ taskId }: { taskId: string }) {
  const { data: artifacts } = useArtifacts(taskId);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const [previewId, setPreviewId] = useState<string>();
  const replacing = useRef<Artifact>(undefined);
  const fileInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const preview = artifacts.find((a) => a.id === previewId);

  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setError(undefined);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  };
  const upload = (files: File[]) =>
    files.length > 0 &&
    run(
      files.length === 1 ? `Uploading ${files[0]?.name}…` : `Uploading ${files.length} files…`,
      async () => {
        for (const f of files) await addFileArtifact(taskId, f);
      },
    );
  const startReplace = (a: Artifact) => {
    replacing.current = a;
    replaceInput.current?.click();
  };

  return (
    <Card
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        upload([...e.dataTransfer.files]);
      }}
      className={cn(dragging && 'ring-2 ring-primary')}
    >
      <CardHeader
        title="Files & links"
        action={
          <Button
            size="icon"
            variant="ghost"
            className="-my-1 h-7 w-7"
            disabled={!!busy}
            onClick={() => fileInput.current?.click()}
            aria-label="Attach files"
            title="Attach files"
          >
            <Paperclip className="h-4 w-4" />
          </Button>
        }
      />
      <CardBody className="space-y-2">
        <input
          ref={fileInput}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            upload(files);
          }}
        />
        <input
          ref={replaceInput}
          type="file"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            const target = replacing.current;
            e.target.value = '';
            replacing.current = undefined;
            if (!file || !target) return;
            run(`Replacing ${target.name}…`, () => replaceArtifact(taskId, target, file));
          }}
        />
        {artifacts.length > 0 && (
          <ul className="-mx-2">
            {artifacts.map((a) => (
              <li
                key={a.id}
                className="group flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent/60"
              >
                {a.kind === 'link' ? (
                  <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                {canPreview(a) ? (
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left hover:underline"
                    onClick={() => setPreviewId(a.id)}
                    title={`Preview ${a.name}`}
                  >
                    {a.name}
                  </button>
                ) : (
                  <a
                    href={a.url}
                    target="_blank"
                    rel="noreferrer"
                    className="min-w-0 flex-1 truncate hover:underline"
                  >
                    {a.name}
                  </a>
                )}
                {a.role === 'output' && <span className="text-xs text-success">output</span>}
                <span className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
                  {canPreview(a) && (
                    <>
                      <button
                        type="button"
                        onClick={() => run(`Downloading ${a.name}…`, () => downloadArtifact(a))}
                        aria-label={`Download ${a.name}`}
                        title="Download"
                      >
                        <Download className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                      </button>
                      <button
                        type="button"
                        disabled={!!busy}
                        onClick={() => startReplace(a)}
                        aria-label={`Replace ${a.name}`}
                        title="Replace with a file"
                      >
                        <Upload className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => run(`Removing ${a.name}…`, () => deleteArtifact(taskId, a))}
                    aria-label={`Remove ${a.name}`}
                    title="Remove"
                  >
                    <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-danger" />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
        {busy && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> {busy}
          </p>
        )}
        {error && <p className="text-xs text-danger">Didn't work: {error}</p>}
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!url.trim()) return;
            await addLinkArtifact(taskId, '', url.trim());
            setUrl('');
          }}
        >
          <Input
            className="h-8"
            type="url"
            placeholder="Paste a link, press Enter"
            aria-label="Add a link"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </form>
        <p className="text-xs text-muted-foreground">Drop files here to attach them.</p>
      </CardBody>
      <ArtifactPreview
        artifact={preview}
        onClose={() => setPreviewId(undefined)}
        onReplace={startReplace}
      />
    </Card>
  );
}

function DangerZone({ taskId }: { taskId: string }) {
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  return confirming ? (
    <div className="flex items-center gap-2 text-sm">
      Delete this task?
      <Button
        size="sm"
        variant="danger"
        onClick={() => deleteTask(taskId).then(() => navigate('/'))}
      >
        Delete
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
        Keep
      </Button>
    </div>
  ) : (
    <Button
      size="sm"
      variant="ghost"
      className="text-muted-foreground hover:text-danger"
      onClick={() => setConfirming(true)}
    >
      <Trash2 className="h-4 w-4" /> Delete task
    </Button>
  );
}
