import { describe, expect, it } from 'vitest';
import { freeSlots, localDay, zonedTime } from './slots.js';

const hours = { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] };

describe('slots', () => {
  it('converts wall-clock time in a zone, across the DST change', () => {
    // Brussels: UTC+2 in summer time, UTC+1 after 25 Oct 2026.
    expect(new Date(zonedTime('2026-10-23', '09:00', 'Europe/Brussels')).toISOString()).toBe(
      '2026-10-23T07:00:00.000Z',
    );
    expect(new Date(zonedTime('2026-10-27', '09:00', 'Europe/Brussels')).toISOString()).toBe(
      '2026-10-27T08:00:00.000Z',
    );
    expect(localDay(Date.UTC(2026, 9, 26, 23, 30), 'Europe/Brussels')).toEqual({
      date: '2026-10-27',
      weekday: 2,
    });
  });

  it('finds free slots inside working hours, around busy time, spread over days', () => {
    const tz = 'Europe/Brussels';
    const from = zonedTime('2026-10-30', '08:00', tz); // Friday
    const to = zonedTime('2026-11-03', '20:00', tz); // Tuesday
    const busy = [
      { start: zonedTime('2026-10-30', '09:00', tz), end: zonedTime('2026-10-30', '12:15', tz) },
    ];
    const slots = freeSlots({ from, to, durationMinutes: 60, busy, hours, timeZone: tz, max: 3 });
    expect(slots).toHaveLength(3);
    // Friday after the meeting (rounded up to the half hour), then Monday and Tuesday mornings.
    expect(slots[0]?.start).toBe(zonedTime('2026-10-30', '12:30', tz));
    expect(localDay(slots[1]?.start ?? 0, tz).date).toBe('2026-11-02');
    expect(localDay(slots[2]?.start ?? 0, tz).date).toBe('2026-11-03');
    for (const s of slots) expect(busy.some((b) => b.start < s.end && b.end > s.start)).toBe(false);
  });
});
