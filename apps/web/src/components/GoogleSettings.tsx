import { DEFAULT_DRIVE_FOLDER, DriveFolderName, GOOGLE_SCOPE } from '@dodo/core';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { SourceIcon } from '@/components/SourceIcon';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { saveSettings, useSettings } from '@/lib/data';
import { connectGoogle, disconnectGoogle, useConnector } from '@/lib/jobs';

const RESULTS: Record<string, string> = {
  connected: 'Google is connected.',
  missing_scopes: 'Some permissions were not granted. Connect again and tick every box.',
  cancelled: 'Connecting Google was cancelled.',
  invalid_state: 'That sign-in link expired. Try again.',
  not_configured: 'Google is not set up for this deployment yet (docs/JOBS.md).',
  error: 'Connecting Google failed. Try again.',
};

const ACCESS: Array<{ scope: string; label: string }> = [
  { scope: GOOGLE_SCOPE.gmailRead, label: 'Gmail: search and read (drafts for Jobs)' },
  { scope: GOOGLE_SCOPE.calendarEvents, label: 'Calendar: read, and add events you approve' },
  {
    scope: GOOGLE_SCOPE.drive,
    label: 'Drive: search, read, save to your folder, edit what you approve',
  },
];

/**
 * Settings › Integrations: one Google account for the Jobs (email follow-ups) and the agent's
 * Google tools (Gmail, Calendar, Drive), and the Drive folder the agent saves files to.
 */
export function GoogleSettings() {
  const { data: connector, loading } = useConnector('google');
  const { data: settings } = useSettings();
  const [params, setParams] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const saved = settings.google?.driveFolder ?? DEFAULT_DRIVE_FOLDER;
  const [folder, setFolder] = useState(saved);
  useEffect(() => setFolder(saved), [saved]);
  const result = params.get('google');

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const dismiss = () => {
    params.delete('google');
    setParams(params, { replace: true });
  };

  const live = connector?.status === 'connected' || connector?.status === 'missing_scopes';
  const granted = new Set(connector?.scopes ?? []);
  const missing = ACCESS.filter((a) => !granted.has(a.scope));
  const folderOk = DriveFolderName.safeParse(folder).success;
  const knownFolder =
    connector?.driveFolder && connector.driveFolder.name === saved
      ? connector.driveFolder
      : undefined;

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <SourceIcon source={{ kind: 'gmail' }} /> Google
          </span>
        }
        action={
          !loading && (
            <div className="flex gap-1">
              {live && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => act(disconnectGoogle)}
                >
                  Disconnect
                </Button>
              )}
              <Button
                size="sm"
                variant={live && missing.length === 0 ? 'outline' : 'default'}
                disabled={busy}
                onClick={() => act(connectGoogle)}
              >
                {connector && connector.status !== 'disconnected' ? 'Reconnect' : 'Connect Google'}
              </Button>
            </div>
          )
        }
      />
      <CardBody className="space-y-3 text-sm">
        {result && (
          <p className={result === 'connected' ? 'text-success' : 'text-danger'}>
            {RESULTS[result] ?? result}{' '}
            <button type="button" className="underline" onClick={dismiss}>
              OK
            </button>
          </p>
        )}
        {loading ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : live ? (
          <>
            <p>
              Connected as <b>{connector.email ?? 'your account'}</b>. The agent gets Gmail,
              Calendar and Drive tools (Tools › Built-in › Google), and the email Jobs use the same
              account.
            </p>
            <ul className="space-y-0.5 text-xs">
              {ACCESS.map((a) => (
                <li key={a.scope} className={granted.has(a.scope) ? '' : 'text-danger'}>
                  {granted.has(a.scope) ? '✓' : '✗'} {a.label}
                </li>
              ))}
            </ul>
            {missing.length > 0 && (
              <p className="text-xs text-danger">
                Not granted: {missing.map((m) => m.label.split(':')[0]).join(', ')}. Reconnect and
                tick every box to give the agent that access.
              </p>
            )}
          </>
        ) : (
          <p className="text-muted-foreground">
            {connector?.error ??
              'Connect your Google account so the agent can search and read your mail, see and add to your calendar, and keep files in your Drive. Sending mail, deleting and changing existing files never happen without your approval.'}
          </p>
        )}
        <div className="space-y-1">
          <Label>Drive folder for files the agent saves</Label>
          <div className="flex gap-2">
            <Input
              aria-label="Drive folder"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              className="max-w-xs"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!folderOk || folder.trim() === saved}
              onClick={() => act(() => saveSettings({ google: { driveFolder: folder.trim() } }))}
            >
              Save
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            At the top of My Drive; created the first time the agent saves a file. Each saved file
            is also attached to its task as a Drive link.
            {knownFolder && (
              <>
                {' '}
                <a href={knownFolder.url} target="_blank" rel="noreferrer" className="underline">
                  Open {knownFolder.name}
                </a>
              </>
            )}
          </p>
          {!folderOk && <p className="text-xs text-danger">A name without slashes or quotes.</p>}
        </div>
        {error && <p className="text-danger">{error}</p>}
      </CardBody>
    </Card>
  );
}
