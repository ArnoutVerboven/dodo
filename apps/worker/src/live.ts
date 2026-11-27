import type { LiveAction, LiveFrame } from '@dodo/browser-engine';
import { LIVE_MAX_FPS, LiveControl, LiveInput, type LiveView, paths, Run } from '@dodo/core';
import {
  Bytes,
  collection,
  deleteDoc,
  doc,
  type Firestore,
  onSnapshot,
  orderBy,
  query,
  setDoc,
} from 'firebase/firestore';

/**
 * Live takeover of the cloud browser, relayed through Firestore. The view runs only while the
 * run holds its browser for an answer (`Run.awaiting`) and the owner has it open
 * (`live/control.want`): frames go to `live/view`, at most LIVE_MAX_FPS a second, and the
 * owner's clicks and typing come back from `liveInput` and are replayed on the page. The agent
 * is waiting on its question meanwhile, so the two never act on the page at once.
 */

/** The screen to show: LiveScreen over the bridge, in the worker. */
export interface LiveSource {
  start(onFrame: (f: LiveFrame) => void): Promise<void>;
  input(a: LiveAction): Promise<void>;
  stop(): Promise<void>;
}

/** Where the view meets the app; Firestore in the worker, a fake in tests. */
export interface LiveStore {
  onHeld(cb: (held: boolean) => void): () => void;
  onWant(cb: (want: boolean) => void): () => void;
  /** New input, oldest first; `initial` marks what was there before the view started. */
  onInput(cb: (items: Array<{ id: string; data: unknown }>, initial: boolean) => void): () => void;
  putView(view: LiveView, jpeg?: Uint8Array): Promise<void>;
  deleteInput(id: string): Promise<void>;
}

export class LiveRelay {
  private held = false;
  private want = false;
  private running = false;
  private busy: Promise<void> = Promise.resolve();
  private subs: Array<() => void> = [];
  private stopInput?: () => void;
  private latest?: LiveFrame;
  private writing = false;
  private lastWrite = 0;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private inputs: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly store: LiveStore,
    private readonly source: LiveSource,
    private readonly opts: { log?: (m: string) => void; now?: () => number } = {},
  ) {}

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  /**
   * Starts listening for the owner; the view itself starts only when both conditions hold.
   * The first, empty view tells the app this run's page can be taken over.
   */
  listen(): void {
    void this.store
      .putView({ active: false, width: 0, height: 0, seq: 0, at: this.now() })
      .catch((err: Error) => this.opts.log?.(`live view: not offered: ${err.message}`));
    this.subs.push(
      this.store.onHeld((held) => {
        this.held = held;
        this.reconcile();
      }),
      this.store.onWant((want) => {
        this.want = want;
        this.reconcile();
      }),
    );
  }

  /** Stops everything at the end of the run. */
  async close(): Promise<void> {
    this.closed = true;
    for (const u of this.subs) u();
    this.subs = [];
    this.reconcile();
    await this.busy;
  }

  /** Settles once the view has caught up with the latest state (tests). */
  idle(): Promise<void> {
    return this.busy;
  }

  private reconcile(): void {
    this.busy = this.busy.then(async () => {
      const should = !this.closed && this.held && this.want;
      if (should && !this.running) await this.begin();
      else if (!should && this.running) await this.end(this.held ? undefined : 'answered');
    });
  }

  private async begin(): Promise<void> {
    try {
      this.running = true;
      await this.source.start((f) => this.frame(f));
      this.stopInput = this.store.onInput((items, initial) => this.input(items, initial));
      this.opts.log?.('live view: on');
    } catch (err) {
      this.running = false;
      const note = `The page could not be shown: ${(err as Error).message}`;
      this.opts.log?.(`live view: ${note}`);
      await this.store.putView({
        active: false,
        width: 0,
        height: 0,
        seq: 0,
        note,
        at: this.now(),
      });
    }
  }

  private async end(why?: 'answered'): Promise<void> {
    this.running = false;
    this.stopInput?.();
    this.stopInput = undefined;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.latest = undefined;
    await this.inputs.catch(() => undefined);
    await this.source.stop().catch(() => undefined);
    const note =
      why === 'answered'
        ? 'The agent has the page again.'
        : this.closed
          ? 'The run ended.'
          : undefined;
    await this.store
      .putView({ active: false, width: 0, height: 0, seq: 0, note, at: this.now() })
      .catch(() => undefined);
    this.opts.log?.('live view: off');
  }

  private frame(f: LiveFrame): void {
    if (!this.running) return;
    this.latest = f;
    this.flush();
  }

  /** Writes the newest frame, no more often than LIVE_MAX_FPS; a skipped frame waits its turn. */
  private flush(): void {
    if (this.writing || this.flushTimer || !this.latest) return;
    const wait = this.lastWrite + 1000 / LIVE_MAX_FPS - this.now();
    if (wait > 0) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        this.flush();
      }, wait);
      return;
    }
    const f = this.latest;
    this.latest = undefined;
    this.writing = true;
    this.lastWrite = this.now();
    this.store
      .putView(
        { active: true, width: f.width, height: f.height, seq: f.seq, url: f.url, at: this.now() },
        f.jpeg,
      )
      .catch((err: Error) => this.opts.log?.(`live view: frame not sent: ${err.message}`))
      .finally(() => {
        this.writing = false;
        if (this.running) this.flush();
      });
  }

  private input(items: Array<{ id: string; data: unknown }>, initial: boolean): void {
    for (const item of items) {
      this.inputs = this.inputs.then(async () => {
        await this.store.deleteInput(item.id).catch(() => undefined);
        // Clicks from before the view started (a stale tab) are dropped, not replayed.
        if (initial || !this.running) return;
        const parsed = LiveInput.safeParse(item.data);
        if (!parsed.success) return;
        const { at: _at, ...action } = parsed.data;
        await this.source
          .input(action as LiveAction)
          .catch((err: Error) => this.opts.log?.(`live view: input failed: ${err.message}`));
      });
    }
  }
}

/** The relay's store on Firestore, with the run's own identity (see firestore.rules). */
export function firestoreLiveStore(db: Firestore, runId: string): LiveStore {
  return {
    onHeld: (cb) =>
      onSnapshot(
        doc(db, paths.run(runId)),
        // Only the hold matters here; the rest of the run document is the control plane's.
        (snap) => cb(Run.shape.awaiting.safeParse(snap.data()?.awaiting).data !== undefined),
        () => cb(false),
      ),
    onWant: (cb) =>
      onSnapshot(
        doc(db, paths.runLiveControl(runId)),
        (snap) => {
          const c = LiveControl.safeParse(snap.data());
          cb(c.success && c.data.want);
        },
        () => cb(false),
      ),
    onInput: (cb) => {
      let first = true;
      return onSnapshot(
        query(collection(db, paths.runLiveInput(runId)), orderBy('at', 'asc')),
        (snap) => {
          const added = snap
            .docChanges()
            .filter((c) => c.type === 'added')
            .map((c) => ({ id: c.doc.id, data: c.doc.data() }));
          const initial = first;
          first = false;
          if (added.length) cb(added, initial);
        },
        () => undefined,
      );
    },
    putView: (view, jpeg) =>
      setDoc(doc(db, paths.runLiveView(runId)), {
        ...Object.fromEntries(Object.entries(view).filter(([, v]) => v !== undefined)),
        jpeg: jpeg ? Bytes.fromUint8Array(jpeg) : null,
      }),
    deleteInput: (id) => deleteDoc(doc(db, paths.runLiveInput(runId), id)),
  };
}
