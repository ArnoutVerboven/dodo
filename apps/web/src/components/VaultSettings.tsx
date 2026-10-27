import type { VaultEntry } from '@dodo/core';
import { KeyRound, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { deleteVaultEntry, saveVaultEntry, useVault } from '@/lib/data';

interface FieldRow {
  key: string;
  label: string;
  value: string;
  /** The field already has a stored value (editing): empty keeps it. */
  stored: boolean;
}
interface Draft {
  id: string;
  isNew: boolean;
  name: string;
  domains: string;
  hint: string;
  fields: FieldRow[];
}

const slug = (s: string, max = 40) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'entry';
const fieldKey = (label: string) => slug(label).replace(/-/g, '_');

const TEMPLATES: Record<string, { hint: string; fields: string[] }> = {
  'Username and password': { hint: '', fields: ['Username', 'Password'] },
  itsme: {
    hint: 'Log in with itsme: type the phone number, then I approve in the itsme app.',
    fields: ['Phone number'],
  },
  'Email and password': { hint: '', fields: ['Email', 'Password'] },
};

const blank = (template = 'Username and password'): Draft => ({
  id: '',
  isNew: true,
  name: '',
  domains: '',
  hint: TEMPLATES[template]?.hint ?? '',
  fields: (TEMPLATES[template]?.fields ?? []).map((label) => ({
    key: fieldKey(label),
    label,
    value: '',
    stored: false,
  })),
});

const fromEntry = (e: VaultEntry): Draft => ({
  id: e.id,
  isNew: false,
  name: e.name,
  domains: e.domains.join(', '),
  hint: e.hint,
  fields: e.fields.map((f) => ({ ...f, value: '', stored: true })),
});

/**
 * Settings card: the agent vault. Values are sent to the server once and never shown again;
 * the agent can type them into the entry's sites after you approve the entry for a task.
 */
export function VaultSettings() {
  const { data: entries } = useVault();
  const [draft, setDraft] = useState<Draft>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError(undefined);
    try {
      const id = draft.isNew ? slug(draft.id || draft.name) : draft.id;
      if (draft.isNew && entries.some((e) => e.id === id)) {
        throw new Error(`An entry called ${id} exists already; pick another name.`);
      }
      await saveVaultEntry({
        id,
        name: draft.name.trim(),
        domains: draft.domains
          .split(/[\s,]+/)
          .map((d) =>
            d
              .trim()
              .replace(/^https?:\/\//, '')
              .replace(/\/.*$/, ''),
          )
          .filter(Boolean),
        hint: draft.hint.trim(),
        fields: draft.fields
          .filter((f) => f.label.trim())
          .map((f) => ({
            key: f.key || fieldKey(f.label),
            label: f.label.trim(),
            value: f.value === '' ? undefined : f.value,
          })),
      });
      setDraft(undefined);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (e: VaultEntry) => {
    if (!window.confirm(`Delete ${e.name} and its stored values?`)) return;
    await deleteVaultEntry(e.id).catch((err) => setError((err as Error).message));
  };

  const setField = (i: number, change: Partial<FieldRow>) =>
    setDraft(
      (d) => d && { ...d, fields: d.fields.map((f, j) => (j === i ? { ...f, ...change } : f)) },
    );

  return (
    <Card>
      <CardHeader
        title="Vault"
        action={
          !draft && (
            <Button size="sm" variant="outline" onClick={() => setDraft(blank())}>
              <Plus className="mr-1 h-3.5 w-3.5" /> Add login
            </Button>
          )
        }
      />
      <CardBody className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Passwords, usernames and other values the agent may type into a site without ever seeing
          them (for example your phone number for itsme). Values are stored in Google Secret Manager
          and cannot be read back here. Each task asks your approval before it uses an entry, and
          only on the sites you list.
        </p>

        {entries.length === 0 && !draft && <p className="text-muted-foreground">No entries yet.</p>}
        {entries.map((e) => (
          <div
            key={e.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border p-2"
          >
            <KeyRound className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">{e.name}</span>
            <span className="text-xs text-muted-foreground">
              {e.domains.join(', ')} · {e.fields.map((f) => f.label).join(', ')}
              {e.lastUsed
                ? ` · last used ${new Date(e.lastUsed.at).toLocaleString()}`
                : ' · never used'}
            </span>
            <span className="ml-auto flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => setDraft(fromEntry(e))}>
                Edit
              </Button>
              <Button size="sm" variant="ghost" onClick={() => remove(e)}>
                Delete
              </Button>
            </span>
          </div>
        ))}

        {draft && (
          <div className="space-y-3 rounded-md border bg-muted/40 p-3">
            {draft.isNew && (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-muted-foreground">Start from</span>
                {Object.keys(TEMPLATES).map((t) => (
                  <Button
                    key={t}
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setDraft((d) => ({
                        ...blank(t),
                        name: d?.name ?? '',
                        domains: d?.domains ?? '',
                      }))
                    }
                  >
                    {t}
                  </Button>
                ))}
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <label>
                <Label>Name</Label>
                <Input
                  placeholder="e.g. Energy provider"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              <label>
                <Label>Sites it may be used on</Label>
                <Input
                  placeholder="e.g. engie.be, itsme-id.com"
                  value={draft.domains}
                  onChange={(e) => setDraft({ ...draft, domains: e.target.value })}
                />
              </label>
              <label className="sm:col-span-2">
                <Label>Login hint for the agent (not secret)</Label>
                <Input
                  placeholder="e.g. Log in with itsme"
                  value={draft.hint}
                  onChange={(e) => setDraft({ ...draft, hint: e.target.value })}
                />
              </label>
            </div>
            <div className="space-y-2">
              <Label>Values</Label>
              {draft.fields.map((f, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place
                <div key={i} className="flex gap-2">
                  <Input
                    className="w-40"
                    placeholder="Label"
                    value={f.label}
                    disabled={f.stored}
                    onChange={(e) =>
                      setField(i, { label: e.target.value, key: fieldKey(e.target.value) })
                    }
                  />
                  <Input
                    className="min-w-0 flex-1"
                    type="password"
                    autoComplete="new-password"
                    placeholder={f.stored ? '•••••• stored; type to replace' : 'Value'}
                    value={f.value}
                    onChange={(e) => setField(i, { value: e.target.value })}
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Remove"
                    onClick={() =>
                      setDraft({ ...draft, fields: draft.fields.filter((_, j) => j !== i) })
                    }
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setDraft({
                    ...draft,
                    fields: [...draft.fields, { key: '', label: '', value: '', stored: false }],
                  })
                }
              >
                <Plus className="mr-1 h-3.5 w-3.5" /> Add a value
              </Button>
            </div>
            {error && <p className="text-danger">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setDraft(undefined)}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={busy || !draft.name.trim() || !draft.domains.trim()}
                onClick={save}
              >
                {busy ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
