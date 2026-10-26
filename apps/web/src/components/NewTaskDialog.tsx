import type { AiConfig, TaskPriority } from '@dodo/core';
import { Mic } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { AiConfigFields } from '@/components/AiConfigFields';
import { PRIORITIES } from '@/components/task-meta';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input, Label, Select, Textarea } from '@/components/ui/input';
import { createTask, useProjects } from '@/lib/data';
import { usePushToTalk } from '@/lib/speech';
import { cn } from '@/lib/utils';

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

export function NewTaskDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="New task">
      <NewTaskForm onDone={onClose} />
    </Dialog>
  );
}

function NewTaskForm({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();
  const { data: projects } = useProjects();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('none');
  const [dueDate, setDueDate] = useState('');
  const [projectId, setProjectId] = useState('');
  const [ai, setAi] = useState<Partial<AiConfig>>({ enabled: true });
  const [showAi, setShowAi] = useState(false);
  const [saving, setSaving] = useState(false);
  const ptt = usePushToTalk((text) => setDescription((d) => (d ? `${d} ${text}` : text)));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!description.trim() && !title.trim()) return;
    setSaving(true);
    try {
      const id = await createTask({
        title,
        description,
        tags: parseTags(tags),
        priority,
        dueDate: dueDate || undefined,
        projectId: projectId || undefined,
        ai: { enabled: true, ...ai },
      });
      onDone();
      navigate(`/tasks/${id}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <label className="block">
        <Label>Title (optional, generated if empty)</Label>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short title" />
      </label>
      <label className="block">
        <span className="mb-1 flex items-center justify-between">
          <Label className="mb-0">Description</Label>
          {ptt.supported && (
            <button
              type="button"
              onPointerDown={ptt.start}
              onPointerUp={ptt.stop}
              onPointerLeave={ptt.stop}
              className={cn(
                'flex items-center gap-1 rounded-md border px-2 py-1 text-xs select-none',
                ptt.listening && 'border-danger text-danger',
              )}
            >
              <Mic className="h-3.5 w-3.5" />{' '}
              {ptt.listening ? 'Listening… release to stop' : 'Hold to talk'}
            </button>
          )}
        </span>
        <Textarea
          autoFocus
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What needs to be done?"
          rows={5}
        />
      </label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label>
          <Label>Project</Label>
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">No project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </label>
        <label>
          <Label>Priority</Label>
          <Select value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
            {PRIORITIES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
        </label>
        <label>
          <Label>Due date</Label>
          <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </label>
        <label>
          <Label>Tags (comma separated)</Label>
          <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="admin, home" />
        </label>
      </div>
      <div className="rounded-md border p-3">
        <div className="flex items-center justify-between">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={ai.enabled ?? true}
              onChange={(e) => setAi({ ...ai, enabled: e.target.checked })}
            />
            Let AI work on this
          </label>
          <button
            type="button"
            className="text-xs text-muted-foreground underline"
            onClick={() => setShowAi((s) => !s)}
          >
            {showAi ? 'Hide AI settings' : 'AI settings'}
          </button>
        </div>
        {showAi && (
          <div className="mt-3">
            <AiConfigFields value={ai} onChange={setAi} showEnabled={false} />
          </div>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving || (!description.trim() && !title.trim())}>
          Create task
        </Button>
      </div>
    </form>
  );
}
