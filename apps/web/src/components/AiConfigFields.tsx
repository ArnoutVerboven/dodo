import type { AiConfig } from '@dodo/core';
import { Input, Label, Select } from '@/components/ui/input';
import { useDevices } from '@/lib/data';
import { MODEL_OPTIONS } from '@/lib/options';

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
        </Select>
      </label>
      <label>
        <Label>Device</Label>
        <Select
          value={value.device ?? ''}
          onChange={(e) => set({ device: e.target.value || undefined })}
        >
          <option value="">Default</option>
          <option value="auto">Auto (small model decides)</option>
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
          placeholder="owner/repo"
          value={value.repo ?? ''}
          onChange={(e) => set({ repo: e.target.value || undefined })}
        />
      </label>
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
