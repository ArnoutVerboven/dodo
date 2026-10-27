import type { AiConfig } from '@dodo/core';
import { useEffect, useState } from 'react';
import { AiConfigFields } from '@/components/AiConfigFields';
import { ApiTokensSettings } from '@/components/ApiTokensSettings';
import { DevicesSettings } from '@/components/DevicesSettings';
import { PushSettings } from '@/components/PushSettings';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Input, Label, Select } from '@/components/ui/input';
import { saveSettings, useSettings } from '@/lib/data';

const toEur = (micro: number) => String(micro / 1e6);
const toMicro = (v: string) => Math.round(Number(v) * 1e6);
const newCode = () =>
  Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 8);

export function SettingsPage() {
  const { data: settings, loading } = useSettings();
  const [defaults, setDefaults] = useState<Partial<AiConfig>>(settings.defaults);
  const [total, setTotal] = useState(toEur(settings.totalBudget));
  const [monthly, setMonthly] = useState(toEur(settings.monthlyBudget));
  const [perTask, setPerTask] = useState(toEur(settings.defaultTaskBudget));
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setDefaults(settings.defaults);
    setTotal(toEur(settings.totalBudget));
    setMonthly(toEur(settings.monthlyBudget));
    setPerTask(toEur(settings.defaultTaskBudget));
  }, [settings.defaults, settings.totalBudget, settings.monthlyBudget, settings.defaultTaskBudget]);

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const save = async () => {
    const { enabled: _e, ...rest } = defaults;
    await saveSettings({
      defaults: rest,
      totalBudget: toMicro(total),
      monthlyBudget: toMicro(monthly),
      defaultTaskBudget: toMicro(perTask),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-lg font-semibold">Settings</h1>

      <Card className={settings.halted ? 'border-danger' : undefined}>
        <CardHeader title="Kill switch" />
        <CardBody className="space-y-3 text-sm">
          {settings.halted ? (
            <>
              <p>
                <b>Processing is halted.</b> {settings.haltReason}
              </p>
              <p className="text-muted-foreground">
                Resuming lets agents spend again within the caps below. If the GCP backstop also
                detached billing, re-link billing in the Cloud console first.
              </p>
              <Button
                variant="danger"
                onClick={() => saveSettings({ halted: false, haltReason: '' })}
              >
                Resume processing
              </Button>
            </>
          ) : (
            <>
              <p>
                Running normally. Halting stops every new cost immediately (no new model calls,
                compute or paid actions).
              </p>
              <Button
                variant="outline"
                onClick={() =>
                  saveSettings({ halted: true, haltReason: 'Halted by hand in Settings' })
                }
              >
                Halt all processing
              </Button>
            </>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Task interface" />
        <CardBody className="text-sm">
          <label className="block">
            <Label>Where your tasks live</Label>
            <Select
              value={settings.connector}
              onChange={(e) => saveSettings({ connector: e.target.value as 'custom' })}
            >
              <option value="custom">dodo board (this app)</option>
              <option value="notion" disabled>
                Notion (later)
              </option>
              <option value="linear" disabled>
                Linear (later)
              </option>
              <option value="github" disabled>
                GitHub Issues (later)
              </option>
            </Select>
          </label>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Budgets" />
        <CardBody className="grid gap-3 sm:grid-cols-2">
          <label>
            <Label>Lifetime cap, all tasks (EUR)</Label>
            <Input
              type="number"
              min={0}
              step={1}
              value={total}
              onChange={(e) => setTotal(e.target.value)}
            />
          </label>
          <label>
            <Label>Monthly cap, all tasks (EUR)</Label>
            <Input
              type="number"
              min={0}
              step={1}
              value={monthly}
              onChange={(e) => setMonthly(e.target.value)}
            />
          </label>
          <label>
            <Label>Default per-task budget (EUR)</Label>
            <Input
              type="number"
              min={0}
              step={0.05}
              value={perTask}
              onChange={(e) => setPerTask(e.target.value)}
            />
          </label>
          <p className="col-span-full text-xs text-muted-foreground">
            These caps are what stops spending. Keep the lifetime cap below 40 EUR: the GCP safety
            net halts everything at 40 EUR of total GCP spend and detaches billing at 45 EUR.
          </p>
        </CardBody>
      </Card>

      <DevicesSettings />

      <PushSettings />

      <ApiTokensSettings />

      <Card>
        <CardHeader title="Telegram notifications" />
        <CardBody className="space-y-2 text-sm">
          {settings.telegram?.chatId ? (
            <>
              <p>Paired. Approval cards and results are sent to your Telegram chat.</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  saveSettings({ telegram: { chatId: undefined, pairingCode: newCode() } })
                }
              >
                Unpair
              </Button>
            </>
          ) : settings.telegram?.pairingCode ? (
            <>
              <p>
                Open your bot in Telegram and send:{' '}
                <code className="rounded bg-muted px-1">
                  /start {settings.telegram.pairingCode}
                </code>
              </p>
              <p className="text-muted-foreground">
                The code expires when you pair or when you generate a new one.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => saveSettings({ telegram: { pairingCode: newCode() } })}
              >
                New code
              </Button>
            </>
          ) : (
            <>
              <p className="text-muted-foreground">
                Not paired. Create a bot with BotFather, set its token as the{' '}
                <code>TELEGRAM_BOT_TOKEN</code> repository secret, then pair here.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => saveSettings({ telegram: { pairingCode: newCode() } })}
              >
                Generate pairing code
              </Button>
            </>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Default AI settings" />
        <CardBody>
          <AiConfigFields value={defaults} onChange={setDefaults} showEnabled={false} />
        </CardBody>
      </Card>

      <div className="flex items-center justify-end gap-3">
        {saved && <span className="text-sm text-success">Saved</span>}
        <Button onClick={save}>Save settings</Button>
      </div>
    </div>
  );
}
