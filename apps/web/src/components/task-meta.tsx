import type { TaskPriority, TaskStatus } from '@dodo/core';
import {
  CalendarDays,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleX,
  Eye,
  type LucideIcon,
  Minus,
  OctagonAlert,
  SignalHigh,
  SignalLow,
  SignalMedium,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export const STATUSES: {
  value: TaskStatus;
  label: string;
  tone: string;
  icon: LucideIcon;
}[] = [
  { value: 'backlog', label: 'Backlog', tone: 'text-muted-foreground', icon: CircleDashed },
  { value: 'todo', label: 'To do', tone: 'text-muted-foreground', icon: Circle },
  {
    value: 'in_progress',
    label: 'In progress',
    tone: 'text-blue-600 dark:text-blue-400',
    icon: CircleDot,
  },
  { value: 'needs_input', label: 'Needs you', tone: 'text-attention', icon: CircleAlert },
  { value: 'review', label: 'Review', tone: 'text-violet-600 dark:text-violet-400', icon: Eye },
  { value: 'done', label: 'Done', tone: 'text-success', icon: CircleCheck },
  { value: 'cancelled', label: 'Cancelled', tone: 'text-muted-foreground', icon: CircleX },
];

export const PRIORITIES: {
  value: TaskPriority;
  label: string;
  tone: string;
  icon: LucideIcon;
}[] = [
  { value: 'none', label: 'No priority', tone: 'text-muted-foreground', icon: Minus },
  { value: 'low', label: 'Low', tone: 'text-muted-foreground', icon: SignalLow },
  { value: 'medium', label: 'Medium', tone: 'text-foreground', icon: SignalMedium },
  { value: 'high', label: 'High', tone: 'text-attention', icon: SignalHigh },
  { value: 'urgent', label: 'Urgent', tone: 'text-danger', icon: OctagonAlert },
];

export const statusMeta = (status: TaskStatus) =>
  STATUSES.find((s) => s.value === status) ?? (STATUSES[1] as (typeof STATUSES)[number]);
export const priorityMeta = (priority: TaskPriority) =>
  PRIORITIES.find((p) => p.value === priority) ?? (PRIORITIES[0] as (typeof PRIORITIES)[number]);

/** Status as an icon with its label; `iconOnly` keeps the label as a tooltip. */
export function StatusBadge({
  status,
  iconOnly = false,
}: {
  status: TaskStatus;
  iconOnly?: boolean;
}) {
  const s = statusMeta(status);
  const Icon = s.icon;
  if (iconOnly)
    return (
      <span title={s.label} className={cn('inline-flex shrink-0', s.tone)}>
        <Icon className="h-4 w-4" aria-label={s.label} />
      </span>
    );
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs font-medium', s.tone)}>
      <Icon className="h-3.5 w-3.5" />
      {s.label}
    </span>
  );
}

/** Priority as signal bars (Linear-style); nothing for "no priority". */
export function PriorityLabel({
  priority,
  showLabel = false,
}: {
  priority: TaskPriority;
  showLabel?: boolean;
}) {
  if (priority === 'none') return null;
  const p = priorityMeta(priority);
  const Icon = p.icon;
  return (
    <span
      title={`${p.label} priority`}
      className={cn('inline-flex items-center gap-1 text-xs font-medium', p.tone)}
    >
      <Icon className="h-4 w-4" strokeWidth={2.75} aria-label={`${p.label} priority`} />
      {showLabel && p.label}
    </span>
  );
}

/** "2026-10-30" as local midnight (Date parses bare ISO dates as UTC). */
function parseLocalDate(isoDate: string): Date {
  const [y = 1970, m = 1, d = 1] = isoDate.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Days from today (local time) to an ISO date; negative when overdue. */
export function daysUntil(isoDate: string, now = new Date()): number {
  const due = parseLocalDate(isoDate);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due.getTime() - today.getTime()) / 86_400_000);
}

/** "Today", "Tomorrow", "Yesterday", "Fri", or "30 Oct". */
export function formatDue(isoDate: string, now = new Date()): string {
  const days = daysUntil(isoDate, now);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  const date = parseLocalDate(isoDate);
  if (days > 1 && days < 7) return date.toLocaleDateString(undefined, { weekday: 'short' });
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() !== now.getFullYear() && { year: 'numeric' }),
  });
}

export function dueTone(isoDate: string, closed = false): string {
  if (closed) return 'text-muted-foreground';
  const days = daysUntil(isoDate);
  if (days < 0) return 'text-danger';
  if (days <= 1) return 'text-attention';
  return 'text-muted-foreground';
}

/** Due date with a calendar icon, red when overdue and amber when due today or tomorrow. */
export function DueDate({ date, closed = false }: { date: string; closed?: boolean }) {
  return (
    <span
      title={`Due ${date}`}
      className={cn('inline-flex items-center gap-1 text-xs', dueTone(date, closed))}
    >
      <CalendarDays className="h-3.5 w-3.5" />
      {formatDue(date)}
    </span>
  );
}

export function Tags({ tags }: { tags: string[] }) {
  return (
    <>
      {tags.map((t) => (
        <Badge key={t} className="border-transparent bg-muted font-normal text-muted-foreground">
          {t}
        </Badge>
      ))}
    </>
  );
}
