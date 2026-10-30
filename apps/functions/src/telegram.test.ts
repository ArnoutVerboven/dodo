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
      create: async (data: Record<string, unknown>) => {
        if (docs.has(path)) throw Object.assign(new Error('exists'), { code: 6 });
        docs.set(path, data);
      },
      update: async (data: Record<string, unknown>) => {
        const cur = docs.get(path) ?? {};
        for (const [k, v] of Object.entries(data)) {
          const [a, b] = k.split('.');
          if (b) {
            cur[a as string] ??= {};
            (cur[a as string] as Record<string, unknown>)[b] = v;
          } else cur[k] = v;
        }
        docs.set(path, cur);
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

const deps = (db: TelegramDeps['db']): TelegramDeps & { send: ReturnType<typeof vi.fn> } => {
  let next = 100;
  return {
    db,
    token: 'tok',
    // Telegram returns the sent message; ids count up from 100.
    send: vi.fn(async (method: string) => (method === 'sendMessage' ? { message_id: next++ } : {})),
  };
};

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

  it('skips kinds muted in Settings and sends the rest', async () => {
    const { db } = fakeDb({ telegram: { chatId: 42, muted: ['done', 'job_task'] } });
    const d = deps(db);
    const base = { title: 't', body: 'b', taskId: 't1', appUrl: 'https://x' };
    expect(await notifyTelegram(d, { ...base, kind: 'done' })).toBe(false);
    expect(await notifyTelegram(d, { ...base, kind: 'job_task' })).toBe(false);
    expect(d.send).not.toHaveBeenCalled();
    expect(await notifyTelegram(d, { ...base, kind: 'blocked' })).toBe(true);
    expect(await notifyTelegram(d, base)).toBe(true);
    expect(d.send).toHaveBeenCalledTimes(2);
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
    expect(JSON.stringify(body.reply_markup)).not.toContain('a:t1:m1:always');
  });

  it('adds an Always button when the approval has a rule to store', async () => {
    const { db } = fakeDb({ telegram: { chatId: 42 } });
    const d = deps(db);
    await notifyTelegram(d, {
      title: 'Needs you',
      body: 'Allow Browser(navigate:x.com)?',
      taskId: 't1',
      appUrl: 'https://app',
      input: { messageId: 'm1', kind: 'approval', suggestedRule: 'Browser(navigate:x.com)' },
    });
    const body = (d.send.mock.calls[0] as [string, Record<string, unknown>])[1];
    expect(JSON.stringify(body.reply_markup)).toContain('a:t1:m1:always');
  });
});

describe('Always from Telegram', () => {
  const press = (d: ReturnType<typeof deps>) =>
    handleTelegramUpdate(d, {
      callback_query: {
        id: 'q',
        data: 'a:t1:m1:always',
        message: { chat: { id: 7 }, message_id: 1 },
      },
    });
  const answer = (g: (p: string) => Record<string, unknown>) =>
    (g('tasks/t1/messages/m1').input as { answer: Record<string, unknown> }).answer;

  it("stores the rule on the task's project", async () => {
    const { db, g, docs } = fakeDb(
      { telegram: { chatId: 7 } },
      { input: { kind: 'approval', prompt: 'ok?', suggestedRule: 'Browser(navigate:x.com)' } },
    );
    docs.set('tasks/t1', { projectId: 'p1' });
    await press(deps(db));
    expect(answer(g)).toMatchObject({
      value: 'yes',
      alwaysAllow: { rule: 'Browser(navigate:x.com)', scope: 'project' },
    });
  });

  it('stores it on the task when there is no project, and always for a vault entry', async () => {
    const { db, g, docs } = fakeDb(
      { telegram: { chatId: 7 } },
      { input: { kind: 'approval', prompt: 'ok?', suggestedRule: 'Vault(v1)' } },
    );
    docs.set('tasks/t1', { projectId: 'p1' });
    await press(deps(db));
    expect(answer(g)).toMatchObject({ alwaysAllow: { scope: 'task' } });
  });
});

describe('notifyTelegram with a picture', () => {
  it('sends the photo before the question, and a reply to the photo finds the question', async () => {
    const { db, g } = fakeDb({ telegram: { chatId: 42 } });
    const d = deps(db);
    const forms: Array<[string, FormData]> = [];
    d.upload = vi.fn(async (method: string, form: FormData) => {
      forms.push([method, form]);
      return { message_id: 99 };
    });
    await notifyTelegram(d, {
      title: 'Needs you: Engie bill',
      body: 'Scan the QR code with itsme',
      taskId: 't1',
      appUrl: 'https://app',
      input: { messageId: 'm1', kind: 'text' },
      image: { data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), mimeType: 'image/png' },
    });
    expect(forms).toHaveLength(1);
    const [method, form] = forms[0] as [string, FormData];
    expect(method).toBe('sendPhoto');
    expect(form.get('chat_id')).toBe('42');
    expect(form.get('caption')).toBe('Needs you: Engie bill');
    const photo = form.get('photo') as File;
    expect(photo.type).toBe('image/png');
    expect(photo.size).toBe(4);
    // The text with the question still follows, as before.
    expect(d.send.mock.calls[0]?.[0]).toBe('sendMessage');
    expect(g('telegramMessages/42_99')).toMatchObject({ taskId: 't1', inputMessageId: 'm1' });
  });

  it('still sends the question when the photo fails', async () => {
    const { db } = fakeDb({ telegram: { chatId: 42 } });
    const d = deps(db);
    d.upload = vi.fn(async () => {
      throw new Error('Telegram sendPhoto: Bad Request: PHOTO_INVALID_DIMENSIONS');
    });
    expect(
      await notifyTelegram(d, {
        title: 'T',
        body: 'b',
        taskId: 't1',
        appUrl: 'https://app',
        image: { data: Buffer.from([1]), mimeType: 'image/png' },
      }),
    ).toBe(true);
    expect(d.send).toHaveBeenCalledTimes(1);
  });
});

describe('notifyTelegram formatting', () => {
  it('renders Markdown as Telegram HTML', async () => {
    const { db } = fakeDb({ telegram: { chatId: 42 } });
    const d = deps(db);
    await notifyTelegram(d, {
      title: 'Needs you: <x>',
      body: 'Pick one:\n- **Option A**\n- Option B',
      taskId: 't1',
      appUrl: 'https://app',
    });
    const body = (d.send.mock.calls[0] as [string, { text: string }])[1];
    expect(body.text).toBe(
      '<b>Needs you: &lt;x&gt;</b>\nPick one:\n• <b>Option A</b>\n• Option B\n<a href="https://app/tasks/t1">Open task</a>',
    );
  });

  it('falls back to plain text when Telegram rejects the HTML', async () => {
    const { db } = fakeDb({ telegram: { chatId: 42 } });
    const d = deps(db);
    d.send.mockRejectedValueOnce(
      new Error("Telegram sendMessage: Bad Request: can't parse entities"),
    );
    expect(
      await notifyTelegram(d, { title: 'T', body: '**b**', taskId: 't1', appUrl: 'https://app' }),
    ).toBe(true);
    const body = (d.send.mock.calls[1] as [string, Record<string, unknown>])[1];
    expect(body.parse_mode).toBeUndefined();
    expect(body.text).toBe('T\n**b**\nhttps://app/tasks/t1');
  });
});

describe('handleTelegramUpdate', () => {
  it('pairs only with the right code', async () => {
    const { db, g } = fakeDb({ telegram: { pairingCode: 'abc123' } });
    const d = deps(db);
    await handleTelegramUpdate(d, {
      message: { message_id: 1, chat: { id: 7 }, text: '/start wrong' },
    });
    expect(g('settings/global').telegram).toMatchObject({ pairingCode: 'abc123' });
    await handleTelegramUpdate(d, {
      message: { message_id: 2, chat: { id: 7 }, text: '/start abc123' },
    });
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

  describe('text messages', () => {
    const msg = (text: string, id: number, replyTo?: number, url?: string) => ({
      message: {
        message_id: id,
        chat: { id: 7 },
        text,
        reply_to_message:
          replyTo === undefined
            ? undefined
            : { message_id: replyTo, entities: url ? [{ type: 'text_link', url }] : undefined },
      },
    });
    const notify = (d: TelegramDeps, taskId: string, input?: { messageId: string }) =>
      notifyTelegram(d, {
        title: 'Done',
        body: 'b',
        taskId,
        appUrl: 'https://app',
        input: input && { ...input, kind: 'text' },
      });
    const setup = () => {
      const f = fakeDb({ telegram: { chatId: 7 } });
      f.docs.set('tasks/t1', { title: 'Write <report>' });
      f.docs.set('tasks/t2', { title: 'Other' });
      return { ...f, d: deps(f.db) };
    };
    const lastText = (d: ReturnType<typeof deps>) =>
      (d.send.mock.calls.at(-1) as [string, { text: string }])[1].text;

    it('posts a reply to a notification as a comment on its task', async () => {
      const { d, g, docs } = setup();
      await notify(d, 't1'); // message 100
      await notify(d, 't2'); // message 101
      await handleTelegramUpdate(d, msg('looks good', 5, 100));
      expect(g('tasks/t1/messages/tg_7_5')).toMatchObject({
        author: 'user',
        body: 'looks good',
        via: 'telegram',
      });
      expect(docs.has('tasks/t2/messages/tg_7_5')).toBe(false);
      expect(lastText(d)).toBe('Added to <b>Write &lt;report&gt;</b>.');
    });

    it('sends a bare message to the task of the last bot message', async () => {
      const { d, g } = setup();
      await notify(d, 't1');
      await notify(d, 't2');
      await handleTelegramUpdate(d, msg('and this', 6));
      expect(g('tasks/t2/messages/tg_7_6').body).toBe('and this');
      // The confirmation is about t2 too, so the next bare message follows it.
      await handleTelegramUpdate(d, msg('one more', 7));
      expect(g('tasks/t2/messages/tg_7_7').body).toBe('one more');
    });

    it('answers an open question instead of commenting', async () => {
      const { d, g, docs } = setup();
      docs.set('tasks/t1/messages/m1', { input: { kind: 'text', prompt: 'Which file?' } });
      await notify(d, 't1', { messageId: 'm1' });
      await handleTelegramUpdate(d, msg('notes.md', 8));
      const input = g('tasks/t1/messages/m1').input as { answer: { value: string; via: string } };
      expect(input.answer).toMatchObject({ value: 'notes.md', via: 'telegram' });
      expect(docs.has('tasks/t1/messages/tg_7_8')).toBe(false);
      expect(lastText(d)).toContain('Answered on');
      // Once answered, the next message is a plain comment.
      await handleTelegramUpdate(d, msg('thanks', 9));
      expect(g('tasks/t1/messages/tg_7_9').body).toBe('thanks');
    });

    it('maps yes / no onto approvals and anything else to a denial with a reason', async () => {
      const { d, g, docs } = setup();
      docs.set('tasks/t1/messages/m1', { input: { kind: 'approval', prompt: 'Allow?' } });
      await notify(d, 't1', { messageId: 'm1' });
      await handleTelegramUpdate(d, msg('Yes', 10, 100));
      expect((g('tasks/t1/messages/m1').input as { answer: { value: string } }).answer.value).toBe(
        'yes',
      );
      docs.set('tasks/t1/messages/m2', { input: { kind: 'approval', prompt: 'Allow?' } });
      await notify(d, 't1', { messageId: 'm2' });
      await handleTelegramUpdate(d, msg('use the staging bucket', 11));
      expect((g('tasks/t1/messages/m2').input as { answer: { value: string } }).answer.value).toBe(
        'deny: use the staging bucket',
      );
    });

    it('falls back to the task link for notifications sent before tracking', async () => {
      const { d, g } = setup();
      await handleTelegramUpdate(d, msg('old one', 12, 3, 'https://app/tasks/t2'));
      expect(g('tasks/t2/messages/tg_7_12').body).toBe('old one');
    });

    it('hints when the last bot message was not about a task', async () => {
      const { d, docs } = setup();
      await handleTelegramUpdate(d, msg('hello', 13));
      expect(lastText(d)).toContain('Reply to a task notification');
      await notify(d, 't1');
      await handleTelegramUpdate(d, msg('/help', 14)); // the hint is the latest message now
      await handleTelegramUpdate(d, msg('hello again', 15));
      expect([...docs.keys()].some((k) => k.includes('/messages/tg_'))).toBe(false);
      await handleTelegramUpdate(d, msg('reply to hint', 16, 103));
      expect(lastText(d)).toContain("isn't about a task");
    });

    it('does not post twice when Telegram redelivers an update', async () => {
      const { d, docs } = setup();
      docs.set('tasks/t1/messages/m1', { input: { kind: 'text', prompt: 'Which file?' } });
      await notify(d, 't1', { messageId: 'm1' });
      await handleTelegramUpdate(d, msg('once', 17));
      const sent = d.send.mock.calls.length;
      await handleTelegramUpdate(d, msg('once', 17));
      expect(d.send.mock.calls.length).toBe(sent);
      // The first delivery answered the question; the second must not also comment.
      expect(docs.has('tasks/t1/messages/tg_7_17')).toBe(false);
    });

    it('ignores strangers', async () => {
      const { d, docs } = setup();
      await notify(d, 't1');
      const sent = d.send.mock.calls.length;
      await handleTelegramUpdate(d, {
        message: {
          message_id: 18,
          chat: { id: 99 },
          text: 'hi',
          reply_to_message: { message_id: 100 },
        },
      });
      expect(d.send.mock.calls.length).toBe(sent);
      expect([...docs.keys()].some((k) => k.includes('tg_'))).toBe(false);
    });
  });
});
