import { type Device, isDeviceOnline } from '@dodo/core';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { removeDevice, saveDevice, saveSettings, useDevices, useSettings } from '@/lib/data';
import { pairingCode as newCode } from '@/lib/utils';

const PAIRING_TTL_MS = 15 * 60_000;

function ago(ts: number | undefined, now: number): string {
  if (ts === undefined) return 'never';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts).toLocaleString();
}

/** Settings card: the Macs that run tasks locally. Pair with a one-time code, revoke here. */
export function DevicesSettings() {
  const { data: devices } = useDevices();
  const { data: settings } = useSettings();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);
  const pairing = settings.devicePairing;
  const pairingLive = !!pairing && now - pairing.createdAt < PAIRING_TTL_MS;

  return (
    <Card>
      <CardHeader
        title="Your Macs"
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              saveSettings({ devicePairing: { code: newCode(), createdAt: Date.now() } })
            }
          >
            {pairingLive ? 'New code' : 'Add a Mac'}
          </Button>
        }
      />
      <CardBody className="space-y-3 text-sm">
        {devices.length === 0 && !pairingLive && (
          <p className="text-muted-foreground">
            No Mac paired yet. A paired Mac runs the tasks you route to it, with your folders and a
            Chrome window on your screen.
          </p>
        )}
        {devices.map((d) => (
          <DeviceRow key={d.id} device={d} now={now} />
        ))}
        {pairingLive && pairing && (
          <div className="rounded-md border bg-muted/40 p-3">
            <p className="mb-2">On the Mac, with Node 22+ and pnpm installed:</p>
            <pre className="overflow-x-auto rounded bg-card p-2 text-xs">
              {`git clone https://github.com/ArnoutVerboven/dodo && cd dodo\npnpm mac setup ${pairing.code} ~/code`}
            </pre>
            <p className="mt-2 text-xs text-muted-foreground">
              ~/code is a folder the agent may work in (any number, optional). The code works once
              and expires after 15 minutes. The Mac appears here as soon as it has signed in, and
              its tasks can use a Chrome window on it with nothing else installed.
            </p>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function DeviceRow({ device, now }: { device: Device; now: number }) {
  const online = device.state === 'approved' && isDeviceOnline(device.lastSeen, now);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span
        className={`inline-block h-2 w-2 rounded-full ${
          device.state === 'revoked' ? 'bg-muted-foreground' : online ? 'bg-success' : 'bg-danger'
        }`}
        aria-hidden
      />
      <span className="font-medium">{device.name}</span>
      <span className="text-xs text-muted-foreground">
        {device.state === 'revoked'
          ? 'revoked'
          : online
            ? device.currentRunId
              ? 'online, working'
              : 'online'
            : `offline, last seen ${ago(device.lastSeen, now)}`}
        {device.version ? ` · v${device.version}` : ''}
        {device.folders.length ? ` · ${device.folders.join(', ')}` : ''}
      </span>
      <span className="ml-auto flex gap-1">
        {device.state === 'approved' ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => saveDevice(device.id, { state: 'revoked' })}
          >
            Revoke
          </Button>
        ) : (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => saveDevice(device.id, { state: 'approved' })}
            >
              Re-approve
            </Button>
            <Button variant="ghost" size="sm" onClick={() => removeDevice(device.id)}>
              Remove
            </Button>
          </>
        )}
      </span>
    </div>
  );
}
