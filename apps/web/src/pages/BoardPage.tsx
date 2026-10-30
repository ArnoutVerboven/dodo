import type { Task, TaskStatus } from '@dodo/core';
import { Bot, Columns3, Folder, List, Plus, Search, Tag } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { NewTaskDialog } from '@/components/NewTaskDialog';
import { SourceIcon } from '@/components/SourceIcon';
import { DueDate, PriorityLabel, StatusBadge, statusMeta, Tags } from '@/components/task-meta';
import { Button } from '@/components/ui/button';
import { Dropdown } from '@/components/ui/dropdown';
import { Input } from '@/components/ui/input';
import { setTaskStatus, useBudgets, useProjects, useTasks } from '@/lib/data';
import { cn, formatEur, isTyping, timeAgo } from '@/lib/utils';

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
  const searchInput = useRef<HTMLInputElement>(null);

  // Shortcuts: "/" focuses search, "n" or "c" creates a task.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/') {
        e.preventDefault();
        searchInput.current?.focus();
      } else if (e.key === 'n' || e.key === 'c') {
        e.preventDefault();
        setCreating(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
            title="List view"
          >
            <List className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant={view === 'board' ? 'outline' : 'ghost'}
            onClick={() => setView('board')}
            aria-label="Board view"
            title="Board view"
          >
            <Columns3 className="h-4 w-4" />
          </Button>
        </div>
        <Button onClick={() => setCreating(true)} title="New task (N)">
          <Plus className="h-4 w-4" /> New task
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchInput}
            className="pl-8"
            placeholder="Search  /"
            aria-label="Search tasks"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setSearch('');
                e.currentTarget.blur();
              }
            }}
          />
        </div>
        {projects.length > 0 && (
          <Dropdown
            ariaLabel="Filter by project"
            className={cn('w-auto max-w-56', !projectId && 'text-muted-foreground')}
            value={projectId}
            options={[
              { value: '', label: 'All projects' },
              ...projects.map((p) => ({ value: p.id, label: p.name, icon: Folder })),
            ]}
            searchable={projects.length > 8}
            onChange={setProjectId}
          />
        )}
        {allTags.length > 0 && (
          <Dropdown
            ariaLabel="Filter by tag"
            className={cn('w-auto max-w-56', !tag && 'text-muted-foreground')}
            value={tag}
            options={[
              { value: '', label: 'All tags' },
              ...allTags.map((t) => ({ value: t, label: t, icon: Tag })),
            ]}
            searchable={allTags.length > 8}
            onChange={setTag}
          />
        )}
        {view === 'list' && (
          <Button
            size="sm"
            variant={showClosed ? 'outline' : 'ghost'}
            className="text-muted-foreground"
            aria-pressed={showClosed}
            onClick={() => setShowClosed((v) => !v)}
          >
            {showClosed ? 'Hide done' : 'Show done'}
          </Button>
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
            className="group flex gap-3 px-3 py-2.5 transition-colors hover:bg-accent sm:items-center"
          >
            <span className="mt-0.5 sm:mt-0">
              <StatusBadge status={t.status} iconOnly />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {t.source && <SourceIcon source={t.source} />}
                  <span
                    className={cn(
                      'truncate font-medium',
                      ['done', 'cancelled'].includes(t.status) && 'text-muted-foreground',
                    )}
                  >
                    {t.title}
                  </span>
                  {t.ai.enabled && (
                    <Bot
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                      aria-label="AI enabled"
                    />
                  )}
                </div>
                {t.statusLine?.text && (
                  <p className="truncate text-sm text-muted-foreground">{t.statusLine.text}</p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2.5">
                <Tags tags={t.tags} />
                {t.projectId && (
                  <span className="text-xs text-muted-foreground">
                    {projectName.get(t.projectId)}
                  </span>
                )}
                {(spent.get(t.id) ?? 0) > 0 && (
                  <span className="hidden text-xs text-muted-foreground group-hover:inline">
                    {formatEur(spent.get(t.id) ?? 0)}
                  </span>
                )}
                <PriorityLabel priority={t.priority} />
                {t.dueDate && (
                  <DueDate date={t.dueDate} closed={['done', 'cancelled'].includes(t.status)} />
                )}
                <span className="w-14 text-right text-xs text-muted-foreground">
                  {timeAgo(t.updatedAt)}
                </span>
              </div>
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
    <div className="grid auto-cols-[minmax(200px,1fr)] grid-flow-col gap-3 overflow-x-auto pb-2">
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
            <h2 className="mb-2 flex items-center gap-1.5 px-1 text-xs font-semibold text-muted-foreground">
              <StatusBadge status={status} iconOnly />
              {statusMeta(status).label}
              <span className="ml-auto font-normal">{col.length}</span>
            </h2>
            <div className="space-y-2">
              {col.map((t) => (
                <Link
                  key={t.id}
                  to={`/tasks/${t.id}`}
                  draggable
                  onDragStart={() => setDragging(t.id)}
                  onDragEnd={() => setDragging(null)}
                  className={cn(
                    'block rounded-md border bg-card p-3 text-sm shadow-xs transition hover:border-primary/40 hover:shadow-sm',
                    dragging === t.id && 'opacity-50',
                  )}
                >
                  <div className="flex items-start gap-2">
                    {t.source && <SourceIcon source={t.source} className="mt-0.5" />}
                    <span className="min-w-0 flex-1 font-medium">{t.title}</span>
                    {t.ai.enabled && (
                      <Bot
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground"
                        aria-label="AI enabled"
                      />
                    )}
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
                    <span className="flex-1" />
                    <PriorityLabel priority={t.priority} />
                    {t.dueDate && <DueDate date={t.dueDate} closed={t.status === 'done'} />}
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
