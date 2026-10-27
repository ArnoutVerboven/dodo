import type { PersonalInfo } from '@dodo/core';
import { Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Input, Label, Textarea } from '@/components/ui/input';
import { savePersonalInfo, usePersonalInfo } from '@/lib/data';

type Form = Omit<PersonalInfo, 'updatedAt'>;
const EMPTY: Form = { extra: [], address: {} };

/** Settings card: details the agent may use freely (not secret; passwords go in the vault). */
export function PersonalInfoSettings() {
  const { data, loading } = usePersonalInfo();
  const [form, setForm] = useState<Form>(EMPTY);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (data) {
      const { updatedAt: _u, ...rest } = data;
      setForm({ ...EMPTY, ...rest, address: rest.address ?? {} });
    }
  }, [data]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setAddress = (k: keyof NonNullable<Form['address']>, v: string) =>
    setForm((f) => ({ ...f, address: { ...f.address, [k]: v } }));
  const text = (k: 'fullName' | 'email' | 'phone' | 'birthDate' | 'language' | 'timeZone') => ({
    value: form[k] ?? '',
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(k, e.target.value),
  });

  const save = async () => {
    setError(undefined);
    // Empty strings are left out, so the agent sees "unknown" instead of "".
    const trim = (v?: string) => (v?.trim() ? v.trim() : undefined);
    try {
      await savePersonalInfo({
        fullName: trim(form.fullName),
        email: trim(form.email),
        phone: trim(form.phone),
        address: {
          street: trim(form.address?.street),
          postalCode: trim(form.address?.postalCode),
          city: trim(form.address?.city),
          country: trim(form.address?.country),
        },
        birthDate: trim(form.birthDate),
        language: trim(form.language),
        timeZone: trim(form.timeZone),
        extra: form.extra
          .filter((x) => x.label.trim())
          .map((x) => ({ ...x, label: x.label.trim() })),
        notes: trim(form.notes),
        schedulingNotes: trim(form.schedulingNotes),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (loading) return null;
  return (
    <Card>
      <CardHeader title="Personal info" />
      <CardBody className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Details the agent uses for forms, sign-ups and planning, so it does not have to ask. This
          is not secret: the agent reads it as plain text. Put passwords and ID numbers in the
          vault.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label>
            <Label>Full name</Label>
            <Input {...text('fullName')} autoComplete="name" />
          </label>
          <label>
            <Label>Email</Label>
            <Input {...text('email')} type="email" autoComplete="email" />
          </label>
          <label>
            <Label>Phone</Label>
            <Input {...text('phone')} type="tel" autoComplete="tel" />
          </label>
          <label>
            <Label>Date of birth</Label>
            <Input {...text('birthDate')} placeholder="1990-01-31" />
          </label>
          <label className="sm:col-span-2">
            <Label>Street and number</Label>
            <Input
              value={form.address?.street ?? ''}
              onChange={(e) => setAddress('street', e.target.value)}
              autoComplete="street-address"
            />
          </label>
          <div className="grid grid-cols-[7rem_1fr] gap-3 sm:col-span-2 sm:grid-cols-[7rem_1fr_1fr]">
            <label>
              <Label>Postal code</Label>
              <Input
                value={form.address?.postalCode ?? ''}
                onChange={(e) => setAddress('postalCode', e.target.value)}
                autoComplete="postal-code"
              />
            </label>
            <label>
              <Label>City</Label>
              <Input
                value={form.address?.city ?? ''}
                onChange={(e) => setAddress('city', e.target.value)}
              />
            </label>
            <label className="col-span-2 sm:col-span-1">
              <Label>Country</Label>
              <Input
                value={form.address?.country ?? ''}
                onChange={(e) => setAddress('country', e.target.value)}
              />
            </label>
          </div>
          <label>
            <Label>Languages</Label>
            <Input {...text('language')} placeholder="Dutch, English" />
          </label>
          <label>
            <Label>Time zone</Label>
            <Input {...text('timeZone')} placeholder="Europe/Brussels" />
          </label>
        </div>

        <div className="space-y-2">
          <Label>Other details</Label>
          {form.extra.map((x, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id and are edited in place
            <div key={i} className="flex gap-2">
              <Input
                className="w-40"
                placeholder="Label, e.g. Company"
                value={x.label}
                onChange={(e) =>
                  set(
                    'extra',
                    form.extra.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)),
                  )
                }
              />
              <Input
                className="min-w-0 flex-1"
                value={x.value}
                onChange={(e) =>
                  set(
                    'extra',
                    form.extra.map((y, j) => (j === i ? { ...y, value: e.target.value } : y)),
                  )
                }
              />
              <Button
                size="icon"
                variant="ghost"
                aria-label="Remove"
                onClick={() =>
                  set(
                    'extra',
                    form.extra.filter((_, j) => j !== i),
                  )
                }
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button
            size="sm"
            variant="outline"
            onClick={() => set('extra', [...form.extra, { label: '', value: '' }])}
          >
            <Plus className="mr-1 h-3.5 w-3.5" /> Add a detail
          </Button>
        </div>

        <label className="block">
          <Label>When you are available</Label>
          <Textarea
            className="min-h-16"
            placeholder="e.g. I work Monday to Thursday, usually late. Fridays and weekends are free."
            value={form.schedulingNotes ?? ''}
            maxLength={2000}
            onChange={(e) => set('schedulingNotes', e.target.value)}
          />
        </label>
        <label className="block">
          <Label>Anything else the agent should know about you</Label>
          <Textarea
            className="min-h-16"
            value={form.notes ?? ''}
            maxLength={4000}
            onChange={(e) => set('notes', e.target.value)}
          />
        </label>

        <div className="flex items-center justify-end gap-3">
          {error && <span className="text-danger">{error}</span>}
          {saved && <span className="text-success">Saved</span>}
          <Button size="sm" onClick={save}>
            Save personal info
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
