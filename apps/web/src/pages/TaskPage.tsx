import {
  type AiConfig,
  resolveAiConfig,
  type Task,
  type TaskPriority,
  type TaskStatus,
  type ThreadMessage,
} from '@dodo/core';
import {
  ArrowLeft,
  Bot,
  ExternalLink,
  FileText,
  Link2,
  Paperclip,
  Send,
  Trash2,
  User,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Link, useNavigate, useParams } from 'react-router';
import remarkGfm from 'remark-gfm';
import { AiConfigFields } from '@/components/AiConfigFields';
import { parseTags } from '@/components/NewTaskDialog';
import { PRIORITIES, STATUSES } from '@/components/task-meta';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Input, Label, Select, Textarea } from '@/components/ui/input';
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
import { cn, formatEur, timeAgo } from '@/lib/utils';

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
  return (
    <div className="space-y-4">
      <Link
        to="/"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Tasks
      </Link>
      <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
        <div className="min-w-0 space-y-4">
          <TitleEditor task={task} />
          <StatusCard task={task} />
          <SummaryCard task={task} />
          <DescriptionCard task={task} />
          <Thread taskId={task.id} />
        </div>
        <aside className="space-y-4">
          <DetailsCard task={task} />
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
    <input
      aria-label="Title"
      className="w-full bg-transparent text-xl font-semibold outline-none"
      value={title}
      onChange={(e) => setTitle(e.target.value)}
      onBlur={() =>
        title.trim() &&
        title !== task.title &&
        updateTask(task.id, { title: title.trim(), titleSource: 'user' })
      }
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

function StatusCard({ task }: { task: Task }) {
  const s = task.statusLine;
  const needsYou = task.status === 'needs_input' || s?.needsYou;
  return (
    <Card className={cn(needsYou && 'border-attention bg-attention-bg')}>
      <CardHeader title={needsYou ? 'Status: needs you' : 'Status'} />
      <CardBody className="space-y-1 text-sm">
        {s ? (
          <>
            <p>{s.text}</p>
            {s.nextAction && (
              <p>
                <span className="font-medium">Next: </span>
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
      <CardBody className="prose-sm text-sm">
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
  return (
    <Card>
      <CardHeader
        title="Description"
        action={
          !editing && (
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )
        }
      />
      <CardBody className="prose-sm text-sm">
        {editing ? (
          <div className="space-y-2">
            <Textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} />
            <div className="flex justify-end gap-2">
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
              <Button
                size="sm"
                onClick={() =>
                  updateTask(task.id, { description: text }).then(() => setEditing(false))
                }
              >
                Save
              </Button>
            </div>
          </div>
        ) : task.description ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{task.description}</ReactMarkdown>
        ) : (
          <p className="text-muted-foreground">No description.</p>
        )}
      </CardBody>
    </Card>
  );
}

function Thread({ taskId }: { taskId: string }) {
  const { data: messages } = useMessages(taskId);
  const [body, setBody] = useState('');
  const end = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the message count changes
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [messages.length]);
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    await postUserMessage(taskId, body.trim());
    setBody('');
  };
  return (
    <Card>
      <CardHeader title="Thread" />
      <CardBody className="space-y-4">
        {messages.length === 0 && <p className="text-sm text-muted-foreground">No messages yet.</p>}
        {messages.map((m) => (
          <MessageView key={m.id} taskId={taskId} message={m} />
        ))}
        <div ref={end} />
        <form onSubmit={send} className="flex items-end gap-2">
          <Textarea
            rows={2}
            className="min-h-0"
            placeholder="Reply or steer the agent…"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(e);
            }}
          />
          <Button type="submit" size="icon" aria-label="Send" disabled={!body.trim()}>
            <Send className="h-4 w-4" />
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

function MessageView({ taskId, message: m }: { taskId: string; message: ThreadMessage }) {
  const Icon = m.author === 'user' ? User : Bot;
  return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">
            {m.author === 'user' ? 'You' : m.author === 'agent' ? 'Agent' : 'System'}
          </span>
          <span>{timeAgo(m.createdAt)}</span>
          {m.runId && <span className="rounded bg-muted px-1.5">run {m.runId.slice(0, 6)}</span>}
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
  return (
    <div className="mt-2 space-y-2 rounded-md border border-attention bg-attention-bg p-3 text-sm">
      <p className="font-medium">{req.prompt}</p>
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
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => answer('approve')}>
              Approve once
            </Button>
            <Button size="sm" variant="outline" onClick={() => answer('deny')}>
              Deny
            </Button>
          </div>
          {req.suggestedRule !== undefined && (
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
          />
          <Button
            size="sm"
            disabled={!text.trim()}
            onClick={() => answer(req.kind === 'approval' ? `deny: ${text.trim()}` : text.trim())}
          >
            Send
          </Button>
        </div>
      )}
    </div>
  );
}

function DetailsCard({ task }: { task: Task }) {
  const { data: projects } = useProjects();
  const [tags, setTags] = useState(task.tags.join(', '));
  useEffect(() => {
    setTags(task.tags.join(', '));
  }, [task.tags]);
  return (
    <Card>
      <CardHeader title="Details" />
      <CardBody className="space-y-3">
        <label className="block">
          <Label>Status</Label>
          <Select
            value={task.status}
            onChange={(e) => updateTask(task.id, { status: e.target.value as TaskStatus })}
          >
            {STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="block">
          <Label>Priority</Label>
          <Select
            value={task.priority}
            onChange={(e) => updateTask(task.id, { priority: e.target.value as TaskPriority })}
          >
            {PRIORITIES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="block">
          <Label>Due date</Label>
          <Input
            type="date"
            value={task.dueDate ?? ''}
            onChange={(e) => updateTask(task.id, { dueDate: e.target.value || undefined })}
          />
        </label>
        <label className="block">
          <Label>Project</Label>
          <Select
            value={task.projectId ?? ''}
            onChange={(e) => updateTask(task.id, { projectId: e.target.value || undefined })}
          >
            <option value="">No project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="block">
          <Label>Tags</Label>
          <Input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            onBlur={() => updateTask(task.id, { tags: parseTags(tags) })}
            placeholder="comma separated"
          />
        </label>
      </CardBody>
    </Card>
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
  const dirty = JSON.stringify(draft) !== JSON.stringify(task.ai);
  return (
    <Card>
      <CardHeader title="AI" />
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
        <AiConfigFields value={draft} onChange={setDraft} />
        <p className="text-xs text-muted-foreground">
          Effective: {resolved.model} on {resolved.device}, budget {formatEur(resolved.budget)}
        </p>
        {dirty && (
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setDraft(task.ai)}>
              Reset
            </Button>
            <Button
              size="sm"
              onClick={() => updateTask(task.id, { ai: { enabled: false, ...draft } })}
            >
              Save
            </Button>
          </div>
        )}
      </CardBody>
    </Card>
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
        title="Artifacts"
        action={
          <Button
            size="sm"
            variant="ghost"
            disabled={uploading}
            onClick={() => fileInput.current?.click()}
            aria-label="Attach file"
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
        {artifacts.length === 0 && (
          <p className="text-sm text-muted-foreground">No attachments or links.</p>
        )}
        <ul className="space-y-1">
          {artifacts.map((a) => (
            <li key={a.id} className="group flex items-center gap-2 text-sm">
              {a.kind === 'link' ? (
                <Link2 className="h-4 w-4 shrink-0" />
              ) : (
                <FileText className="h-4 w-4 shrink-0" />
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
              <ExternalLink className="h-3 w-3 text-muted-foreground" />
              <button
                type="button"
                className="opacity-0 group-hover:opacity-100"
                onClick={() => deleteArtifact(taskId, a.id)}
                aria-label={`Remove ${a.name}`}
              >
                <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </li>
          ))}
        </ul>
        <form
          className="flex gap-2"
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
            placeholder="Add a link"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <Button size="sm" type="submit" variant="outline" disabled={!url.trim()}>
            Add
          </Button>
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
      className="text-muted-foreground"
      onClick={() => setConfirming(true)}
    >
      <Trash2 className="h-4 w-4" /> Delete task
    </Button>
  );
}
