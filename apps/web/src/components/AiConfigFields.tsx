import { type AiConfig, isLocalModel, LOCAL_MODEL, RepoName, repoList } from '@dodo/core';
import {
  Ban,
  Cloud,
  FolderOpen,
  Globe,
  Laptop,
  Minus,
  Plus,
  RotateCcw,
  Sparkles,
  Wand2,
} from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Dropdown, type DropdownOption, MultiDropdown } from '@/components/ui/dropdown';
import { Label } from '@/components/ui/input';
import { useDevices, useGitHub, useToolsets } from '@/lib/data';
import { MODEL_OPTIONS } from '@/lib/options';
import { cn, formatEur } from '@/lib/utils';

/** The small "only on your Mac" mark next to a local model, device or folder. */
export function LocalOnly({ className }: { className?: string }) {
  return (
    <span
      title="Runs only on your Mac"
      className={cn('inline-flex text-muted-foreground', className)}
    >
      <Laptop className="h-3.5 w-3.5" aria-label="Local only" />
    </span>
  );
}

/** A labelled field. Not a <label>: that would hand clicks in an open menu back to its trigger. */
function Field({
  label,
  hint,
  className,
  children,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <Label className="flex items-center gap-1">{label}</Label>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

/**
 * Editor for AI settings. Empty fields inherit from the project or global defaults; `inherited`
 * is what applies then, shown muted in each field.
 */
export function AiConfigFields({
  value,
  onChange,
  showEnabled = true,
  inherited = {},
}: {
  value: Partial<AiConfig>;
  onChange: (v: Partial<AiConfig>) => void;
  showEnabled?: boolean;
  inherited?: Partial<AiConfig>;
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
  const macs = devices.filter((d) => d.state === 'approved');

  // Model: the plain names; the local one by the model the Mac serves, marked local only.
  const localName = macs.find((d) => d.localModel)?.localModel;
  const modelOptions: DropdownOption[] = MODEL_OPTIONS.map((m) =>
    m.value === LOCAL_MODEL
      ? {
          ...m,
          label: localName ?? m.label,
          trailing: <LocalOnly />,
          title: 'On your Mac, no budget used',
        }
      : m,
  );
  if (value.model?.startsWith(`${LOCAL_MODEL}:`))
    modelOptions.push({ value: value.model, label: value.model.slice(6), trailing: <LocalOnly /> });
  const optionOf = (options: DropdownOption[], v: string | undefined) =>
    v ? (options.find((o) => o.value === v) ?? { value: v, label: v }) : undefined;

  const deviceOptions: DropdownOption[] = [
    { value: 'auto', label: 'Auto', icon: Wand2, title: 'Your Mac when it is online, else remote' },
    { value: 'gcp', label: 'Remote', icon: Cloud, title: 'A sandbox in the cloud' },
    ...macs.map((d) => ({ value: `mac:${d.id}`, label: d.name, icon: Laptop })),
  ];
  if (value.device?.startsWith('mac:') && !macs.some((d) => `mac:${d.id}` === value.device))
    deviceOptions.push({ value: value.device, label: 'Unpaired Mac', icon: Laptop });

  const browserOptions: DropdownOption[] = [
    { value: 'none', label: 'None', icon: Ban },
    { value: 'auto', label: 'Auto', icon: Sparkles, title: 'Only when the task needs one' },
    {
      value: 'chrome',
      label: 'Chrome',
      icon: Globe,
      title: 'Your Chrome on a Mac, headless Chromium remotely',
    },
  ];

  const repoOptions: DropdownOption[] = (github?.repos ?? []).map((r) => ({
    value: r.fullName,
    label: r.fullName,
  }));
  const ownRepos = repoList(value);

  return (
    // Two columns only where the fields get room: not in the task page's narrow side card.
    <div className="@container">
      <div className="grid grid-cols-1 gap-3 @md:grid-cols-2">
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
        <Field
          label="Model"
          hint={
            isLocalModel(value.model ?? inherited.model)
              ? 'Runs on your Mac (the one picked under Device, else the one seen last). No budget is used.'
              : undefined
          }
        >
          <Dropdown
            ariaLabel="Model"
            value={value.model ?? ''}
            options={modelOptions}
            inherited={optionOf(modelOptions, inherited.model ?? 'auto')}
            onChange={(model) => set({ model })}
            onReset={() => set({ model: undefined })}
          />
        </Field>
        <Field label="Device">
          <Dropdown
            ariaLabel="Device"
            value={value.device ?? ''}
            options={deviceOptions}
            inherited={optionOf(deviceOptions, inherited.device ?? 'auto')}
            onChange={(device) => set({ device })}
            onReset={() => set({ device: undefined })}
          />
        </Field>
        <Field label="Browser">
          <Dropdown
            ariaLabel="Browser"
            value={value.browser ?? ''}
            options={browserOptions}
            inherited={optionOf(browserOptions, inherited.browser ?? 'none')}
            onChange={(browser) => set({ browser: browser as AiConfig['browser'] })}
            onReset={() => set({ browser: undefined })}
          />
        </Field>
        <Field label="Budget">
          <BudgetField
            value={value.budget}
            inherited={inherited.budget}
            onChange={(budget) => set({ budget })}
          />
        </Field>
        <Field
          label="Repos"
          className="@md:col-span-2"
          hint={
            !github?.installation
              ? 'Public repos only until you connect GitHub in Settings.'
              : undefined
          }
        >
          <MultiDropdown
            ariaLabel="Repos"
            values={ownRepos}
            options={repoOptions}
            inherited={repoList(inherited)}
            inheritedNote="project"
            placeholder="None"
            searchable
            searchPlaceholder="Find a repo or type owner/name"
            custom={{
              accept: (text) => {
                const name = text.replace(/^https:\/\/github\.com\/|\.git$/g, '');
                return RepoName.safeParse(name).success ? name : undefined;
              },
              label: (v) => `Add ${v}`,
            }}
            empty="No connected repos. Type owner/name."
            onChange={(repos) => set({ repo: undefined, repos: repos.length ? repos : undefined })}
          />
        </Field>
        {toolsets.length > 0 && (
          <div className="@md:col-span-2">
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
        <Field
          label={
            <>
              Folder <LocalOnly />
            </>
          }
          className="@md:col-span-2"
        >
          <FolderField
            value={value.folder}
            inherited={inherited.folder}
            folders={[...new Set(macs.flatMap((d) => d.folders))]}
            onChange={(folder) => set({ folder })}
          />
        </Field>
      </div>
    </div>
  );
}

/** Steps that grow with the amount: cents near zero, euros further up. */
function budgetStep(eur: number, up: boolean): number {
  const at = up ? eur : eur - 0.001;
  if (at < 0.5) return 0.05;
  if (at < 2) return 0.25;
  if (at < 10) return 1;
  return 5;
}

const BUDGET_PRESETS = [0.1, 0.5, 1, 2, 5];

/**
 * The task budget as a value you see and step: − and + move it in steps that fit the amount,
 * the amount itself can be typed, and presets set it in one click. Empty inherits.
 */
function BudgetField({
  value,
  inherited,
  onChange,
}: {
  value: number | undefined;
  inherited: number | undefined;
  onChange: (micro: number | undefined) => void;
}) {
  const effective = value ?? inherited ?? 0;
  const eur = effective / 1_000_000;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  const setEur = (n: number) => onChange(Math.round(Math.max(0, n) * 100) * 10_000);
  const step = (up: boolean) => {
    const s = budgetStep(eur, up);
    // Snap to the step grid first, so 0.37 goes to 0.40, not 0.42.
    const snapped = up ? Math.floor(eur / s + 1e-9) * s + s : Math.ceil(eur / s - 1e-9) * s - s;
    setEur(snapped);
  };
  const commit = () => {
    setEditing(false);
    const n = Number(text.replace(',', '.').replace(/[€\s]/g, ''));
    if (text.trim() === '') return;
    if (Number.isFinite(n)) setEur(n);
  };
  const btn =
    'flex h-9 w-9 shrink-0 items-center justify-center text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-40';
  return (
    <div>
      <div className="flex h-9 items-stretch overflow-hidden rounded-md border bg-card focus-within:ring-2 focus-within:ring-primary/30">
        <button
          type="button"
          className={btn}
          aria-label="Lower budget"
          disabled={effective <= 0}
          onClick={() => step(false)}
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        {editing ? (
          <input
            ref={input}
            id={id}
            aria-label="Budget in euro"
            inputMode="decimal"
            className="w-full min-w-0 bg-transparent text-center text-sm tabular-nums outline-none"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit();
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setEditing(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            title="Type an amount"
            aria-label={`Budget ${formatEur(effective)}${value === undefined ? ', the default' : ''}. Type an amount`}
            className="flex min-w-0 flex-1 items-center justify-center gap-1.5 border-x text-sm tabular-nums hover:bg-accent/40"
            onClick={() => {
              setText(eur.toFixed(2));
              setEditing(true);
            }}
          >
            <span className={cn(value === undefined && 'text-muted-foreground')}>
              {formatEur(effective)}
            </span>
            {value === undefined && (
              <span className="text-xs text-muted-foreground opacity-70">· default</span>
            )}
          </button>
        )}
        <button type="button" className={btn} aria-label="Raise budget" onClick={() => step(true)}>
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {BUDGET_PRESETS.map((p) => {
          const on = value !== undefined && Math.abs(eur - p) < 0.001;
          return (
            <button
              key={p}
              type="button"
              aria-pressed={on}
              onClick={() => setEur(p)}
              className={cn(
                'rounded px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground transition hover:bg-accent hover:text-foreground',
                on && 'bg-muted text-foreground',
              )}
            >
              €{p < 1 ? p.toFixed(2) : p}
            </button>
          );
        })}
        {value !== undefined && (
          <button
            type="button"
            title="Back to the default"
            aria-label="Use the default budget"
            onClick={() => onChange(undefined)}
            className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <RotateCcw className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}

/** Home as ~, so a path reads short. */
const shortPath = (p: string) => p.replace(/^\/Users\/[^/]+(?=\/|$)/, '~');

/**
 * The folder on your Mac the agent works in, picked from the folders the Mac allows (`dodo
 * folders add`) or typed. Empty: a scratch folder per task.
 */
function FolderField({
  value,
  inherited,
  folders,
  onChange,
}: {
  value: string | undefined;
  inherited: string | undefined;
  folders: string[];
  onChange: (folder: string | undefined) => void;
}) {
  const options: DropdownOption[] = folders.map((f) => ({
    value: f,
    label: shortPath(f),
    icon: FolderOpen,
    title: f,
  }));
  const shown = value ?? inherited;
  return (
    <Dropdown
      ariaLabel="Folder"
      value={value ?? ''}
      options={options}
      searchable
      custom={{
        accept: (text) => (text.startsWith('/') || text.startsWith('~') ? text : undefined),
        label: (v) => `Use ${v}`,
      }}
      onChange={(folder) => onChange(folder || undefined)}
      onReset={() => onChange(undefined)}
      resetLabel={inherited ? 'Use the project folder' : 'Use a scratch folder'}
      footer={
        folders.length
          ? 'Folders your Mac allows. Add more with dodo folders add.'
          : 'No folders on your Mac yet: dodo folders add ~/code, or type a path.'
      }
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span
          className={cn('truncate font-mono text-xs', !value && 'text-muted-foreground')}
          title={shown}
        >
          {shown ? shortPath(shown) : 'Scratch folder for this task'}
        </span>
        {!value && inherited && (
          <span className="shrink-0 text-xs text-muted-foreground opacity-70">· project</span>
        )}
      </span>
      <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
    </Dropdown>
  );
}
