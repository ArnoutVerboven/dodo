import type {
  BudgetState,
  BudgetStore,
  BudgetTx,
  LedgerEntry,
  ReservationRecord,
} from './cost-gate.js';

/** In-memory BudgetStore for tests and local dry runs. Transactions are serialised. */
export class MemoryBudgetStore implements BudgetStore {
  halted = false;
  budgets = new Map<string, BudgetState>();
  reservations = new Map<string, ReservationRecord>();
  ledger: LedgerEntry[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly limits: (scopeKey: string) => number | undefined = () => undefined) {}

  transact<T>(fn: (tx: BudgetTx) => Promise<T>): Promise<T> {
    const run = async () => {
      const budgets = new Map<string, BudgetState>();
      const reservations = new Map<string, ReservationRecord>();
      const ledger: LedgerEntry[] = [];
      const tx: BudgetTx = {
        isHalted: async () => this.halted,
        getBudget: async (k) =>
          budgets.get(k) ??
          this.budgets.get(k) ?? { limit: this.limits(k), reserved: 0, spent: 0 },
        setBudget: (k, s) => void budgets.set(k, s),
        getReservation: async (id) => reservations.get(id) ?? this.reservations.get(id),
        putReservation: (r) => void reservations.set(r.id, r),
        appendLedger: (e) => void ledger.push(e),
      };
      const result = await fn(tx);
      for (const [k, v] of budgets) this.budgets.set(k, v);
      for (const [k, v] of reservations) this.reservations.set(k, v);
      this.ledger.push(...ledger);
      return result;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
