import { type AiConfig, type Project, repoList, resolveAiConfig } from '@dodo/core';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { AiConfigFields } from '@/components/AiConfigFields';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input, Label, Textarea } from '@/components/ui/input';
import { deleteProject, saveProject, useProjects, useSettings, useTasks } from '@/lib/data';
import { formatEur } from '@/lib/utils';

export function ProjectsPage() {
  const { data: projects, loading } = useProjects();
  const { data: tasks } = useTasks();
  const [editing, setEditing] = useState<Partial<Project> | null>(null);
  return (
    <div className="space-y-4">
      <div className="flex items-center">
        <h1 className="mr-auto text-lg font-semibold">Projects</h1>
        <Button onClick={() => setEditing({ name: '', defaults: {} })}>
          <Plus className="h-4 w-4" /> New project
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        A project sets defaults for its tasks: tools, device, repo, folder, model and budget, plus
        standing instructions for the agent.
      </p>
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : projects.length === 0 ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          No projects yet.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {projects.map((p) => {
            const open = tasks.filter(
              (t) => t.projectId === p.id && !['done', 'cancelled'].includes(t.status),
            ).length;
            return (
              <Card key={p.id}>
                <CardHeader
                  title={p.name}
                  action={
                    <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
                      Edit
                    </Button>
                  }
                />
                <CardBody className="space-y-1 text-sm">
                  {p.description && <p>{p.description}</p>}
                  <p className="text-muted-foreground">
                    {open} open task{open === 1 ? '' : 's'}
                    {p.monthlyBudget !== undefined && ` · ${formatEur(p.monthlyBudget)}/month cap`}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {[
                      p.defaults.model,
                      p.defaults.device,
                      ...repoList(p.defaults),
                      p.defaults.folder,
                    ]
                      .filter(Boolean)
                      .join(' · ') || 'Uses global defaults'}
                  </p>
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}
      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing?.id ? 'Edit project' : 'New project'}
      >
        {editing && <ProjectForm initial={editing} onDone={() => setEditing(null)} />}
      </Dialog>
    </div>
  );
}

function ProjectForm({ initial, onDone }: { initial: Partial<Project>; onDone: () => void }) {
  const { data: settings } = useSettings();
  const [name, setName] = useState(initial.name ?? '');
  const [description, setDescription] = useState(initial.description ?? '');
  const [instructions, setInstructions] = useState(initial.instructions ?? '');
  const [defaults, setDefaults] = useState<Partial<AiConfig>>(initial.defaults ?? {});
  const [monthly, setMonthly] = useState(
    initial.monthlyBudget === undefined ? '' : String(initial.monthlyBudget / 1e6),
  );
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const { enabled: _enabled, ...rest } = defaults;
    await saveProject({
      id: initial.id,
      name: name.trim(),
      description,
      instructions,
      defaults: rest,
      monthlyBudget: monthly === '' ? undefined : Math.round(Number(monthly) * 1e6),
    });
    onDone();
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <label className="block">
        <Label>Name</Label>
        <Input required value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="block">
        <Label>Description</Label>
        <Input value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="block">
        <Label>Instructions for the agent</Label>
        <Textarea
          rows={3}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="Conventions, context, what to avoid…"
        />
      </label>
      <div>
        <Label>Task defaults</Label>
        <AiConfigFields
          value={defaults}
          onChange={setDefaults}
          showEnabled={false}
          inherited={resolveAiConfig({ ai: { enabled: false } }, undefined, settings)}
        />
      </div>
      <label className="block">
        <Label>Monthly budget cap for the project (EUR, empty = none)</Label>
        <Input
          type="number"
          min={0}
          step={0.5}
          value={monthly}
          onChange={(e) => setMonthly(e.target.value)}
        />
      </label>
      <div className="flex justify-between">
        {initial.id ? (
          <Button
            variant="ghost"
            className="text-danger"
            onClick={() => initial.id && deleteProject(initial.id).then(onDone)}
          >
            Delete
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" disabled={!name.trim()}>
            Save
          </Button>
        </div>
      </div>
    </form>
  );
}
