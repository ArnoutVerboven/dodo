import { type AiConfig, isLocalModel } from '@dodo/core';
import { Input, Label, Select } from '@/components/ui/input';
import { useDevices, useGitHub, useToolsets } from '@/lib/data';
import { MODEL_OPTIONS } from '@/lib/options';
import { cn } from '@/lib/utils';

/** Editor for AI settings. Empty fields inherit from the project or global defaults. */
export function AiConfigFields({
  value,
  onChange,
  showEnabled = true,
}: {
  value: Partial<AiConfig>;
  onChange: (v: Partial<AiConfig>) => void;
  showEnabled?: boolean;
}) {
  const set = (patch: Partial<AiConfig>) => onChange({ ...value, ...patch });
  const { data: devices } = useDevices();
  const { data: github } = useGitHub();
  const { data: toolsets } = useToolsets();
  const picked = value.toolsets;
  const toggleToolset = (id: string) => {
    const next = new Set(picked ?? []);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    set({ toolsets: next.size ? [...next] : undefined });
  };
  const repos = github?.repos ?? [];
  const macs = devices.filter((d) => d.state === 'approved');
  const knownDevice =
    !value.device?.startsWith('mac:') || macs.some((d) => `mac:${d.id}` === value.device);
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {showEnabled && (
        <label className="col-span-full flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={value.enabled ?? false}
            onChange={(e) => set({ enabled: e.target.checked })}
          />
          Let AI work on this task
        </label>
      )}
      <label>
        <Label>Model</Label>
        <Select
          value={value.model ?? ''}
          onChange={(e) => set({ model: e.target.value || undefined })}
        >
          <option value="">Default</option>
          {MODEL_OPTIONS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
          {value.model?.startsWith('local:') && (
            <option value={value.model}>Local model ({value.model.slice(6)})</option>
          )}
        </Select>
        {isLocalModel(value.model) && (
          <span className="mt-1 block text-xs text-muted-foreground">
            Runs on your Mac (the one picked below, else the one seen last), with the model set up
            there by <code>dodo model set</code>. No budget is used.
          </span>
        )}
      </label>
      <label>
        <Label>Device</Label>
        <Select
          value={value.device ?? ''}
          onChange={(e) => set({ device: e.target.value || undefined })}
        >
          <option value="">Default</option>
          <option value="auto">Auto (your Mac when online, else remote)</option>
          <option value="gcp">Remote (GCP sandbox)</option>
          {macs.map((d) => (
            <option key={d.id} value={`mac:${d.id}`}>
              {d.name}
            </option>
          ))}
          {!knownDevice && <option value={value.device}>Unpaired Mac ({value.device})</option>}
        </Select>
      </label>
      <label>
        <Label>Browser</Label>
        <Select
          value={value.browser ?? ''}
          onChange={(e) =>
            set({ browser: (e.target.value || undefined) as AiConfig['browser'] | undefined })
          }
        >
          <option value="">Default (none)</option>
          <option value="none">None</option>
          <option value="auto">Auto (only when the task needs one)</option>
          <option value="chrome">Yes (your Chrome on a Mac, headless Chromium remotely)</option>
        </Select>
      </label>
      <label>
        <Label>Budget (EUR)</Label>
        <Input
          type="number"
          min={0}
          step={0.05}
          placeholder="Default"
          value={value.budget === undefined ? '' : value.budget / 1_000_000}
          onChange={(e) =>
            set({
              budget:
                e.target.value === '' ? undefined : Math.round(Number(e.target.value) * 1_000_000),
            })
          }
        />
      </label>
      <label>
        <Label>Repo</Label>
        <Input
          placeholder={repos.length ? 'Default (pick or type owner/repo)' : 'owner/repo'}
          list="dodo-github-repos"
          value={value.repo ?? ''}
          onChange={(e) => set({ repo: e.target.value.trim() || undefined })}
        />
        <datalist id="dodo-github-repos">
          {repos.map((r) => (
            <option key={r.fullName} value={r.fullName} />
          ))}
        </datalist>
        {!github?.installation && (
          <span className="mt-1 block text-xs text-muted-foreground">
            Public repos only until you connect GitHub in Settings.
          </span>
        )}
      </label>
      {toolsets.length > 0 && (
        <div className="sm:col-span-2">
          <Label>Toolsets</Label>
          <div className="flex flex-wrap gap-1.5">
            {toolsets.map((t) => {
              const on = picked?.includes(t.id) ?? false;
              return (
                <button
                  key={t.id}
                  type="button"
                  aria-pressed={on}
                  title={t.description || undefined}
                  onClick={() => toggleToolset(t.id)}
                  className={cn(
                    'rounded-full border px-2.5 py-0.5 text-xs',
                    on ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent',
                  )}
                >
                  {t.name}
                </button>
              );
            })}
          </div>
          <span className="mt-1 block text-xs text-muted-foreground">
            {picked?.length
              ? 'Only these tools, plus the task basics.'
              : 'None picked: the default (every tool that is on, or the project’s toolsets).'}
          </span>
        </div>
      )}
      <label className="sm:col-span-2">
        <Label>Folder (local device)</Label>
        <Input
          placeholder="~/code/project"
          value={value.folder ?? ''}
          onChange={(e) => set({ folder: e.target.value || undefined })}
        />
      </label>
    </div>
  );
}
