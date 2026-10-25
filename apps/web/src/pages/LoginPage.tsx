import { signInWithEmailAndPassword } from 'firebase/auth';
import { Button } from '@/components/ui/button';
import { refreshClaims, signIn, signOutUser, useAuth } from '@/lib/auth';
import { auth, usingEmulators } from '@/lib/firebase';

export function LoginPage() {
  const { user } = useAuth();
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
            <p>
              Signed in as <b>{user.email}</b>, but this account is not the owner of this dodo
              instance yet.
            </p>
            <p className="text-muted-foreground">
              Run <code>node infra/grant-owner.mjs PROJECT_ID {user.email}</code> once, then
              refresh.
            </p>
            <div className="flex justify-center gap-2">
              <Button
                variant="outline"
                onClick={() => refreshClaims()?.then(() => window.location.reload())}
              >
                Refresh
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
