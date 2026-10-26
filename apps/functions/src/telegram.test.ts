import { describe, expect, it, vi } from 'vitest';
import { handleTelegramUpdate, notifyTelegram, type TelegramDeps } from './telegram.js';

/** Minimal Firestore double: settings doc and one message doc. */
function fakeDb(settings: Record<string, unknown>, message?: Record<string, unknown>) {
  const docs = new Map<string, Record<string, unknown>>([['settings/global', settings]]);
  if (message) docs.set('tasks/t1/messages/m1', message);
  const db = {
    doc: (path: string) => ({
      get: async () => ({
        exists: docs.has(path),
        data: () => docs.get(path),
        get: (k: string) => docs.get(path)?.[k],
      }),
      set: async (data: Record<string, unknown>) => {
        const cur = docs.get(path) ?? {};
        docs.set(path, deepMerge(cur, data));
      },
      update: async (data: Record<string, unknown>) => {
        const cur = docs.get(path) ?? {};
        for (const [k, v] of Object.entries(data)) {
          const [a, b] = k.split('.');
          if (b) (cur[a as string] as Record<string, unknown>)[b] = v;
          else cur[k] = v;
        }
      },
    }),
  };
  const g = (path: string) => (docs.get(path) ?? {}) as Record<string, unknown>;
  return { db: db as unknown as TelegramDeps['db'], docs, g };
}
function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object'
        ? deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>)
        : v;
  }
  return out;
}

const deps = (db: TelegramDeps['db']): TelegramDeps & { send: ReturnType<typeof vi.fn> } => ({
  db,
  token: 'tok',
  send: vi.fn(async () => ({})),
});

describe('notifyTelegram', () => {
  it('does nothing without a paired chat or token', async () => {
    const { db } = fakeDb({});
    const d = deps(db);
    expect(
      await notifyTelegram(d, { title: 't', body: 'b', taskId: 't1', appUrl: 'https://x' }),
    ).toBe(false);
    expect(
      await notifyTelegram(
        { ...d, token: undefined },
        { title: 't', body: 'b', taskId: 't1', appUrl: 'https://x' },
      ),
    ).toBe(false);
    expect(d.send).not.toHaveBeenCalled();
  });

  it('sends approval cards with Yes / No buttons', async () => {
    const { db } = fakeDb({ telegram: { chatId: 42 } });
    const d = deps(db);
    await notifyTelegram(d, {
      title: 'Needs you',
      body: 'Allow Http(domain:x)?',
      taskId: 't1',
      appUrl: 'https://app',
      input: { messageId: 'm1', kind: 'approval' },
    });
    const [method, body] = d.send.mock.calls[0] as [string, Record<string, unknown>];
    expect(method).toBe('sendMessage');
    expect(body.chat_id).toBe(42);
    expect(JSON.stringify(body.reply_markup)).toContain('a:t1:m1:yes');
  });
});

describe('handleTelegramUpdate', () => {
  it('pairs only with the right code', async () => {
    const { db, g } = fakeDb({ telegram: { pairingCode: 'abc123' } });
    const d = deps(db);
    await handleTelegramUpdate(d, { message: { chat: { id: 7 }, text: '/start wrong' } });
    expect(g('settings/global').telegram).toMatchObject({ pairingCode: 'abc123' });
    await handleTelegramUpdate(d, { message: { chat: { id: 7 }, text: '/start abc123' } });
    expect((g('settings/global').telegram as { chatId: number }).chatId).toBe(7);
  });

  it('ignores strangers and answers input requests from the paired chat', async () => {
    const { db, g } = fakeDb(
      { telegram: { chatId: 7 } },
      { input: { kind: 'approval', prompt: 'ok?' } },
    );
    const d = deps(db);
    await handleTelegramUpdate(d, {
      callback_query: {
        id: 'q1',
        data: 'a:t1:m1:yes',
        message: { chat: { id: 99 }, message_id: 1 },
      },
    });
    expect((g('tasks/t1/messages/m1').input as { answer?: unknown }).answer).toBeUndefined();
    await handleTelegramUpdate(d, {
      callback_query: {
        id: 'q2',
        data: 'a:t1:m1:yes',
        message: { chat: { id: 7 }, message_id: 1 },
      },
    });
    expect((g('tasks/t1/messages/m1').input as { answer: { value: string } }).answer.value).toBe(
      'yes',
    );
    // A second tap does not overwrite.
    await handleTelegramUpdate(d, {
      callback_query: { id: 'q3', data: 'a:t1:m1:no', message: { chat: { id: 7 }, message_id: 1 } },
    });
    expect((g('tasks/t1/messages/m1').input as { answer: { value: string } }).answer.value).toBe(
      'yes',
    );
  });
});
