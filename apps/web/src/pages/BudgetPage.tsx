import { useMemo } from 'react';
import { Link } from 'react-router';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Meter } from '@/components/ui/progress';
import {
  type LedgerRow,
  useBudgets,
  useLedger,
  useProjects,
  useSettings,
  useTasks,
} from '@/lib/data';
import { formatEur, timeAgo } from '@/lib/utils';

const monthKey = () => new Date().toISOString().slice(0, 7);

function groupSum(rows: LedgerRow[], key: (r: LedgerRow) => string | undefined) {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = key(r) ?? '—';
    m.set(k, (m.get(k) ?? 0) + r.actual);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

export function BudgetPage() {
  const { data: settings } = useSettings();
  const { data: budgets } = useBudgets();
  const { data: ledger } = useLedger(undefined, 500);
  const { data: tasks } = useTasks();
  const { data: projects } = useProjects();
  const month = monthKey();
  const global = budgets.find((b) => b.id === `global_${month}`) ?? {
    spent: 0,
    reserved: 0,
    limit: null,
  };
  const monthLedger = useMemo(
    () => ledger.filter((r) => new Date(r.createdAt).toISOString().slice(0, 7) === month),
    [ledger, month],
  );
  const taskTitle = new Map(tasks.map((t) => [t.id, t.title]));
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  const cap = settings.monthlyBudget;

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Budget</h1>
      <Card>
        <CardHeader title={`This month (${month})`} />
        <CardBody className="space-y-2">
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-semibold">{formatEur(global.spent)}</span>
            <span className="text-sm text-muted-foreground">of {formatEur(cap)} internal cap</span>
          </div>
          <Meter value={global.spent + global.reserved} max={cap} />
          <p className="text-xs text-muted-foreground">
            {global.reserved > 0 && `${formatEur(global.reserved)} reserved by running steps. `}
            The GCP backstop halts processing at 40 EUR and detaches billing at 45 EUR of actual GCP
            spend (budget 50 EUR).
          </p>
        </CardBody>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        <Breakdown title="By category" rows={groupSum(monthLedger, (r) => r.category)} />
        <Breakdown
          title="By model"
          rows={groupSum(
            monthLedger.filter((r) => r.model),
            (r) => r.model,
          )}
        />
        <Breakdown
          title="By project"
          rows={groupSum(monthLedger, (r) =>
            r.projectId ? (projectName.get(r.projectId) ?? r.projectId) : 'No project',
          )}
        />
      </div>

      <Card>
        <CardHeader title="Spend per task" />
        <CardBody className="p-0">
          <TaskSpendTable
            rows={budgets
              .filter((b) => b.id.startsWith('task_') && b.spent + b.reserved > 0)
              .map((b) => ({ ...b, taskId: b.id.slice(5) }))
              .sort((a, b) => b.spent - a.spent)}
            taskTitle={taskTitle}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Recent costs" />
        <CardBody className="p-0">
          {ledger.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No costs recorded yet.</p>
          ) : (
            <ul className="divide-y text-sm">
              {ledger.slice(0, 50).map((r) => (
                <li key={r.id} className="flex items-center gap-3 px-4 py-2">
                  <span className="w-20 shrink-0 text-xs text-muted-foreground">
                    {timeAgo(r.createdAt)}
                  </span>
                  <span className="w-16 shrink-0 text-xs">{r.category}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {r.description}
                    {r.taskId && (
                      <span className="text-muted-foreground">
                        {' '}
                        · {taskTitle.get(r.taskId) ?? r.taskId}
                      </span>
                    )}
                  </span>
                  <span className="tabular-nums">{formatEur(r.actual, 4)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function Breakdown({ title, rows }: { title: string; rows: [string, number][] }) {
  const max = rows[0]?.[1] ?? 0;
  return (
    <Card>
      <CardHeader title={title} />
      <CardBody className="space-y-2 text-sm">
        {rows.length === 0 && <p className="text-muted-foreground">Nothing this month.</p>}
        {rows.map(([k, v]) => (
          <div key={k}>
            <div className="flex justify-between">
              <span className="truncate">{k}</span>
              <span className="tabular-nums">{formatEur(v)}</span>
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary/60"
                style={{ width: `${max ? (v / max) * 100 : 0}%` }}
              />
            </div>
          </div>
        ))}
      </CardBody>
    </Card>
  );
}

function TaskSpendTable({
  rows,
  taskTitle,
}: {
  rows: { taskId: string; spent: number; reserved: number; limit: number | null }[];
  taskTitle: Map<string, string>;
}) {
  if (rows.length === 0)
    return <p className="p-4 text-sm text-muted-foreground">No task has spent anything yet.</p>;
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs text-muted-foreground">
        <tr>
          <th className="px-4 py-2 font-medium">Task</th>
          <th className="px-4 py-2 text-right font-medium">Spent</th>
          <th className="hidden px-4 py-2 text-right font-medium sm:table-cell">Cap</th>
        </tr>
      </thead>
      <tbody className="divide-y">
        {rows.map((r) => (
          <tr key={r.taskId}>
            <td className="max-w-0 truncate px-4 py-2">
              <Link to={`/tasks/${r.taskId}`} className="hover:underline">
                {taskTitle.get(r.taskId) ?? r.taskId}
              </Link>
            </td>
            <td className="px-4 py-2 text-right tabular-nums">{formatEur(r.spent)}</td>
            <td className="hidden px-4 py-2 text-right text-muted-foreground tabular-nums sm:table-cell">
              {r.limit === null ? '—' : formatEur(r.limit)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
