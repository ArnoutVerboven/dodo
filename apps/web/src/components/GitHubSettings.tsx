import { Lock } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { connectGitHub, disconnectGitHub, syncGitHub, useGitHub } from '@/lib/data';

const RESULTS: Record<string, string> = {
  connected: 'GitHub is connected.',
  invalid_state: 'That link expired or did not start here. Try again.',
  not_configured: 'The GitHub App is not set up yet. Create it first.',
  error: 'Something went wrong with GitHub. Try again; the error is below if there is one.',
};

/**
 * Settings card: the dodo GitHub App (docs/GITHUB.md). Create it (one click on GitHub), install
 * it on the repos the agent may work on, then pick a repo per project or task.
 */
export function GitHubSettings() {
  const { data: gh, loading } = useGitHub();
  const [params, setParams] = useSearchParams();
  const [org, setOrg] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const result = params.get('github');

  const act = (fn: () => Promise<unknown>) => async () => {
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
    params.delete('github');
    setParams(params, { replace: true });
  };

  return (
    <Card>
      <CardHeader title="GitHub" />
      <CardBody className="space-y-3 text-sm">
        {result && RESULTS[result] && (
          <p className={result === 'connected' ? 'text-success' : 'text-danger'}>
            {RESULTS[result]}{' '}
            <button type="button" className="underline" onClick={dismiss}>
              OK
            </button>
          </p>
        )}
        {loading ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : !gh?.app ? (
          <>
            <p className="text-muted-foreground">
              Lets the agent clone your private repos, push branches and open pull requests. dodo
              creates its own GitHub App on your account; GitHub asks you to confirm, then to pick
              the repos it may use. Pushes and pull requests still ask you first.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={busy} onClick={act(() => connectGitHub(org.trim()))}>
                Create the GitHub App
              </Button>
              <Input
                className="h-8 w-56"
                placeholder="Organization (optional)"
                value={org}
                onChange={(e) => setOrg(e.target.value)}
              />
            </div>
          </>
        ) : !gh.installation ? (
          <>
            <p>
              The app{' '}
              <a className="underline" href={gh.app.htmlUrl} target="_blank" rel="noreferrer">
                {gh.app.name}
              </a>{' '}
              exists. Install it on the repos the agent may work on.
            </p>
            <Button size="sm" disabled={busy} onClick={act(() => connectGitHub())}>
              Install on your repos
            </Button>
          </>
        ) : (
          <>
            <p>
              Connected to <b>{gh.installation.account}</b>
              {gh.installation.selection === 'all' ? ' (all repos)' : ''}. Pick a repo in a
              project's or task's AI settings; the task's repo wins.
            </p>
            {gh.repos.length === 0 ? (
              <p className="text-muted-foreground">No repos yet. Choose some on GitHub.</p>
            ) : (
              <ul className="max-h-48 space-y-0.5 overflow-auto rounded-md border p-2">
                {gh.repos.map((r) => (
                  <li key={r.fullName} className="flex items-center gap-1.5">
                    <span className="truncate">{r.fullName}</span>
                    {r.private && (
                      <Lock className="size-3 text-muted-foreground" aria-label="private" />
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-2">
              {gh.installation.htmlUrl && (
                <a href={gh.installation.htmlUrl} target="_blank" rel="noreferrer">
                  <Button size="sm" variant="outline">
                    Choose repos on GitHub
                  </Button>
                </a>
              )}
              <Button size="sm" variant="outline" disabled={busy} onClick={act(syncGitHub)}>
                Refresh list
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={act(disconnectGitHub)}>
                Disconnect
              </Button>
            </div>
          </>
        )}
        {(error || gh?.error) && <p className="text-danger">{error ?? gh?.error}</p>}
      </CardBody>
    </Card>
  );
}
