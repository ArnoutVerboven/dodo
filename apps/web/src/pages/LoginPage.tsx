import { signInWithEmailAndPassword } from 'firebase/auth';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { claimOwnership, signIn, signOutUser, useAuth } from '@/lib/auth';
import { auth, usingEmulators } from '@/lib/firebase';

export function LoginPage() {
  const { user, isOwner } = useAuth();
  const [claim, setClaim] = useState<{ pending: boolean; reason?: string }>({ pending: false });
  // Signed in but not the owner yet: ask the backend once. The configured owner gets the
  // claim and the token refresh flips isOwner; anyone else sees the refusal.
  useEffect(() => {
    if (!user || isOwner) return;
    let cancelled = false;
    setClaim({ pending: true });
    claimOwnership().then((r) => {
      if (!cancelled) setClaim({ pending: false, reason: r.ok ? undefined : r.reason });
    });
    return () => {
      cancelled = true;
    };
  }, [user, isOwner]);
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-lg border bg-card p-6 text-center">
        <h1 className="text-xl font-semibold">dodo</h1>
        <p className="mt-1 text-sm text-muted-foreground">Your asynchronous AI task board.</p>
        {!user ? (
          <div className="mt-6 space-y-2">
            <Button className="w-full justify-center" onClick={() => signIn()}>
              Sign in with Google
            </Button>
            {usingEmulators && (
              <Button
                variant="outline"
                className="w-full justify-center"
                onClick={() => signInWithEmailAndPassword(auth, 'owner@dodo.local', 'dodo-local')}
              >
                Sign in as local owner
              </Button>
            )}
          </div>
        ) : (
          <div className="mt-6 space-y-3 text-sm">
            {claim.pending ? (
              <p>Checking whether {user.email} owns this dodo instance…</p>
            ) : (
              <>
                <p>
                  Signed in as <b>{user.email}</b>, but this account is not the owner of this dodo
                  instance.
                </p>
                <p className="text-muted-foreground">
                  {claim.reason ?? 'Unknown error'}. The owner is the account set as{' '}
                  <code>OWNER_EMAIL</code> in the repository variables.
                </p>
              </>
            )}
            <div className="flex justify-center gap-2">
              <Button
                variant="outline"
                disabled={claim.pending}
                onClick={() => claimOwnership().then((r) => r.ok && window.location.reload())}
              >
                Retry
              </Button>
              <Button variant="ghost" onClick={signOutUser}>
                Sign out
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
