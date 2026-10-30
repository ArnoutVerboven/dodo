import type { TaskPriority } from '@dodo/core';
import { CalendarDays, Folder, type LucideIcon, Minus, Plus, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { dueTone, formatDue, PRIORITIES, priorityMeta } from '@/components/task-meta';
import { Dropdown, type DropdownOption } from '@/components/ui/dropdown';
import { useProjects } from '@/lib/data';
import { cn } from '@/lib/utils';

/**
 * The light property chips shared by the task view and the Create task form: priority, due date,
 * project and tags as one compact row in place of a form of labelled boxes.
 */

export function parseTags(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ];
}

/** Dictated text joins what is already there, after a space or on its own line. */
export function appendText(current: string, text: string): string {
  if (!current.trim()) return text;
  return /\s$/.test(current) ? `${current}${text}` : `${current} ${text}`;
}

export const chip =
  'relative inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition hover:bg-accent focus-within:ring-2 focus-within:ring-primary/30';

/** A reply box: one border around the field and its icon buttons, which line up with the text. */
export const composer =
  'flex items-end gap-1 rounded-lg border bg-card p-1 focus-within:ring-2 focus-within:ring-primary/30';

/** A chip that opens the app's own menu: light in the bar, the full list when clicked. */
export function SelectChip({
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
  options: DropdownOption[];
  onChange: (value: string) => void;
}) {
  return (
    <Dropdown
      ariaLabel={label}
      value={value}
      options={options}
      onChange={onChange}
      searchable={options.length > 8}
      triggerClassName={cn(
        chip,
        'outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
        muted ? 'text-muted-foreground' : 'bg-muted/60',
      )}
    >
      <Icon className={cn('h-3.5 w-3.5', tone)} />
      <span>{text}</span>
    </Dropdown>
  );
}

export function PriorityChip({
  value,
  onChange,
}: {
  value: TaskPriority;
  onChange: (value: TaskPriority) => void;
}) {
  const priority = priorityMeta(value);
  return (
    <SelectChip
      label="Priority"
      icon={priority.icon}
      tone={priority.tone}
      text={value === 'none' ? 'Priority' : priority.label}
      muted={value === 'none'}
      value={value}
      options={PRIORITIES}
      onChange={(v) => onChange(v as TaskPriority)}
    />
  );
}

export function ProjectChip({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
}) {
  const { data: projects } = useProjects();
  return (
    <SelectChip
      label="Project"
      icon={Folder}
      text={projects.find((p) => p.id === value)?.name ?? 'Project'}
      muted={!value}
      value={value ?? ''}
      options={[
        { value: '', label: 'No project', icon: Minus, tone: 'text-muted-foreground' },
        ...projects.map((p) => ({ value: p.id, label: p.name, icon: Folder })),
      ]}
      onChange={(v) => onChange(v || undefined)}
    />
  );
}

export function DueChip({
  value,
  onChange,
  closed = false,
}: {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  closed?: boolean;
}) {
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
      className={cn(chip, value ? 'bg-muted/60' : 'text-muted-foreground')}
      title={value ? `Due ${value}` : 'Due date'}
    >
      <button type="button" className="inline-flex items-center gap-1.5" onClick={open}>
        <CalendarDays className={cn('h-3.5 w-3.5', value && dueTone(value, closed))} />
        <span className={cn(value && dueTone(value, closed))}>
          {value ? formatDue(value) : 'Due date'}
        </span>
      </button>
      {value && (
        <button
          type="button"
          aria-label="Clear due date"
          className="rounded text-muted-foreground hover:text-foreground"
          onClick={() => onChange(undefined)}
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
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || undefined)}
      />
    </span>
  );
}

export function TagChips({
  tags,
  onChange,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const commit = () => {
    const next = parseTags([...tags, draft].join(','));
    if (next.length !== tags.length) onChange(next);
    setDraft('');
  };
  return (
    <>
      {tags.map((t) => (
        <span
          key={t}
          className="group inline-flex h-7 items-center gap-1 rounded-md bg-muted/60 px-2 text-xs text-muted-foreground"
        >
          #{t}
          <button
            type="button"
            aria-label={`Remove tag ${t}`}
            className="hidden hover:text-foreground group-hover:inline"
            onClick={() => onChange(tags.filter((x) => x !== t))}
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
              // Inside the Create task dialog, Escape closes only the tag field.
              e.preventDefault();
              e.stopPropagation();
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
