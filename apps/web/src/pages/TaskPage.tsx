import {
  type AiConfig,
  type Artifact,
  compactThreshold,
  formatTokens,
  formatTokenUsage,
  type Run,
  resolveAiConfig,
  type Task,
  type TaskPriority,
  type TaskStatus,
  type ThreadMessage,
  tokenUnit,
} from '@dodo/core';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Bot,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  Folder,
  HardDrive,
  Info,
  Link2,
  Loader2,
  type LucideIcon,
  Minimize2,
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
import { appendText, parseTags } from '@/components/NewTaskDialog';
import { PushToTalkButton } from '@/components/PushToTalk';
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
import { useAuth } from '@/lib/auth';
import {
  addFileArtifact,
  addLinkArtifact,
  answerInput,
  answerSecretInput,
  compactTask,
  deleteArtifact,
  deleteTask,
  interruptRun,
  postUserMessage,
  replaceArtifact,
  storedFileUrl,
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
import { cn, formatEur, formatEurCents, isTyping, timeAgo } from '@/lib/utils';

const PENDING_INPUT_ID = 'pending-input';
const REPLY_ID = 'thread-reply';

/** A file the agent saved to Google Drive (drive_save_file) is attached as its Drive link. */
const isDriveUrl = (url?: string) => !!url && /^https:\/\/(drive|docs)\.google\.com\//.test(url);

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
          {/* Phone: Status, Summary, Thread stacked. Wider: Status and Summary on the left 2/5,
              the thread on the right 3/5, each side scrolling on its own. */}
          <div className="grid items-start gap-4 md:grid-cols-5">
            <div className="min-w-0 space-y-4 md:col-span-2">
              <StatusCard task={task} />
              <SummaryCard task={task} />
            </div>
            <Thread taskId={task.id} className="md:col-span-3" />
          </div>
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

/**
 * Takes you to the latest open question and puts the cursor where you type the answer: its own
 * answer box, or the reply box for a question answered with buttons or already replied to.
 */
function openAnswer() {
  const question = document.getElementById(PENDING_INPUT_ID);
  const field =
    question?.querySelector<HTMLInputElement>('input[data-answer]') ??
    document.getElementById(REPLY_ID);
  question?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  field?.focus({ preventScroll: !!question });
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
            <Button size="sm" variant="ghost" className="-my-1 h-7" onClick={openAnswer}>
              Answer
              {/* The thread sits below on a phone and to the right from md up. */}
              <ArrowDown className="h-3.5 w-3.5 md:hidden" />
              <ArrowRight className="hidden h-3.5 w-3.5 md:block" />
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
      <CardBody className="prose-sm max-h-80 overflow-y-auto text-sm md:max-h-[calc(100dvh-16rem)]">
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
function Thread({ taskId, className }: { taskId: string; className?: string }) {
  const { data: messages, loading } = useMessages(taskId);
  const { data: runs } = useRuns(taskId);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  // The thread opens on the newest message and stays there as messages arrive or grow,
  // until you scroll up to read history; scrolling back to the bottom pins it again.
  const pinned = useRef(true);
  const onScroll = () => {
    const el = scroller.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    const stick = () => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    };
    stick();
    const observer = new ResizeObserver(stick);
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!loading && pinned.current && scroller.current) {
      scroller.current.scrollTop = scroller.current.scrollHeight;
    }
  }, [loading]);

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
    <Card
      className={cn(
        'flex min-w-0 flex-col md:sticky md:top-16 md:max-h-[calc(100dvh-5rem)]',
        className,
      )}
    >
      <CardHeader title="Thread" />
      <div
        ref={scroller}
        onScroll={onScroll}
        className="min-h-0 flex-1 overscroll-contain md:overflow-y-auto"
      >
        <div ref={content} className="space-y-1 px-4 pt-2 pb-1">
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
        </div>
      </div>
      <CardBody className="pt-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <div className={composer}>
            <Textarea
              id={REPLY_ID}
              rows={1}
              className="max-h-48 min-h-8 resize-none border-0 bg-transparent px-2 field-sizing-content focus-visible:ring-0"
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
            <PushToTalkButton compact onText={(text) => setBody((b) => appendText(b, text))} />
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
            Enter to send · Shift+Enter for a new line · hold the mic to dictate
          </p>
        </form>
      </CardBody>
    </Card>
  );
}

/** A reply box: one border around the field and its icon buttons, which line up with the text. */
const composer =
  'flex items-end gap-1 rounded-lg border bg-card p-1 focus-within:ring-2 focus-within:ring-primary/30';

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
        {m.input?.image && <QuestionImage storagePath={m.input.image.storagePath} />}
        {open && run && <RunTrace run={run} from={traceFrom} to={traceTo} />}
        {m.input && (
          <InputRequestView taskId={taskId} message={m} open={inputOpen} latest={inputLatest} />
        )}
      </div>
    </div>
  );
}

/** The screenshot the agent sent with a question (a QR code to scan, the icon to pick). */
function QuestionImage({ storagePath }: { storagePath: string }) {
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    storedFileUrl(storagePath).then(
      (u) => live && setUrl(u),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [storagePath]);
  if (failed) return <p className="mt-2 text-xs text-muted-foreground">Screenshot unavailable.</p>;
  if (!url) return <div className="mt-2 h-40 w-64 animate-pulse rounded-md bg-muted" />;
  return (
    <a href={url} target="_blank" rel="noreferrer" className="mt-2 inline-block cursor-zoom-in">
      <img
        src={url}
        alt="Screenshot from the agent's browser"
        className="max-h-96 max-w-full rounded-md border bg-white object-contain"
      />
    </a>
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

/** Approval buttons are taller on a phone, so they are easy to tap. */
const TOUCH_SIZE = 'h-10 sm:h-8';

const SCOPE_LABEL = {
  task: 'for this task',
  project: 'for this project',
  global: 'everywhere',
} as const;

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
  const [secretError, setSecretError] = useState<string>();
  const [rule, setRule] = useState(req?.suggestedRule ?? '');
  // A vault entry is approved per task: the server ignores project and global rules for it.
  const isVault = req?.suggestedRule?.startsWith('Vault(') ?? false;
  const { data: task } = useTask(taskId);
  // Without a project the server stores a "project" rule on the task, so offer task instead.
  const hasProject = !!task?.projectId;
  const [pickedScope, setScope] = useState<'task' | 'project' | 'global'>();
  const scope = pickedScope ?? (isVault || !hasProject ? 'task' : 'project');
  const [showRule, setShowRule] = useState(false);
  if (!req) return null;
  if (req.answer) {
    if (req.secret) {
      return (
        <p className="mt-2 flex items-start gap-2 text-sm">
          <UserAvatar />
          <span className="text-muted-foreground">
            A code (hidden; it went straight to the browser).
          </span>
        </p>
      );
    }
    return (
      <p className="mt-2 flex items-start gap-2 text-sm">
        <UserAvatar />
        <span className="min-w-0">
          {req.answer.value}
          {req.answer.alwaysAllow && (
            <>
              {' '}
              (always allow <code className="text-xs">{req.answer.alwaysAllow.rule}</code>{' '}
              {SCOPE_LABEL[req.answer.alwaysAllow.scope]},{' '}
              <Link
                to="/tools?tab=permissions#allowed-actions"
                className="underline underline-offset-2"
              >
                manage
              </Link>
              )
            </>
          )}
        </span>
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
    if (req.secret) {
      setSecretError(undefined);
      answerSecretInput(taskId, message.id, text.trim()).then(
        () => setText(''),
        (err: Error) => setSecretError(err.message || 'Could not send the code'),
      );
      return;
    }
    void answer(req.kind === 'approval' ? `deny: ${text.trim()}` : text.trim());
  };
  return (
    <div id={latest ? PENDING_INPUT_ID : undefined} className="mt-2 scroll-mt-20 space-y-2 text-sm">
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
            <Button size="sm" className={TOUCH_SIZE} onClick={() => answer('approve')}>
              Allow once
            </Button>
            {req.suggestedRule !== undefined && (
              // A split button: the main part allows at the default scope, only the chevron
              // opens the scope menu. One select over the whole button made a tap on a phone
              // open the menu instead of allowing.
              <span className="inline-flex">
                <Button
                  size="sm"
                  variant="outline"
                  className={cn(TOUCH_SIZE, 'rounded-r-none')}
                  title={`Always allow ${req.suggestedRule} ${SCOPE_LABEL[scope]}`}
                  onClick={() => answer('approve', { rule: req.suggestedRule ?? '', scope })}
                >
                  Allow always
                </Button>
                <span className="relative -ml-px inline-flex">
                  <Button
                    size="sm"
                    variant="outline"
                    className={cn(TOUCH_SIZE, 'w-10 justify-center rounded-l-none px-0 sm:w-8')}
                    tabIndex={-1}
                    aria-hidden
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                  <select
                    aria-label="Allow always: choose where"
                    title="Choose where to always allow"
                    className="absolute inset-0 cursor-pointer opacity-0"
                    value=""
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === 'edit') setShowRule(true);
                      else if (v)
                        void answer('approve', {
                          rule: req.suggestedRule ?? '',
                          scope: v as typeof scope,
                        });
                    }}
                  >
                    <option value="" disabled hidden>
                      Allow always
                    </option>
                    <option value="task">For this task</option>
                    {!isVault && hasProject && <option value="project">For this project</option>}
                    {!isVault && <option value="global">Everywhere</option>}
                    <option value="edit">Edit the rule first…</option>
                  </select>
                </span>
              </span>
            )}
            <Button
              size="sm"
              variant="outline"
              className={TOUCH_SIZE}
              onClick={() => answer('deny')}
            >
              Deny
            </Button>
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
                <option value="task">for this task</option>
                {!isVault && hasProject && <option value="project">for this project</option>}
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
              <button
                type="button"
                className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                onClick={() => setShowRule(false)}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
      {(req.kind === 'text' || req.kind === 'approval') && (
        <div className={composer}>
          <Input
            data-answer
            className="h-8 border-0 bg-transparent px-2 focus-visible:ring-0"
            aria-label="Your answer"
            placeholder={
              req.kind === 'approval'
                ? 'Deny and tell the agent why…'
                : req.secret
                  ? 'The code (goes straight to the browser)'
                  : 'Your answer…'
            }
            {...(req.secret
              ? {
                  type: 'password',
                  autoComplete: 'one-time-code',
                  inputMode: 'text' as const,
                  spellCheck: false,
                }
              : {})}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                sendText();
              }
            }}
          />
          <Button
            size="icon"
            aria-label="Send"
            title="Send (Enter)"
            disabled={!text.trim()}
            onClick={sendText}
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      )}
      {req.secret && (
        <p className="text-xs text-muted-foreground">
          {secretError ??
            'The agent never sees this code: it is typed into the page for you and kept out of the thread.'}
        </p>
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
              {formatEurCents(spend.spent)} / {formatEurCents(resolved.budget)}
            </span>
          </div>
          <Meter value={spend.spent + spend.reserved} max={resolved.budget} />
          {spend.reserved > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              {formatEur(spend.reserved)} reserved by a running step
            </p>
          )}
        </div>
        <ContextUsage task={task} />
        <details className="group/adv" open={dirty || undefined}>
          <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <Settings2 className="h-3.5 w-3.5" />
            <span className="min-w-0 flex-1 truncate">
              {resolved.model} · {resolved.device}
              {resolved.browser && resolved.browser !== 'none'
                ? ` · browser ${resolved.browser}`
                : ''}
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

/**
 * How much of the model's context window the conversation takes, as of its last model call,
 * and Compact: replace the conversation with a summary (now, or at a working run's next step).
 */
function ContextUsage({ task }: { task: Task }) {
  const ctx = task.context;
  const [state, setState] = useState<
    { kind: 'idle' } | { kind: 'busy' } | { kind: 'requested' } | { kind: 'note'; text: string }
  >({ kind: 'idle' });
  // A compaction that landed ends the "at the next step" wait.
  useEffect(() => {
    if (ctx?.compactedAt) setState({ kind: 'idle' });
  }, [ctx?.compactedAt]);
  if (!ctx?.max) return null;
  const threshold = compactThreshold(ctx.max);
  const compact = async () => {
    setState({ kind: 'busy' });
    try {
      const r = await compactTask(task.id);
      setState(
        r.state === 'requested'
          ? { kind: 'requested' }
          : r.state === 'nothing'
            ? { kind: 'note', text: 'Nothing to compact yet.' }
            : { kind: 'idle' },
      );
    } catch (err) {
      setState({ kind: 'note', text: (err as Error).message || 'Compaction failed.' });
    }
  };
  const unit = tokenUnit(ctx.max);
  const info = ctx.compactedAt
    ? `Compacted ${timeAgo(ctx.compactedAt)}; again at ${formatTokens(threshold, unit)} tokens.`
    : `Compacts automatically at ${formatTokens(threshold, unit)} tokens.`;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="flex items-center gap-1 text-muted-foreground">
          Context
          <InfoTip text={info} />
        </span>
        <span
          title={`${ctx.tokens.toLocaleString()} / ${ctx.max.toLocaleString()} tokens${
            ctx.model ? ` (${ctx.model})` : ''
          }`}
        >
          {formatTokenUsage(ctx.tokens, ctx.max)} tokens
        </span>
      </div>
      <Meter value={ctx.tokens} max={ctx.max} />
      <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="min-w-0">
          {state.kind === 'requested'
            ? 'Compacting at the next step…'
            : state.kind === 'note'
              ? state.text
              : null}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 shrink-0 px-2 text-xs"
          onClick={() => void compact()}
          disabled={state.kind === 'busy' || state.kind === 'requested'}
          title="Replace the conversation with a summary, so each step sends less"
        >
          {state.kind === 'busy' ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Minimize2 className="h-3 w-3" />
          )}
          Compact
        </Button>
      </div>
    </div>
  );
}

/** An info icon whose note shows on hover, or on focus for keyboards and phones. */
function InfoTip({ text }: { text: string }) {
  return (
    <span className="group/tip relative inline-flex">
      <button
        type="button"
        aria-label={text}
        className="rounded-full text-muted-foreground/70 outline-none hover:text-foreground focus-visible:text-foreground"
      >
        <Info className="h-3.5 w-3.5" />
      </button>
      <span
        role="tooltip"
        className="pointer-events-none invisible absolute top-full left-0 z-20 mt-1.5 w-max max-w-48 rounded-md border bg-card px-2 py-1 text-xs text-foreground opacity-0 shadow-sm transition group-hover/tip:visible group-hover/tip:opacity-100 group-focus-within/tip:visible group-focus-within/tip:opacity-100"
      >
        {text}
      </span>
    </span>
  );
}

/** Your Google profile picture, or a person icon when there is none. */
function UserAvatar() {
  const { user } = useAuth();
  const [broken, setBroken] = useState(false);
  return user?.photoURL && !broken ? (
    <img
      src={user.photoURL}
      alt="You"
      title="Your answer"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
      className="mt-px h-5 w-5 shrink-0 rounded-full"
    />
  ) : (
    <span
      title="Your answer"
      className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted"
    >
      <User className="h-3 w-3" />
    </span>
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
                {a.kind === 'link' && isDriveUrl(a.url) ? (
                  <HardDrive
                    className="h-4 w-4 shrink-0 text-muted-foreground"
                    aria-label="Google Drive"
                  />
                ) : a.kind === 'link' ? (
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
                {a.kind === 'link' && isDriveUrl(a.url) && (
                  <span className="text-xs text-muted-foreground">in Drive</span>
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
