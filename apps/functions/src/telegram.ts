import { paths } from '@dodo/core';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { esc, markdownToTelegram } from './telegram-format.js';

/**
 * Telegram as a notification channel. One bot, one chat (yours), paired once with a code
 * shown in Settings so that nobody else who finds the bot can bind it. Approval cards get
 * inline Yes / No buttons; tapping one answers the input request exactly as the web app would.
 *
 * Text you send the bot lands in a task's thread. A Telegram reply goes to the task of the message
 * you replied to; a plain message goes to the task of the bot's last message, when that one was
 * about a task. If that message asked a question still waiting for an answer, the text answers
 * it; otherwise it is posted as a comment, which continues the task just as one from the app does.
 */
export interface TelegramDeps {
  db: Firestore;
  token: string | undefined;
  send: (method: string, body: Record<string, unknown>) => Promise<unknown>;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

export interface Notification {
  title: string;
  body: string;
  taskId: string;
  /** Present for input requests: adds answer buttons for approvals and choices. */
  input?: {
    messageId: string;
    kind: 'text' | 'choice' | 'approval';
    options?: string[];
    /** For approvals: the rule "Always" would store; without it there is no Always button. */
    suggestedRule?: string;
  };
  appUrl: string;
}

export function telegramApi(token: string) {
  return async (method: string, body: Record<string, unknown>) => {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json()) as { ok: boolean; description?: string; result?: unknown };
    if (!json.ok) throw new Error(`Telegram ${method}: ${json.description ?? res.status}`);
    return json.result;
  };
}

export async function notifyTelegram(deps: TelegramDeps, n: Notification): Promise<boolean> {
  if (!deps.token) return false;
  const settings = (await deps.db.doc(paths.settings()).get()).data() ?? {};
  const chatId = settings.telegram?.chatId as number | undefined;
  if (!chatId) return false;
  const text = `<b>${esc(n.title)}</b>\n${markdownToTelegram(n.body.slice(0, 3500))}\n<a href="${n.appUrl}/tasks/${n.taskId}">Open task</a>`;
  const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
  if (n.input) {
    const cb = (v: string) => `a:${n.taskId}:${n.input?.messageId}:${v}`.slice(0, 64);
    if (n.input.kind === 'approval')
      buttons.push([
        { text: '✅ Once', callback_data: cb('yes') },
        ...(n.input.suggestedRule ? [{ text: '♾️ Always', callback_data: cb(ALWAYS) }] : []),
        { text: '❌ No', callback_data: cb('no') },
      ]);
    if (n.input.kind === 'choice' && n.input.options) {
      buttons.push(
        n.input.options
          .slice(0, 4)
          .map((o) => ({ text: o.slice(0, 30), callback_data: cb(o.slice(0, 30)) })),
      );
    }
  }
  const about = { taskId: n.taskId, inputMessageId: n.input?.messageId };
  const reply_markup = buttons.length ? { inline_keyboard: buttons } : undefined;
  try {
    try {
      await sendTracked(
        deps,
        { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup },
        about,
      );
    } catch (err) {
      // Telegram rejects HTML it cannot parse; the message still matters more than its looks.
      if (!/parse entities/i.test(String(err))) throw err;
      const plain = `${n.title}\n${n.body.slice(0, 3500)}\n${n.appUrl}/tasks/${n.taskId}`;
      await sendTracked(
        deps,
        { chat_id: chatId, text: plain, disable_web_page_preview: true, reply_markup },
        about,
      );
    }
    return true;
  } catch (err) {
    deps.log?.('telegram send failed', { err: String(err) });
    return false;
  }
}

/** What a bot message in the chat was about, so replies to it can find their task. */
interface SentRef {
  taskId: string;
  /** The input request the message carried, if any. */
  inputMessageId?: string;
}

/** Server-only collection (no client rule matches it): Telegram message → task. */
const sentDoc = (chatId: number, messageId: number) => `telegramMessages/${chatId}_${messageId}`;

/**
 * Sends a message and remembers it: which task it is about (for replies to it) and that it is now
 * the bot's latest message (for plain messages). `about` is null for messages about no task.
 */
async function sendTracked(
  deps: TelegramDeps,
  body: Record<string, unknown> & { chat_id: number },
  about: SentRef | null,
): Promise<void> {
  const result = (await deps.send('sendMessage', body)) as { message_id?: number } | undefined;
  const messageId = result?.message_id;
  if (typeof messageId !== 'number') return;
  try {
    const ref = about ? stripUndef({ ...about }) : null;
    if (ref) {
      await deps.db
        .doc(sentDoc(body.chat_id, messageId))
        .set({ ...ref, chatId: body.chat_id, messageId, createdAt: Date.now() });
    }
    await deps.db.doc(paths.settings()).update({ 'telegram.last': { messageId, ...(ref ?? {}) } });
  } catch (err) {
    deps.log?.('telegram tracking failed', { err: String(err) });
  }
}

const stripUndef = <T extends Record<string, unknown>>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

const ALREADY_EXISTS = 6; // gRPC status code

const HINT =
  'Reply to a task notification to add a comment to that task. A message sent without replying goes to the task of my last message.';

/** The task a replied-to message is about: from the stored mapping, else its "Open task" link. */
async function refForReply(
  deps: TelegramDeps,
  chatId: number,
  reply: NonNullable<TelegramMessage['reply_to_message']>,
): Promise<SentRef | undefined> {
  const stored = (await deps.db.doc(sentDoc(chatId, reply.message_id)).get()).data() as
    | SentRef
    | undefined;
  if (stored?.taskId) return { taskId: stored.taskId, inputMessageId: stored.inputMessageId };
  // Notifications sent before the mapping existed still carry the task link.
  for (const e of reply.entities ?? []) {
    const m = e.url && /\/tasks\/([^/?#]+)/.exec(e.url);
    if (m?.[1]) return { taskId: m[1] };
  }
  return undefined;
}

/** Free text in an input request's terms, as the web app's text box sends it. */
function answerValue(kind: string | undefined, text: string): string {
  if (kind !== 'approval') return text;
  if (/^(y|yes|ok|okay|approve|allow)[.!]?$/i.test(text)) return 'yes';
  if (/^(n|no|deny|nope)[.!]?$/i.test(text)) return 'no';
  return `deny: ${text}`;
}

/** Puts the text in the task's thread: answers the open question it refers to, or comments. */
async function postToTask(
  deps: TelegramDeps,
  chatId: number,
  replyTo: number,
  ref: SentRef,
  text: string,
): Promise<void> {
  const taskRef = deps.db.doc(paths.task(ref.taskId));
  const task = (await taskRef.get()).data() as { title?: string } | undefined;
  if (!task) {
    await sendTracked(
      deps,
      { chat_id: chatId, text: 'That task no longer exists.', reply_to_message_id: replyTo },
      null,
    );
    return;
  }
  const now = Date.now();
  // Telegram redelivers an update it thinks failed: handle each incoming message once.
  try {
    await deps.db.doc(`${sentDoc(chatId, replyTo)}_in`).create({ taskId: ref.taskId, at: now });
  } catch (err) {
    if ((err as { code?: number }).code === ALREADY_EXISTS) return;
    throw err;
  }
  let answered = false;
  if (ref.inputMessageId) {
    const inputRef = deps.db.doc(`${paths.messages(ref.taskId)}/${ref.inputMessageId}`);
    const input = (await inputRef.get()).get('input') as
      | { kind?: string; answer?: unknown }
      | undefined;
    if (input && !input.answer) {
      await inputRef.update({
        'input.answer': {
          value: answerValue(input.kind, text),
          answeredAt: now,
          via: 'telegram',
        },
      });
      answered = true;
    }
  }
  if (!answered) {
    await deps.db
      .doc(`${paths.messages(ref.taskId)}/tg_${chatId}_${replyTo}`)
      .set({ author: 'user', body: text, createdAt: now, via: 'telegram' });
  }
  await taskRef.update({ updatedAt: now });
  const title = esc(task.title || 'Untitled task');
  await sendTracked(
    deps,
    {
      chat_id: chatId,
      text: answered ? `Answered on <b>${title}</b>.` : `Added to <b>${title}</b>.`,
      parse_mode: 'HTML',
      reply_to_message_id: replyTo,
    },
    { taskId: ref.taskId },
  );
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  from?: { username?: string };
  reply_to_message?: {
    message_id: number;
    entities?: Array<{ type: string; url?: string }>;
  };
}

export interface TelegramUpdate {
  message?: TelegramMessage;
  callback_query?: {
    id: string;
    data?: string;
    message?: { chat: { id: number }; message_id: number };
  };
}

/** Handles one webhook update: pairing (`/start CODE`), text for a task, and button taps. */
export async function handleTelegramUpdate(
  deps: TelegramDeps,
  update: TelegramUpdate,
): Promise<void> {
  const settingsRef = deps.db.doc(paths.settings());
  const settings = (await settingsRef.get()).data() ?? {};
  const paired = settings.telegram?.chatId as number | undefined;

  if (update.message?.text) {
    const chatId = update.message.chat.id;
    const m = /^\/start(?:\s+(\S+))?/.exec(update.message.text.trim());
    if (m) {
      const code = m[1];
      const expected = settings.telegram?.pairingCode as string | undefined;
      if (code && expected && code === expected) {
        await settingsRef.set(
          { telegram: { chatId, pairingCode: FieldValue.delete(), pairedAt: Date.now() } },
          { merge: true },
        );
        await sendTracked(
          deps,
          { chat_id: chatId, text: 'Paired. dodo will notify you here.' },
          null,
        );
      } else if (paired === chatId) {
        await sendTracked(deps, { chat_id: chatId, text: 'Already paired.' }, null);
      } else {
        await deps.send('sendMessage', {
          chat_id: chatId,
          text: 'Send /start <code> with the pairing code from dodo Settings.',
        });
      }
      return;
    }
    if (paired !== chatId) return; // strangers get silence
    const text = update.message.text.trim();
    const msgId = update.message.message_id;
    const reply = update.message.reply_to_message;
    const last = settings.telegram?.last as (SentRef & { messageId: number }) | undefined;
    const ref = text.startsWith('/')
      ? undefined
      : reply
        ? await refForReply(deps, chatId, reply)
        : last?.taskId
          ? { taskId: last.taskId, inputMessageId: last.inputMessageId }
          : undefined;
    if (!ref) {
      await sendTracked(
        deps,
        {
          chat_id: chatId,
          text: reply ? `That message isn't about a task. ${HINT}` : HINT,
          reply_to_message_id: msgId,
        },
        null,
      );
      return;
    }
    await postToTask(deps, chatId, msgId, ref, text);
    return;
  }

  const cq = update.callback_query;
  if (cq?.data && cq.message) {
    if (paired !== cq.message.chat.id) {
      await deps.send('answerCallbackQuery', { callback_query_id: cq.id, text: 'Not paired.' });
      return;
    }
    const [kind, taskId, messageId, ...rest] = cq.data.split(':');
    const value = rest.join(':');
    if (kind !== 'a' || !taskId || !messageId || !value) {
      await deps.send('answerCallbackQuery', { callback_query_id: cq.id });
      return;
    }
    const ref = deps.db.doc(`${paths.messages(taskId)}/${messageId}`);
    const snap = await ref.get();
    const input = snap.get('input') as
      | { answer?: unknown; kind?: string; suggestedRule?: string }
      | undefined;
    if (!snap.exists || !input) {
      await deps.send('answerCallbackQuery', {
        callback_query_id: cq.id,
        text: 'This request no longer exists.',
      });
      return;
    }
    if (input.answer) {
      await deps.send('answerCallbackQuery', {
        callback_query_id: cq.id,
        text: 'Already answered.',
      });
      return;
    }
    const always =
      value === ALWAYS && input.kind === 'approval' && input.suggestedRule
        ? { rule: input.suggestedRule, scope: await alwaysScope(deps, taskId, input.suggestedRule) }
        : undefined;
    await ref.update({
      'input.answer': {
        value: always ? 'yes' : value,
        ...(always ? { alwaysAllow: always } : {}),
        answeredAt: Date.now(),
        via: 'telegram',
      },
    });
    await deps.send('answerCallbackQuery', {
      callback_query_id: cq.id,
      text: always ? `Always allowed in this ${always.scope}` : `Answered: ${value}`,
    });
    await deps
      .send('editMessageReplyMarkup', {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        reply_markup: { inline_keyboard: [] },
      })
      .catch(() => {});
  }
}

const ALWAYS = 'always';

/**
 * Where "Always" from Telegram stores the rule: the task's project when it has one (the same
 * default as the app), the task itself otherwise. A vault entry is only ever approved per task.
 */
async function alwaysScope(
  deps: TelegramDeps,
  taskId: string,
  rule: string,
): Promise<'task' | 'project'> {
  if (rule.startsWith('Vault(')) return 'task';
  const task = await deps.db.doc(paths.task(taskId)).get();
  return task.get('projectId') ? 'project' : 'task';
}
