import { describe, expect, it, vi } from 'vitest';
import { notifyPush, type PushDeps, type PushMessage } from './push.js';

function fakeDb(tokens: string[]) {
  const live = new Set(tokens);
  const db = {
    collection: () => ({ get: async () => ({ docs: [...live].map((id) => ({ id })) }) }),
    doc: (path: string) => ({
      delete: async () => {
        live.delete(path.replace('pushTokens/', ''));
      },
    }),
  };
  return { db: db as unknown as PushDeps['db'], live };
}

const base = { title: 'Needs you: pay bill', body: 'Approve?', taskId: 't1', appUrl: 'https://x' };

describe('notifyPush', () => {
  it('does nothing without registered browsers', async () => {
    const { db } = fakeDb([]);
    const send = vi.fn();
    expect(await notifyPush({ db, send }, base)).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends a data message with the task link to every browser', async () => {
    const { db } = fakeDb(['a', 'b']);
    let sent: PushMessage[] = [];
    const send = vi.fn(async (m: PushMessage[]) => {
      sent = m;
      return m.map(() => ({ success: true }));
    });
    const n = await notifyPush(
      { db, send },
      { ...base, input: { messageId: 'm1', kind: 'approval' } },
    );
    expect(n).toBe(2);
    expect(sent.map((m) => m.token)).toEqual(['a', 'b']);
    expect(sent[0]?.data).toMatchObject({
      title: 'Needs you: pay bill',
      url: 'https://x/tasks/t1',
      tag: 'task-t1',
      kind: 'approval',
    });
    expect(sent[0]?.webpush.headers.Urgency).toBe('high');
  });

  it('drops tokens the push service no longer knows, keeps the rest', async () => {
    const { db, live } = fakeDb(['gone', 'flaky', 'ok']);
    const log = vi.fn();
    const send = async () => [
      { success: false, error: { code: 'messaging/registration-token-not-registered' } },
      { success: false, error: { code: 'messaging/internal-error' } },
      { success: true },
    ];
    expect(await notifyPush({ db, send, log }, base)).toBe(1);
    expect([...live]).toEqual(['flaky', 'ok']);
    expect(log).toHaveBeenCalledWith('push failed', { code: 'messaging/internal-error' });
  });

  it('swallows a failed send so Telegram still goes out', async () => {
    const { db } = fakeDb(['a']);
    const send = async () => {
      throw new Error('network');
    };
    expect(await notifyPush({ db, send }, base)).toBe(0);
  });
});
