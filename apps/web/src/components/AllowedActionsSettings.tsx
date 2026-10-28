import { X } from 'lucide-react';
import { useEffect } from 'react';
import { Link, useLocation } from 'react-router';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { removeAllowRule, useProjects, useSettings, useTasks } from '@/lib/data';

type Where = Parameters<typeof removeAllowRule>[0];

interface Group {
  key: string;
  label: React.ReactNode;
  where: Where;
  rules: string[];
}

/**
 * Settings card: every rule you answered "Allow always" on an approval, grouped by where it
 * applies. Removing one makes the agent ask again next time.
 */
export function AllowedActionsSettings() {
  const { data: settings } = useSettings();
  const { data: projects } = useProjects();
  const { data: tasks } = useTasks();
  const { hash } = useLocation();
  useEffect(() => {
    if (hash === '#allowed-actions') {
      document.getElementById('allowed-actions')?.scrollIntoView({ block: 'start' });
    }
  }, [hash]);

  const groups: Group[] = [
    {
      key: 'global',
      label: 'Everywhere',
      where: { scope: 'global' } as Where,
      rules: settings.allowRules ?? [],
    },
    ...projects.map((p) => ({
      key: `p_${p.id}`,
      label: <>Project {p.name}</>,
      where: { scope: 'project' as const, id: p.id },
      rules: p.allowRules ?? [],
    })),
    ...tasks.map((t) => ({
      key: `t_${t.id}`,
      label: (
        <>
          Task{' '}
          <Link to={`/tasks/${t.id}`} className="underline-offset-2 hover:underline">
            {t.title}
          </Link>
        </>
      ),
      where: { scope: 'task' as const, id: t.id },
      rules: t.allowRules ?? [],
    })),
  ].filter((g) => g.rules.length > 0);

  return (
    <Card id="allowed-actions" className="scroll-mt-20">
      <CardHeader title="Always allowed" />
      <CardBody className="space-y-3 text-sm">
        {groups.length === 0 ? (
          <p className="text-muted-foreground">
            Nothing yet. When the agent asks for approval, pick Allow always to stop it asking again
            for that action, in that task, its project, or everywhere.
          </p>
        ) : (
          groups.map((g) => (
            <div key={g.key}>
              <p className="mb-1 text-xs font-medium text-muted-foreground">{g.label}</p>
              <ul className="space-y-1">
                {g.rules.map((rule) => (
                  <li
                    key={rule}
                    className="flex items-center gap-2 rounded-md border bg-muted/40 py-1 pr-1 pl-3"
                  >
                    <code className="min-w-0 flex-1 truncate text-xs" title={rule}>
                      {rule}
                    </code>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Remove ${rule}`}
                      title="Remove: ask again next time"
                      onClick={() => removeAllowRule(g.where, rule)}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </CardBody>
    </Card>
  );
}
