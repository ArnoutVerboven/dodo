import type { WorkingHours } from './model.js';

/**
 * Free slots inside working hours, from Calendar free/busy. Time zone math with Intl only:
 * the offset of a zone at an instant comes from `longOffset` (e.g. GMT+02:00).
 */

function offsetMinutes(timeZone: string, at: number): number {
  const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(at))
    .find((p) => p.type === 'timeZoneName')?.value;
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(part ?? '');
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/** Local wall-clock `date` + `hhmm` in `timeZone` → epoch ms (DST-safe to the minute). */
export function zonedTime(date: string, hhmm: string, timeZone: string): number {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = hhmm.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - offsetMinutes(timeZone, guess) * 60_000;
  return guess - offsetMinutes(timeZone, first) * 60_000;
}

/** `YYYY-MM-DD` and ISO weekday (1 = Monday) of an instant in a zone. */
export function localDay(at: number, timeZone: string): { date: string; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(new Date(at));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday')) + 1;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, weekday };
}

export function formatLocal(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(at));
}

export interface Slot {
  start: number;
  end: number;
}

/**
 * Up to `max` slots of `durationMinutes` between `from` and `to`, inside working hours, not
 * overlapping anything busy, starting on the half hour and spread over different days first.
 */
export function freeSlots(opts: {
  from: number;
  to: number;
  durationMinutes: number;
  busy: Slot[];
  hours: WorkingHours;
  timeZone: string;
  max?: number;
}): Slot[] {
  const max = opts.max ?? 6;
  const duration = opts.durationMinutes * 60_000;
  const step = 30 * 60_000;
  const busy = [...opts.busy].sort((a, b) => a.start - b.start);
  const byDay: Slot[][] = [];
  const seen = new Set<string>();
  for (let t = opts.from; t < opts.to && byDay.length < 31; t += 86_400_000) {
    const { date, weekday } = localDay(t, opts.timeZone);
    if (seen.has(date)) continue;
    seen.add(date);
    if (!opts.hours.days.includes(weekday)) continue;
    const dayStart = Math.max(zonedTime(date, opts.hours.start, opts.timeZone), opts.from);
    const dayEnd = Math.min(zonedTime(date, opts.hours.end, opts.timeZone), opts.to);
    const slots: Slot[] = [];
    let s = Math.ceil(dayStart / step) * step;
    while (s + duration <= dayEnd) {
      const e = s + duration;
      const clash = busy.find((b) => b.start < e && b.end > s);
      if (clash) {
        s = Math.ceil(clash.end / step) * step;
        continue;
      }
      slots.push({ start: s, end: e });
      s = e;
    }
    if (slots.length) byDay.push(slots);
  }
  // Round-robin over days, so three proposals are not all on Monday morning.
  const out: Slot[] = [];
  for (let i = 0; out.length < max && byDay.some((d) => d[i]); i++) {
    for (const day of byDay) {
      const slot = day[i];
      if (slot && out.length < max) out.push(slot);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
