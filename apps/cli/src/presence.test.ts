import { describe, expect, it } from 'vitest';
import { onBeat, type PresenceWatch, settleWithin } from './presence.js';

const I = 30_000;

/** Beats every interval from `from` with nothing confirmed; what each beat said. */
function unconfirmed(w: PresenceWatch, from: number, beats: number) {
  const out: Array<{ stalled: boolean; reconnect: boolean }> = [];
  for (let k = 1; k <= beats; k++) {
    const r = onBeat(w, from + k * I, I);
    w = r.watch;
    out.push({ stalled: r.stalled, reconnect: r.reconnect });
  }
  return { w, out };
}

describe('onBeat', () => {
  it('stays quiet while heartbeats are confirmed', () => {
    const r = onBeat({ confirmedAt: 0, beatAt: 0 }, I, I);
    expect(r.stalled).toBe(false);
    expect(r.reconnect).toBe(false);
  });

  it('reconnects after two beats without a confirmation, before the web calls it offline', () => {
    const { out } = unconfirmed({ confirmedAt: 0, beatAt: 0 }, 0, 3);
    expect(out.map((o) => o.reconnect)).toEqual([false, true, false]);
  });

  it('calls the connection dead after four beats without a confirmation', () => {
    const { out } = unconfirmed({ confirmedAt: 0, beatAt: 0 }, 0, 5);
    expect(out.map((o) => o.stalled)).toEqual([false, false, false, false, true]);
  });

  it('keeps reconnecting every few beats while it lasts (a run holds off the restart)', () => {
    const { out } = unconfirmed({ confirmedAt: 0, beatAt: 0 }, 0, 12);
    expect(out.flatMap((o, i) => (o.reconnect ? [i + 1] : []))).toEqual([2, 7, 12]);
  });

  it('reconnects again soon after a confirmed heartbeat cleared the last one', () => {
    let { w } = unconfirmed({ confirmedAt: 0, beatAt: 0 }, 0, 2);
    expect(w.reconnectedAt).toBe(2 * I);
    w = { ...w, confirmedAt: 2 * I + 1000, reconnectedAt: undefined };
    const { out } = unconfirmed(w, 2 * I, 3);
    expect(out.map((o) => o.reconnect)).toEqual([false, true, false]);
  });

  it('gives a fresh window after the Mac slept', () => {
    const woke = 3 * 3600_000;
    const r = onBeat({ confirmedAt: 0, beatAt: 0, reconnectedAt: 0 }, woke, I);
    expect(r.stalled).toBe(false);
    expect(r.reconnect).toBe(false);
    expect(r.watch.confirmedAt).toBe(woke);
    expect(r.watch.reconnectedAt).toBeUndefined();
    const { out } = unconfirmed(r.watch, woke, 5);
    expect(out.map((o) => o.reconnect)).toEqual([false, true, false, false, false]);
    expect(out.at(-1)?.stalled).toBe(true);
  });
});

describe('settleWithin', () => {
  it('waits for the promise, swallowing a rejection', async () => {
    await expect(settleWithin(Promise.reject(new Error('x')), 1000)).resolves.toBeUndefined();
  });

  it('gives up on a promise that never settles', async () => {
    const t = Date.now();
    await settleWithin(new Promise(() => {}), 20);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});
