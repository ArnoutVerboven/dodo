import {
  type AiConfig,
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
  FileText,
  Folder,
  Link2,
  type LucideIcon,
  Paperclip,
  Pencil,
  Plus,
  Send,
  Settings2,
  Trash2,
  User,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Link, useNavigate, useParams } from 'react-router';
import remarkGfm from 'remark-gfm';
import { AiConfigFields } from '@/components/AiConfigFields';
import { parseTags } from '@/components/NewTaskDialog';
import { RunPanel } from '@/components/RunPanel';
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
  postUserMessage,
  updateTask,
  useArtifacts,
  useBudgets,
  useMessages,
  useProjects,
  useSettings,
  useTask,
} from '@/lib/data';
import { cn, formatEur, isTyping, timeAgo } from '@/lib/utils';

const PENDING_INPUT_ID = 'pending-input';

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
            <PropertyBar task={task} />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <StatusCard task={task} />
            <SummaryCard task={task} />
          </div>
          <DescriptionCard task={task} />
          <RunPanel taskId={task.id} />
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
              onClick={() =>
                document
                  .getElementById(PENDING_INPUT_ID)
                  ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
              }
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

function DescriptionCard({ task }: { task: Task }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(task.description);
  useEffect(() => {
    setText(task.description);
  }, [task.description]);
  // Collapsed by default: the summary and status above it are the top-down view; the
  // description is what you wrote at the start.
  const [open, setOpen] = useState(false);
  const save = () => updateTask(task.id, { description: text }).then(() => setEditing(false));
  return (
    <details
      className="group rounded-lg border bg-card"
      open={open || editing}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-4 py-2 hover:bg-accent/40">
        <span className="flex min-w-0 items-center gap-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {open || editing ? (
            <ChevronDown className="h-4 w-4 shrink-0" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0" />
          )}
          Description
          {!open && !editing && task.description && (
            <span className="ml-2 truncate font-normal tracking-normal normal-case">
              {task.description}
            </span>
          )}
        </span>
        {!editing && (
          <Button
            size="sm"
            variant="ghost"
            className="-my-1 h-7 text-muted-foreground"
            onClick={(e) => {
              e.preventDefault();
              setEditing(true);
            }}
          >
            <Pencil className="h-3.5 w-3.5" /> Edit
          </Button>
        )}
      </summary>
      <div className="prose-sm px-4 pb-4 text-sm">
        {editing ? (
          <div className="space-y-2">
            <Textarea
              autoFocus
              rows={6}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save();
                if (e.key === 'Escape') {
                  setText(task.description);
                  setEditing(false);
                }
              }}
            />
            <div className="flex items-center justify-end gap-2">
              <span className="mr-auto text-xs text-muted-foreground">⌘/Ctrl+Enter to save</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setText(task.description);
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
              <Button size="sm" onClick={save}>
                Save
              </Button>
            </div>
          </div>
        ) : task.description ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{task.description}</ReactMarkdown>
        ) : (
          <p className="text-muted-foreground">No description.</p>
        )}
      </div>
    </details>
  );
}

function Thread({ taskId }: { taskId: string }) {
  const { data: messages, loading } = useMessages(taskId);
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
        {messages.length === 0 && <p className="text-sm text-muted-foreground">No messages yet.</p>}
        {messages.map((m) => (
          <MessageView key={m.id} taskId={taskId} message={m} />
        ))}
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
              rows={1}
              className="max-h-48 min-h-9 resize-none border-0 field-sizing-content focus-visible:ring-0"
              placeholder="Reply or steer the agent…"
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

function MessageView({ taskId, message: m }: { taskId: string; message: ThreadMessage }) {
  const Icon = m.author === 'user' ? User : Bot;
  const pending = !!m.input && !m.input.answer;
  return (
    <div
      className={cn(
        'group -mx-2 flex gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-accent/60',
        pending && 'bg-attention-bg/50',
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
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">
            {m.author === 'user' ? 'You' : m.author === 'agent' ? 'Agent' : 'System'}
          </span>
          <time title={new Date(m.createdAt).toLocaleString()}>{timeAgo(m.createdAt)}</time>
          {m.runId && (
            <span className="rounded bg-muted px-1.5 opacity-0 transition group-hover:opacity-100">
              run {m.runId.slice(0, 6)}
            </span>
          )}
        </div>
        <div className="prose-sm text-sm">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.body}</ReactMarkdown>
        </div>
        {m.input && <InputRequestView taskId={taskId} message={m} />}
      </div>
    </div>
  );
}

function InputRequestView({ taskId, message }: { taskId: string; message: ThreadMessage }) {
  const req = message.input;
  const [text, setText] = useState('');
  const [rule, setRule] = useState(req?.suggestedRule ?? '');
  const [scope, setScope] = useState<'task' | 'project' | 'global'>('project');
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
  const answer = (value: string, alwaysAllow?: { rule: string; scope: typeof scope }) =>
    answerInput(taskId, message.id, req, value, alwaysAllow);
  const sendText = () => {
    if (!text.trim()) return;
    void answer(req.kind === 'approval' ? `deny: ${text.trim()}` : text.trim());
  };
  return (
    <div
      id={PENDING_INPUT_ID}
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
                <option value="project">this project</option>
                <option value="global">everywhere</option>
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
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  return (
    <Card>
      <CardHeader
        title="Files & links"
        action={
          <Button
            size="icon"
            variant="ghost"
            className="-my-1 h-7 w-7"
            disabled={uploading}
            onClick={() => fileInput.current?.click()}
            aria-label="Attach file"
            title="Attach file"
          >
            <Paperclip className="h-4 w-4" />
          </Button>
        }
      />
      <CardBody className="space-y-2">
        <input
          ref={fileInput}
          type="file"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setUploading(true);
            try {
              await addFileArtifact(taskId, file);
            } finally {
              setUploading(false);
              e.target.value = '';
            }
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
                <a
                  href={a.url}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate hover:underline"
                >
                  {a.name}
                </a>
                {a.role === 'output' && <span className="text-xs text-success">output</span>}
                <button
                  type="button"
                  className="opacity-0 group-hover:opacity-100 focus:opacity-100"
                  onClick={() => deleteArtifact(taskId, a.id)}
                  aria-label={`Remove ${a.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-danger" />
                </button>
              </li>
            ))}
          </ul>
        )}
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
      </CardBody>
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
