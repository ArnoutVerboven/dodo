import { NotionConnectRequest } from '@dodo/core';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { connectNotion, useNotion } from '@/lib/data';

function NotionLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="3" fill="currentColor" />
      <path
        d="M8.5 7.5v9M8.5 7.5l7 9M15.5 7.5v9"
        stroke="var(--color-background, #fff)"
        strokeWidth="1.8"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Settings › Integrations: a Notion internal integration token for the agent's Notion tools.
 * The token goes to the server, which checks it with Notion and keeps it in Secret Manager;
 * the page only ever sees the workspace name. Setup steps: docs/NOTION.md.
 */
export function NotionSettings() {
  const { data: notion, loading } = useNotion();
  const [token, setToken] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const live = notion?.status === 'connected';
  const tokenOk = NotionConnectRequest.safeParse({ token }).success;
  const showForm = !loading && (!live || editing);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      setToken('');
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <NotionLogo className="h-3.5 w-3.5 shrink-0" /> Notion
          </span>
        }
        action={
          live &&
          !editing && (
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => act(() => connectNotion(null))}
              >
                Disconnect
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(true)}>
                New token
              </Button>
            </div>
          )
        }
      />
      <CardBody className="space-y-3 text-sm">
        {loading ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : live ? (
          <p>
            Connected to <b>{notion.workspace ?? 'your workspace'}</b>
            {notion.bot ? ` as ${notion.bot}` : ''}. The agent gets the Notion tools (Tools ›
            Built-in › Notion) for the pages and databases you share with the integration (••• ›
            Connections in Notion). New pages, changes and trashing a page ask you first.
          </p>
        ) : (
          <p className={notion?.status === 'error' ? 'text-danger' : 'text-muted-foreground'}>
            {notion?.error ??
              'Connect Notion so the agent can search and read your pages and databases, and add to them with your approval.'}
          </p>
        )}
        {showForm && (
          <form
            className="space-y-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (tokenOk) void act(() => connectNotion(token.trim()));
            }}
          >
            <Label>Internal integration token</Label>
            <div className="flex gap-2">
              <Input
                aria-label="Notion token"
                type="password"
                autoComplete="off"
                placeholder="ntn_…"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                className="max-w-xs"
              />
              <Button size="sm" type="submit" disabled={busy || !tokenOk}>
                {busy ? 'Checking…' : 'Connect'}
              </Button>
              {editing && (
                <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              )}
            </div>
            <ol className="list-decimal space-y-0.5 pl-4 text-xs text-muted-foreground">
              <li>
                In Notion, open{' '}
                <a
                  href="https://www.notion.so/profile/integrations"
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  Integrations
                </a>{' '}
                and add an internal integration named dodo for your workspace.
              </li>
              <li>
                Under Capabilities tick Read, Update and Insert content (no user information is
                needed), then copy the Internal Integration Secret here.
              </li>
              <li>
                Share what the agent may use: on a page or database, ••• › Connections › dodo (its
                subpages follow).
              </li>
            </ol>
          </form>
        )}
        {error && <p className="text-danger">{error}</p>}
      </CardBody>
    </Card>
  );
}
