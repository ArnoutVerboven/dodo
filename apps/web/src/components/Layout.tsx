import { FolderKanban, LayoutList, LogOut, Settings, Wallet, Workflow, Wrench } from 'lucide-react';
import { NavLink } from 'react-router';
import { signOutUser } from '@/lib/auth';
import { useSettings } from '@/lib/data';
import { usingEmulators } from '@/lib/firebase';
import { cn } from '@/lib/utils';

const nav = [
  { to: '/', label: 'Tasks', icon: LayoutList },
  { to: '/projects', label: 'Projects', icon: FolderKanban },
  { to: '/jobs', label: 'Jobs', icon: Workflow },
  { to: '/tools', label: 'Tools', icon: Wrench },
  { to: '/budget', label: 'Budget', icon: Wallet },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const { data: settings } = useSettings();
  return (
    <div className="min-h-screen">
      {settings.halted && (
        <div className="bg-danger px-4 py-2 text-center text-sm text-white">
          Processing is halted: {settings.haltReason ?? 'kill switch active'}. No AI work will start
          until you resume it in Settings.
        </div>
      )}
      {usingEmulators && (
        <div className="bg-muted px-4 py-1 text-center text-xs text-muted-foreground">
          Local emulators
        </div>
      )}
      <header className="sticky top-0 z-10 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-12 max-w-[96rem] items-center gap-1 px-4">
          <span className="mr-4 font-semibold tracking-tight">dodo</span>
          <nav className="flex flex-1 gap-1 overflow-x-auto">
            {nav.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                end={to === '/'}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-accent',
                    isActive && 'bg-accent text-foreground',
                  )
                }
              >
                <Icon className="h-4 w-4" />
                <span className="hidden sm:inline">{label}</span>
              </NavLink>
            ))}
          </nav>
          <button
            type="button"
            onClick={signOutUser}
            className="rounded-md p-2 text-muted-foreground hover:bg-accent"
            aria-label="Sign out"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-[96rem] px-4 py-6">{children}</main>
    </div>
  );
}
