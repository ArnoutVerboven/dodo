/**
 * Whether the daemon's connection is dead. Firestore queues writes while it is offline instead of
 * failing them, so a daemon whose connection broke (after sleep or a network change) keeps
 * "writing" heartbeats that never arrive, and the Mac shows offline for good. The daemon watches
 * for heartbeats that are not confirmed in time: first it reconnects Firestore in place (which
 * also works while a run is going), and if that does not help it exits, so launchd starts a
 * fresh one.
 */
export interface PresenceWatch {
  /** When the server last confirmed a heartbeat (or when watching started or resumed). */
  confirmedAt: number;
  /** When the previous beat fired. */
  beatAt: number;
  /** When the daemon last reconnected Firestore in place; cleared by a confirmed heartbeat. */
  reconnectedAt?: number;
}

/** Unconfirmed this long: reconnect Firestore in place (again every STALL_BEATS while it lasts). */
export const RECONNECT_BEATS = 1;
/** Unconfirmed this long means the connection is gone. */
export const STALL_BEATS = 4;

/**
 * Called on every beat. A gap of more than two beats since the last one means the Mac slept:
 * the connection gets a fresh window then, instead of being judged on the time asleep.
 */
export function onBeat(
  w: PresenceWatch,
  now: number,
  intervalMs: number,
): { watch: PresenceWatch; stalled: boolean; reconnect: boolean } {
  const slept = now - w.beatAt > 2 * intervalMs;
  const confirmedAt = slept ? now : w.confirmedAt;
  const reconnectedAt = slept ? undefined : w.reconnectedAt;
  const unconfirmed = now - confirmedAt;
  const reconnect =
    unconfirmed > RECONNECT_BEATS * intervalMs &&
    (reconnectedAt === undefined || now - reconnectedAt > STALL_BEATS * intervalMs);
  return {
    watch: { confirmedAt, beatAt: now, reconnectedAt: reconnect ? now : reconnectedAt },
    stalled: unconfirmed > STALL_BEATS * intervalMs,
    reconnect,
  };
}

/** Resolves when `p` settles or after `ms`, whichever comes first; never rejects. */
export function settleWithin(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    p.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}
