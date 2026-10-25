import { paths } from '@dodo/core';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import type {
  BudgetState,
  BudgetStore,
  BudgetTx,
  LedgerEntry,
  ReservationRecord,
} from './cost-gate.js';

/**
 * Firestore-backed BudgetStore. All reads happen before writes, as Firestore transactions
 * require, so writes are buffered and flushed at the end of `fn`.
 *
 * `limitFor` gives the current cap for a scope (from settings, project or task). The
 * budget document stores the running totals and a copy of the last limit for display.
 */
export class FirestoreBudgetStore implements BudgetStore {
  constructor(
    private readonly db: Firestore,
    private readonly limitFor: (scopeKey: string, tx: Transaction) => Promise<number | undefined>,
  ) {}

  transact<T>(fn: (tx: BudgetTx) => Promise<T>): Promise<T> {
    return this.db.runTransaction(async (t) => {
      const budgets = new Map<string, BudgetState>();
      const reservations = new Map<string, ReservationRecord>();
      const ledger: LedgerEntry[] = [];
      const tx: BudgetTx = {
        isHalted: async () => {
          const snap = await t.get(this.db.doc(paths.settings()));
          return snap.exists && snap.get('halted') === true;
        },
        getBudget: async (k) => {
          const pending = budgets.get(k);
          if (pending) return pending;
          const snap = await t.get(this.db.doc(paths.budget(k)));
          const d = (snap.exists ? snap.data() : {}) as Partial<BudgetState>;
          // The limit is always read live, so raising or lowering a cap applies at once.
          return {
            limit: await this.limitFor(k, t),
            reserved: d.reserved ?? 0,
            spent: d.spent ?? 0,
          };
        },
        setBudget: (k, s) => void budgets.set(k, s),
        getReservation: async (id) => {
          const pending = reservations.get(id);
          if (pending) return pending;
          const snap = await t.get(this.db.collection(paths.reservations()).doc(id));
          return snap.exists ? (snap.data() as ReservationRecord) : undefined;
        },
        putReservation: (r) => void reservations.set(r.id, r),
        appendLedger: (e) => void ledger.push(e),
      };
      const result = await fn(tx);
      for (const [k, s] of budgets) {
        t.set(this.db.doc(paths.budget(k)), { ...s, limit: s.limit ?? null }, { merge: true });
      }
      for (const [id, r] of reservations) {
        t.set(this.db.collection(paths.reservations()).doc(id), stripUndefined(r));
      }
      for (const e of ledger) {
        t.create(this.db.collection(paths.ledger()).doc(), stripUndefined(e));
      }
      return result;
    });
  }
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

const DEFAULT_MONTHLY = 35_000_000;
const DEFAULT_TASK = 500_000;

/**
 * Standard limits: the global month cap from settings (35 EUR if unset, never unlimited),
 * the project's monthly budget, and the task's own budget or the default task budget.
 */
export function defaultLimitFor(db: Firestore) {
  return async (scopeKey: string, t: Transaction): Promise<number | undefined> => {
    const settings = (await t.get(db.doc(paths.settings()))).data() ?? {};
    if (scopeKey.startsWith('global_')) return settings.monthlyBudget ?? DEFAULT_MONTHLY;
    if (scopeKey.startsWith('project_')) {
      const projectId = scopeKey.slice('project_'.length, scopeKey.lastIndexOf('_'));
      const project = (await t.get(db.doc(paths.project(projectId)))).data();
      return project?.monthlyBudget ?? undefined;
    }
    if (scopeKey.startsWith('task_')) {
      const taskId = scopeKey.slice('task_'.length);
      const task = (await t.get(db.doc(paths.task(taskId)))).data();
      return task?.ai?.budget ?? settings.defaultTaskBudget ?? DEFAULT_TASK;
    }
    throw new Error(`Unknown scope ${scopeKey}`);
  };
}
