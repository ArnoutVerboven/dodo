import type { TaskPriority, TaskStatus } from '@dodo/core';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export const STATUSES: { value: TaskStatus; label: string; tone: string }[] = [
  { value: 'backlog', label: 'Backlog', tone: 'text-muted-foreground' },
  { value: 'todo', label: 'To do', tone: '' },
  { value: 'in_progress', label: 'In progress', tone: 'text-blue-600 dark:text-blue-400' },
  {
    value: 'needs_input',
    label: 'Needs you',
    tone: 'text-attention border-attention bg-attention-bg',
  },
  { value: 'review', label: 'Review', tone: 'text-violet-600 dark:text-violet-400' },
  { value: 'done', label: 'Done', tone: 'text-success' },
  { value: 'cancelled', label: 'Cancelled', tone: 'text-muted-foreground line-through' },
];

export const PRIORITIES: { value: TaskPriority; label: string }[] = [
  { value: 'none', label: 'No priority' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];

export function StatusBadge({ status }: { status: TaskStatus }) {
  const s = STATUSES.find((x) => x.value === status);
  return <Badge className={cn(s?.tone)}>{s?.label ?? status}</Badge>;
}

export function PriorityLabel({ priority }: { priority: TaskPriority }) {
  if (priority === 'none') return null;
  const tone =
    priority === 'urgent'
      ? 'text-danger'
      : priority === 'high'
        ? 'text-attention'
        : 'text-muted-foreground';
  return (
    <span className={cn('text-xs font-medium', tone)}>
      {PRIORITIES.find((p) => p.value === priority)?.label}
    </span>
  );
}

export function Tags({ tags }: { tags: string[] }) {
  return (
    <>
      {tags.map((t) => (
        <Badge key={t} className="bg-muted font-normal">
          {t}
        </Badge>
      ))}
    </>
  );
}
