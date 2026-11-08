/**
 * Whether the daemon's connection is dead. Firestore queues writes while it is offline instead of
 * failing them, so a daemon whose connection broke (after sleep or a network change) keeps
 * "writing" heartbeats that never arrive, and the Mac shows offline for good. The daemon watches
 * for heartbeats that are not confirmed in time and exits, so launchd starts a fresh one.
 */
export interface PresenceWatch {
  /** When the server last confirmed a heartbeat (or when watching started or resumed). */
  confirmedAt: number;
  /** When the previous beat fired. */
  beatAt: number;
}

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
): { watch: PresenceWatch; stalled: boolean } {
  const slept = now - w.beatAt > 2 * intervalMs;
  const confirmedAt = slept ? now : w.confirmedAt;
  return {
    watch: { confirmedAt, beatAt: now },
    stalled: now - confirmedAt > STALL_BEATS * intervalMs,
  };
}
