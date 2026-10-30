import { type AiConfig, resolveAiConfig, type TaskPriority } from '@dodo/core';
import { ChevronRight, Loader2, Plus, Settings2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { AiConfigFields } from '@/components/AiConfigFields';
import { PushToTalkButton } from '@/components/PushToTalk';
import {
  appendText,
  composer,
  DueChip,
  PriorityChip,
  ProjectChip,
  TagChips,
} from '@/components/task-fields';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { createTask, useProjects, useSettings } from '@/lib/data';
import { cn } from '@/lib/utils';

export function NewTaskDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose}>
      <NewTaskForm onDone={onClose} />
    </Dialog>
  );
}

/**
 * Create a task the way you reply in its thread: say what needs doing in the big box and press
 * Enter or +, or hold the mic and let go to create it from what you said. The title, properties
 * and AI settings are optional and stay light until you use them.
 */
function NewTaskForm({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();
  const { data: projects } = useProjects();
  const { data: settings } = useSettings();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [priority, setPriority] = useState<TaskPriority>('none');
  const [dueDate, setDueDate] = useState<string>();
  const [projectId, setProjectId] = useState<string>();
  const [ai, setAi] = useState<Partial<AiConfig>>({ enabled: true });
  const [showAi, setShowAi] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const busy = useRef(false);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);

  const aiEnabled = ai.enabled ?? true;
  const project = projects.find((p) => p.id === projectId);
  const resolved = resolveAiConfig({ ai: { ...ai, enabled: true } }, project, settings);
  const canCreate = !!(description.trim() || title.trim());

  const create = async (text = description) => {
    if (busy.current || !(text.trim() || title.trim())) return;
    busy.current = true;
    setSaving(true);
    setError(undefined);
    try {
      const id = await createTask({
        title,
        description: text,
        tags,
        priority,
        dueDate,
        projectId,
        ai: { ...ai, enabled: aiEnabled },
      });
      onDone();
      navigate(`/tasks/${id}`);
    } catch (err) {
      console.error('Could not create the task', err);
      setDescription(text);
      setError('Could not create the task. Try again.');
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
      className="space-y-3"
    >
      {/* Light until you use it; the right padding keeps it clear of Close. */}
      <input
        aria-label="Title"
        className="-mt-1 -ml-1 block w-[calc(100%-2rem)] rounded-md bg-transparent px-1 py-0.5 text-lg font-medium outline-none placeholder:font-normal placeholder:text-muted-foreground/60 hover:bg-accent/50 focus:bg-accent/50"
        placeholder="Title (optional)"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            descriptionRef.current?.focus();
          }
        }}
      />
      <div className="-ml-2 flex flex-wrap items-center gap-1.5">
        <PriorityChip value={priority} onChange={setPriority} />
        <DueChip value={dueDate} onChange={setDueDate} />
        <ProjectChip value={projectId} onChange={setProjectId} />
        <TagChips tags={tags} onChange={setTags} />
      </div>
      <div>
        <div className={composer}>
          <Textarea
            ref={descriptionRef}
            data-autofocus
            aria-label="Description"
            rows={4}
            className="max-h-[50dvh] min-h-28 resize-none border-0 bg-transparent px-2 field-sizing-content focus-visible:ring-0"
            placeholder="What needs to be done? Or hold the mic and say it."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              // Enter creates; Shift+Enter adds a line. Leave Enter alone while an IME is composing.
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void create();
              }
            }}
          />
          {/* Dictating creates the task as soon as the words are in. */}
          <PushToTalkButton compact onText={(text) => void create(appendText(description, text))} />
          <Button
            type="submit"
            size="icon"
            aria-label="Create task"
            title="Create task (Enter)"
            disabled={saving || !canCreate}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          </Button>
        </div>
        <p className="mt-1 px-1 text-xs text-muted-foreground">
          Enter to create · Shift+Enter for a new line
          <span className="hidden sm:inline"> · hold the mic to dictate and create</span>
        </p>
        {error && (
          <p role="alert" className="mt-1 px-1 text-xs text-danger">
            {error}
          </p>
        )}
      </div>
      <div className="border-t pt-3">
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <Switch
            label="Let AI work on this task"
            checked={aiEnabled}
            onChange={(enabled) => setAi({ ...ai, enabled })}
          />
          <span className="shrink-0">{aiEnabled ? 'AI works on this' : 'No AI'}</span>
          {aiEnabled && (
            <button
              type="button"
              aria-expanded={showAi}
              onClick={() => setShowAi((s) => !s)}
              className="ml-auto flex min-w-0 items-center gap-1 rounded hover:text-foreground"
              title="AI settings for this task"
            >
              <Settings2 className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 truncate">
                {resolved.model} · {resolved.device}
                {resolved.browser && resolved.browser !== 'none'
                  ? ` · browser ${resolved.browser}`
                  : ''}
              </span>
              <ChevronRight
                className={cn('h-3.5 w-3.5 shrink-0 transition', showAi && 'rotate-90')}
              />
            </button>
          )}
        </div>
        {aiEnabled && showAi && (
          <div className="mt-3">
            <AiConfigFields
              value={ai}
              onChange={setAi}
              showEnabled={false}
              inherited={resolveAiConfig({ ai: { enabled: false } }, project, settings)}
            />
          </div>
        )}
      </div>
    </form>
  );
}
