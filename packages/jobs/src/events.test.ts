import type { GenerateResponse } from '@dodo/core';
import { describe, expect, it, vi } from 'vitest';
import { decideThread, type Generate } from './agent.js';
import { calendarEvent, type EventAction, eventId, localIso } from './events.js';
import type { MailThread } from './mail.js';

const NOW = Date.UTC(2026, 9, 27, 10);

const action: EventAction = {
  type: 'jobs.event',
  state: 'pending',
  jobId: 'gmail-followup',
  threadId: 't1',
  title: 'House visit Kerkstraat 12',
  start: '2026-10-29T14:00',
  durationMinutes: 45,
  timeZone: 'Europe/Brussels',
  location: 'Kerkstraat 12',
};

describe('calendar events', () => {
  it('keeps wall-clock times in the zone, also across the DST change', () => {
    expect(calendarEvent(action)).toMatchObject({
      start: '2026-10-29T14:00:00',
      end: '2026-10-29T14:45:00',
      timeZone: 'Europe/Brussels',
      location: 'Kerkstraat 12',
    });
    // 25 Oct 2026: clocks go back at 03:00. 01:30 + 3h of real time is 03:30 local.
    expect(calendarEvent({ ...action, start: '2026-10-25T01:30', durationMinutes: 180 }).end).toBe(
      '2026-10-25T03:30:00',
    );
    expect(localIso(Date.UTC(2026, 11, 31, 23, 30), 'Europe/Brussels')).toBe('2027-01-01T00:30:00');
  });

  it('gives the same thread and start the same Calendar-safe id', () => {
    const id = eventId('j', 't1', '2026-10-29T14:00');
    expect(id).toMatch(/^[0-9a-v]{40}$/);
    expect(eventId('j', 't1', '2026-10-29T14:00')).toBe(id);
    expect(eventId('j', 't1', '2026-10-29T15:00')).not.toBe(id);
  });

  it('drops an event in the past or on a date that does not exist', async () => {
    const thread: MailThread = {
      id: 't1',
      subject: 'Bezoek',
      messages: [
        {
          id: 'm1',
          from: 'jan@immo.be',
          fromEmail: 'jan@immo.be',
          to: 'arnout@example.com',
          subject: 'Bezoek',
          date: NOW - 7_200_000,
          labels: ['INBOX'],
          bulk: false,
          text: 'Prima, tot donderdag om 14u.',
        },
      ],
    };
    const decideWith = async (start: string) => {
      const res: GenerateResponse = {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'decide',
                args: {
                  action: 'create',
                  reason: 'Visit agreed',
                  event: { title: 'Visit', start },
                },
              },
            },
          ],
        },
        usage: { inputTokens: 1, outputTokens: 1, thinkingTokens: 0, cachedInputTokens: 0 },
        cost: 1,
        remaining: 1_000,
      };
      const generate = vi.fn<Generate>().mockResolvedValue(res);
      const { decision } = await decideThread({
        model: 'm',
        me: 'arnout@example.com',
        now: NOW,
        timeZone: 'Europe/Brussels',
        hours: { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] },
        thread,
        draftReplies: true,
        generate,
        busy: async () => [],
        searchTasks: async () => [],
      });
      return decision.event;
    };
    expect(await decideWith('2026-10-29T14:00')).toEqual({
      title: 'Visit',
      start: '2026-10-29T14:00',
      durationMinutes: 60,
    });
    expect(await decideWith('2026-10-20T14:00')).toBeUndefined();
    expect(await decideWith('2027-02-30T14:00')).toBeUndefined();
  });
});
