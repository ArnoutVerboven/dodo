import { onIdTokenChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import { createContext, useContext, useEffect, useState } from 'react';
import { auth, googleProvider } from './firebase';

interface AuthState {
  user: User | null;
  isOwner: boolean;
  loading: boolean;
}

const AuthContext = createContext<AuthState>({ user: null, isOwner: false, loading: true });

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({ user: null, isOwner: false, loading: true });
  useEffect(
    () =>
      onIdTokenChanged(auth, async (user) => {
        const token = user ? await user.getIdTokenResult() : null;
        setState({ user, isOwner: token?.claims.dodo_owner === true, loading: false });
      }),
    [],
  );
  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
export const signIn = () => signInWithPopup(auth, googleProvider);
export const signOutUser = () => signOut(auth);
export const refreshClaims = () => auth.currentUser?.getIdToken(true);
