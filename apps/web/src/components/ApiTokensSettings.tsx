import type { ApiToken } from '@dodo/core';
import { Copy } from 'lucide-react';
import { useState } from 'react';
import { SourceIcon } from '@/components/SourceIcon';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { createApiToken, deleteApiToken, revokeApiToken, useApiTokens } from '@/lib/data';

const SOURCES: ApiToken['source'][] = ['api', 'gmail', 'whatsapp', 'calendar'];
const API_URL = `https://europe-west1-${import.meta.env.VITE_FIREBASE_PROJECT_ID ?? '<project>'}.cloudfunctions.net/taskApi/v1/tasks`;

/** Settings card: tokens for the task ingest API, one per source, shown once when created. */
export function ApiTokensSettings() {
  const { data: tokens } = useApiTokens();
  const [name, setName] = useState('');
  const [source, setSource] = useState<ApiToken['source']>('api');
  const [created, setCreated] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const res = await createApiToken(name.trim(), source);
      setCreated(res.token);
      setName('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Task API" />
      <CardBody className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Scripts and pipelines can put tasks on the board with a token. Tasks they create start
          with AI off and show the source's logo.
        </p>
        <div className="flex flex-wrap gap-2">
          <Input
            className="h-8 w-48"
            placeholder="Name, e.g. Apps Script"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Select
            className="h-8 w-auto"
            value={source}
            onChange={(e) => setSource(e.target.value as ApiToken['source'])}
            aria-label="Source"
          >
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
          <Button size="sm" disabled={!name.trim() || busy} onClick={create}>
            New token
          </Button>
        </div>
        {error && <p className="text-danger">{error}</p>}
        {created && (
          <div className="space-y-2 rounded-md border bg-muted/40 p-3">
            <p>Copy the token now; it is not shown again.</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-card px-2 py-1 text-xs">
                {created}
              </code>
              <Button
                size="sm"
                variant="outline"
                onClick={() => navigator.clipboard?.writeText(created)}
                aria-label="Copy token"
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
            <pre className="overflow-x-auto rounded bg-card p-2 text-xs">
              {`curl -X POST ${API_URL} \\
  -H "Authorization: Bearer ${created.slice(0, 10)}…" \\
  -H "Content-Type: application/json" \\
  -d '{"title":"Reply to Ann","idempotencyKey":"msg-123","source":{"url":"https://…"}}'`}
            </pre>
            <Button size="sm" variant="ghost" onClick={() => setCreated(undefined)}>
              Done
            </Button>
          </div>
        )}
        {tokens.map((t) => (
          <div key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <SourceIcon source={{ kind: t.source }} />
            <span className="font-medium">{t.name}</span>
            <span className="text-xs text-muted-foreground">
              {t.prefix}… · {t.revoked ? 'revoked' : t.lastUsedAt ? 'used' : 'never used'}
              {t.lastUsedAt ? ` ${new Date(t.lastUsedAt).toLocaleString()}` : ''}
            </span>
            <span className="ml-auto">
              {t.revoked ? (
                <Button size="sm" variant="ghost" onClick={() => deleteApiToken(t.id)}>
                  Remove
                </Button>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => revokeApiToken(t.id)}>
                  Revoke
                </Button>
              )}
            </span>
          </div>
        ))}
      </CardBody>
    </Card>
  );
}
