import type { MicroEur } from '@dodo/core';

export type CostCategory = 'tokens' | 'infra' | 'action' | 'purchase';

/** A budget scope. Keys are stable strings so they can be used as document ids. */
export type Scope =
  | { kind: 'total' }
  | { kind: 'global'; month: string }
  | { kind: 'project'; projectId: string; month: string }
  | { kind: 'task'; taskId: string };

export const scopeKey = (s: Scope): string =>
  s.kind === 'total'
    ? 'total'
    : s.kind === 'global'
      ? `global_${s.month}`
      : s.kind === 'project'
        ? `project_${s.projectId}_${s.month}`
        : `task_${s.taskId}`;

/** `2026-10` style month key in UTC. */
export const monthKey = (now: number): string => new Date(now).toISOString().slice(0, 7);

export interface BudgetState {
  /** Cap for this scope. `undefined` means this scope adds no limit of its own. */
  limit: MicroEur | undefined;
  reserved: MicroEur;
  spent: MicroEur;
}

export interface ReservationRecord {
  id: string;
  scopeKeys: string[];
  category: CostCategory;
  amount: MicroEur;
  description: string;
  taskId?: string;
  projectId?: string;
  runId?: string;
  model?: string;
  createdAt: number;
  settled: boolean;
}

export interface LedgerEntry {
  reservationId: string;
  scopeKeys: string[];
  category: CostCategory;
  reserved: MicroEur;
  actual: MicroEur;
  /** Actual cost above the reservation. Should always be 0; non-zero means a pricing bug. */
  overrun: MicroEur;
  description: string;
  taskId?: string;
  projectId?: string;
  runId?: string;
  model?: string;
  createdAt: number;
}

/**
 * Storage for budgets. `transact` must run `fn` atomically: either every write
 * it makes is applied or none are, and concurrent transactions see each other's results.
 */
export interface BudgetStore {
  transact<T>(fn: (tx: BudgetTx) => Promise<T>): Promise<T>;
}

export interface BudgetTx {
  isHalted(): Promise<boolean>;
  getBudget(scopeKey: string): Promise<BudgetState>;
  setBudget(scopeKey: string, state: BudgetState): void;
  getReservation(id: string): Promise<ReservationRecord | undefined>;
  putReservation(r: ReservationRecord): void;
  appendLedger(entry: LedgerEntry): void;
}

export class BudgetExceededError extends Error {
  constructor(
    readonly scopeKey: string,
    readonly requested: MicroEur,
    readonly available: MicroEur,
  ) {
    super(
      `Budget ${scopeKey} exceeded: requested ${requested}, available ${available} (micro-EUR)`,
    );
  }
}

export class HaltedError extends Error {
  constructor() {
    super('Processing is halted (global kill switch). No cost can be reserved.');
  }
}

export interface ReserveRequest {
  scopes: Scope[];
  category: CostCategory;
  amount: MicroEur;
  description: string;
  taskId?: string;
  projectId?: string;
  runId?: string;
  model?: string;
}

export interface Reservation {
  id: string;
  amount: MicroEur;
}

const available = (b: BudgetState): MicroEur =>
  b.limit === undefined ? Number.MAX_SAFE_INTEGER : Math.max(0, b.limit - b.reserved - b.spent);

/**
 * The single gate for every cost-bearing operation: reserve before, settle after.
 * A reservation succeeds only if every scope it touches has room, so no task, project
 * or month can go over its cap, even with parallel runs.
 */
export class CostGate {
  constructor(
    private readonly store: BudgetStore,
    private readonly ids: () => string = () => crypto.randomUUID(),
    private readonly clock: () => number = Date.now,
  ) {}

  /** Room left across all scopes: the smallest remaining amount wins. */
  async available(scopes: Scope[]): Promise<MicroEur> {
    return this.store.transact(async (tx) => {
      if (await tx.isHalted()) return 0;
      let min = Number.MAX_SAFE_INTEGER;
      for (const s of scopes) min = Math.min(min, available(await tx.getBudget(scopeKey(s))));
      return min;
    });
  }

  async reserve(req: ReserveRequest): Promise<Reservation> {
    if (!Number.isInteger(req.amount) || req.amount < 0) {
      throw new Error(`Invalid reservation amount: ${req.amount}`);
    }
    if (req.scopes.length === 0) throw new Error('A reservation needs at least one scope');
    const id = this.ids();
    const keys = req.scopes.map(scopeKey);
    await this.store.transact(async (tx) => {
      if (await tx.isHalted()) throw new HaltedError();
      const states = await Promise.all(keys.map((k) => tx.getBudget(k)));
      states.forEach((b, i) => {
        const room = available(b);
        if (req.amount > room) throw new BudgetExceededError(keys[i] as string, req.amount, room);
      });
      states.forEach((b, i) => {
        tx.setBudget(keys[i] as string, { ...b, reserved: b.reserved + req.amount });
      });
      tx.putReservation({
        id,
        scopeKeys: keys,
        category: req.category,
        amount: req.amount,
        description: req.description,
        taskId: req.taskId,
        projectId: req.projectId,
        runId: req.runId,
        model: req.model,
        createdAt: this.clock(),
        settled: false,
      });
    });
    return { id, amount: req.amount };
  }

  /**
   * Release the reservation and record what was actually spent. Settling twice is a no-op,
   * so it is safe to call from `finally` blocks and retries.
   */
  async settle(reservationId: string, actual: MicroEur): Promise<LedgerEntry | undefined> {
    if (!Number.isInteger(actual) || actual < 0) throw new Error(`Invalid actual cost: ${actual}`);
    return this.store.transact(async (tx) => {
      const r = await tx.getReservation(reservationId);
      if (!r) throw new Error(`Unknown reservation ${reservationId}`);
      if (r.settled) return undefined;
      const states = await Promise.all(r.scopeKeys.map((k) => tx.getBudget(k)));
      states.forEach((b, i) => {
        tx.setBudget(r.scopeKeys[i] as string, {
          ...b,
          reserved: Math.max(0, b.reserved - r.amount),
          spent: b.spent + actual,
        });
      });
      tx.putReservation({ ...r, settled: true });
      const entry: LedgerEntry = {
        reservationId: r.id,
        scopeKeys: r.scopeKeys,
        category: r.category,
        reserved: r.amount,
        actual,
        overrun: Math.max(0, actual - r.amount),
        description: r.description,
        taskId: r.taskId,
        projectId: r.projectId,
        runId: r.runId,
        model: r.model,
        createdAt: this.clock(),
      };
      tx.appendLedger(entry);
      return entry;
    });
  }

  /** Reserve, run, settle. `op` returns its result and the actual cost. */
  async withReservation<T>(
    req: ReserveRequest,
    op: (reservation: Reservation) => Promise<{ result: T; actual: MicroEur }>,
  ): Promise<T> {
    const reservation = await this.reserve(req);
    let actual = reservation.amount; // if op throws, assume the full reservation was spent
    try {
      const out = await op(reservation);
      actual = out.actual;
      return out.result;
    } finally {
      await this.settle(reservation.id, actual);
    }
  }
}
