import type { Task, TaskStatus } from '@dodo/core';
import { Bot, Columns3, List, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { NewTaskDialog } from '@/components/NewTaskDialog';
import { PriorityLabel, STATUSES, StatusBadge, Tags } from '@/components/task-meta';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { setTaskStatus, useBudgets, useProjects, useTasks } from '@/lib/data';
import { cn, formatEur, timeAgo } from '@/lib/utils';

type View = 'list' | 'board';

function readView(): View {
  try {
    return localStorage.getItem('dodo.view') === 'board' ? 'board' : 'list';
  } catch {
    return 'list';
  }
}

export function BoardPage() {
  const { data: tasks, loading, error } = useTasks();
  const { data: projects } = useProjects();
  const [creating, setCreating] = useState(false);
  const [view, setViewState] = useState<View>(readView);
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState('');
  const [projectId, setProjectId] = useState('');
  const [showClosed, setShowClosed] = useState(false);

  const setView = (v: View) => {
    setViewState(v);
    try {
      localStorage.setItem('dodo.view', v);
    } catch {}
  };

  const allTags = useMemo(() => [...new Set(tasks.flatMap((t) => t.tags))].sort(), [tasks]);
  const projectName = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);
  const { data: budgets } = useBudgets();
  const spentByTask = useMemo(
    () =>
      new Map(budgets.filter((b) => b.id.startsWith('task_')).map((b) => [b.id.slice(5), b.spent])),
    [budgets],
  );
  const filtered = tasks.filter(
    (t) =>
      (showClosed || view === 'board' || !['done', 'cancelled'].includes(t.status)) &&
      (!tag || t.tags.includes(tag)) &&
      (!projectId || t.projectId === projectId) &&
      (!search || `${t.title} ${t.description}`.toLowerCase().includes(search.toLowerCase())),
  );
  const needsYou = filtered.filter((t) => t.status === 'needs_input' || t.statusLine?.needsYou);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-lg font-semibold">Tasks</h1>
        <div className="flex rounded-md border p-0.5">
          <Button
            size="sm"
            variant={view === 'list' ? 'outline' : 'ghost'}
            onClick={() => setView('list')}
            aria-label="List view"
          >
            <List className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant={view === 'board' ? 'outline' : 'ghost'}
            onClick={() => setView('board')}
            aria-label="Board view"
          >
            <Columns3 className="h-4 w-4" />
          </Button>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> New task
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        <Input
          className="w-full sm:w-64"
          placeholder="Search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select className="w-auto" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <Select className="w-auto" value={tag} onChange={(e) => setTag(e.target.value)}>
          <option value="">All tags</option>
          {allTags.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </Select>
        {view === 'list' && (
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={showClosed}
              onChange={(e) => setShowClosed(e.target.checked)}
            />{' '}
            Show done
          </label>
        )}
      </div>

      {error && <p className="text-sm text-danger">Could not load tasks: {error.message}</p>}
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : tasks.length === 0 ? (
        <EmptyState onCreate={() => setCreating(true)} />
      ) : view === 'list' ? (
        <>
          {needsYou.length > 0 && (
            <section>
              <h2 className="mb-2 text-xs font-semibold tracking-wide text-attention uppercase">
                Needs you
              </h2>
              <TaskList tasks={needsYou} projectName={projectName} spent={spentByTask} />
            </section>
          )}
          <TaskList
            tasks={filtered.filter((t) => !needsYou.includes(t))}
            projectName={projectName}
            spent={spentByTask}
          />
        </>
      ) : (
        <Kanban tasks={filtered} projectName={projectName} />
      )}
      <NewTaskDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="rounded-lg border border-dashed p-10 text-center">
      <p className="font-medium">No tasks yet</p>
      <p className="mt-1 text-sm text-muted-foreground">
        Describe something you want done; turn on AI to delegate it.
      </p>
      <Button className="mt-4" onClick={onCreate}>
        <Plus className="h-4 w-4" /> New task
      </Button>
    </div>
  );
}

function TaskList({
  tasks,
  projectName,
  spent,
}: {
  tasks: Task[];
  projectName: Map<string, string>;
  spent: Map<string, number>;
}) {
  if (tasks.length === 0) return null;
  return (
    <ul className="divide-y overflow-hidden rounded-lg border bg-card">
      {tasks.map((t) => (
        <li key={t.id}>
          <Link
            to={`/tasks/${t.id}`}
            className="flex flex-col gap-1 px-4 py-3 hover:bg-accent sm:flex-row sm:items-center sm:gap-3"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                {t.ai.enabled && (
                  <Bot className="h-4 w-4 shrink-0 text-muted-foreground" aria-label="AI enabled" />
                )}
                <span className="truncate font-medium">{t.title}</span>
              </div>
              {t.statusLine?.text && (
                <p className="truncate text-sm text-muted-foreground">{t.statusLine.text}</p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {t.projectId && (
                <span className="text-xs text-muted-foreground">
                  {projectName.get(t.projectId)}
                </span>
              )}
              <Tags tags={t.tags} />
              <PriorityLabel priority={t.priority} />
              {t.dueDate && <span className="text-xs text-muted-foreground">due {t.dueDate}</span>}
              {(spent.get(t.id) ?? 0) > 0 && (
                <span className="text-xs text-muted-foreground">
                  {formatEur(spent.get(t.id) ?? 0)}
                </span>
              )}
              <StatusBadge status={t.status} />
              <span className="w-16 text-right text-xs text-muted-foreground">
                {timeAgo(t.updatedAt)}
              </span>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

const BOARD_COLUMNS: TaskStatus[] = ['todo', 'in_progress', 'needs_input', 'review', 'done'];

function Kanban({ tasks, projectName }: { tasks: Task[]; projectName: Map<string, string> }) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<TaskStatus | null>(null);
  return (
    <div className="grid auto-cols-[minmax(240px,1fr)] grid-flow-col gap-3 overflow-x-auto pb-2">
      {BOARD_COLUMNS.map((status) => {
        const col = tasks.filter(
          (t) => t.status === status || (status === 'todo' && t.status === 'backlog'),
        );
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: drop target for drag and drop; status is also editable on the task page
          <section
            key={status}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(status);
            }}
            onDragLeave={() => setOver(null)}
            onDrop={() => {
              if (dragging) void setTaskStatus(dragging, status);
              setDragging(null);
              setOver(null);
            }}
            className={cn(
              'min-h-40 rounded-lg bg-muted/60 p-2',
              over === status && 'ring-2 ring-primary/30',
            )}
          >
            <h2 className="mb-2 flex items-center justify-between px-1 text-xs font-semibold text-muted-foreground uppercase">
              {STATUSES.find((s) => s.value === status)?.label}
              <span>{col.length}</span>
            </h2>
            <div className="space-y-2">
              {col.map((t) => (
                <Link
                  key={t.id}
                  to={`/tasks/${t.id}`}
                  draggable
                  onDragStart={() => setDragging(t.id)}
                  className="block rounded-md border bg-card p-3 text-sm shadow-xs hover:border-primary/40"
                >
                  <div className="flex items-start gap-2">
                    {t.ai.enabled && (
                      <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="font-medium">{t.title}</span>
                  </div>
                  {t.statusLine?.text && (
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                      {t.statusLine.text}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {t.projectId && (
                      <span className="text-xs text-muted-foreground">
                        {projectName.get(t.projectId)}
                      </span>
                    )}
                    <Tags tags={t.tags} />
                    <PriorityLabel priority={t.priority} />
                  </div>
                </Link>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
