import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { disablePush, enablePush, type PushState, pushState } from '@/lib/push';

const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent);

/** Settings card: turn web push on or off for this browser. */
export function PushSettings() {
  const [state, setState] = useState<PushState | 'loading'>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    pushState().then(setState, () => setState('off'));
  }, []);

  const run = async (fn: () => Promise<PushState>) => {
    setBusy(true);
    setError('');
    try {
      setState(await fn());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Push notifications" />
      <CardBody className="space-y-2 text-sm">
        {state === 'loading' && <p className="text-muted-foreground">Checking this browser…</p>}
        {state === 'unsupported' && (
          <p className="text-muted-foreground">
            {isIos()
              ? 'On iPhone, add dodo to your home screen (Share › Add to Home Screen) and open it from there to turn on notifications.'
              : 'This browser does not support web push.'}
          </p>
        )}
        {state === 'blocked' && (
          <p className="text-muted-foreground">
            Notifications are blocked for this site. Allow them in your browser settings, then
            reload.
          </p>
        )}
        {state === 'off' && (
          <>
            <p className="text-muted-foreground">
              Get a notification on this device when a task needs you or finishes.
            </p>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => run(enablePush)}>
              Turn on for this device
            </Button>
          </>
        )}
        {state === 'on' && (
          <>
            <p>On for this device. Tapping a notification opens the task.</p>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => run(disablePush)}>
              Turn off
            </Button>
          </>
        )}
        {error && <p className="text-danger">{error}</p>}
      </CardBody>
    </Card>
  );
}
