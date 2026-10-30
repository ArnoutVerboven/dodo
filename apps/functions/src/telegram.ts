import { type NotificationKind, paths } from '@dodo/core';
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
 * The bot reacts on your message instead of replying: 👀 once the agent has it, 👍 once the agent
 * is through with it (its run ended or asked the next question). A secret code gets neither: the
 * bot deletes that message.
 */
export interface TelegramDeps {
  db: Firestore;
  token: string | undefined;
  send: (method: string, body: Record<string, unknown>) => Promise<unknown>;
  /** Multipart calls, for photos. Absent: pictures are left out and the text goes alone. */
  upload?: (method: string, form: FormData) => Promise<unknown>;
  /** Where a reply to a secret question (an MFA code) goes; absent: answer those in the app. */
  saveSecret?: (req: {
    taskId: string;
    messageId: string;
    value: string;
    via: 'telegram';
  }) => Promise<unknown>;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

export interface Notification {
  /** Muted kinds (Settings › Telegram) are not sent there. Absent: always sent. */
  kind?: NotificationKind;
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
    /** The answer is a code: ask for it as a reply, and keep it out of the chat. */
    secret?: boolean;
  };
  /** Sent as a photo before the text: a QR code to scan, the icon to pick, a code to read. */
  image?: { data: Buffer; mimeType: string };
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

/** Multipart Bot API calls (sendPhoto); same error handling as telegramApi. */
export function telegramUpload(token: string) {
  return async (method: string, form: FormData) => {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await res.json()) as { ok: boolean; description?: string; result?: unknown };
    if (!json.ok) throw new Error(`Telegram ${method}: ${json.description ?? res.status}`);
    return json.result;
  };
}

/**
 * The question's picture, sent just before its text. Tracked like the text, so replying to the
 * photo answers the question too. Fails quietly: the text still carries the question.
 */
async function sendPhoto(
  deps: TelegramDeps,
  chatId: number,
  image: NonNullable<Notification['image']>,
  caption: string,
  about: SentRef,
): Promise<void> {
  if (!deps.upload) return;
  const form = new FormData();
  form.set('chat_id', String(chatId));
  form.set('caption', caption.slice(0, 1000));
  const ext = image.mimeType.split('/')[1] ?? 'png';
  form.set(
    'photo',
    new Blob([new Uint8Array(image.data)], { type: image.mimeType }),
    `screenshot.${ext}`,
  );
  try {
    const result = (await deps.upload('sendPhoto', form)) as { message_id?: number } | undefined;
    await track(deps, chatId, result?.message_id, about);
  } catch (err) {
    deps.log?.('telegram photo failed', { err: String(err) });
  }
}

export async function notifyTelegram(deps: TelegramDeps, n: Notification): Promise<boolean> {
  if (!deps.token) return false;
  const settings = (await deps.db.doc(paths.settings()).get()).data() ?? {};
  const chatId = settings.telegram?.chatId as number | undefined;
  if (!chatId) return false;
  const muted = (settings.telegram?.muted as NotificationKind[] | undefined) ?? [];
  if (n.kind && muted.includes(n.kind)) return false;
  const secretHint = n.input?.secret
    ? '\n<i>Reply to this message with the code. It goes straight to the browser, and the agent never sees it; I delete your message once it is stored.</i>'
    : '';
  const text = `<b>${esc(n.title)}</b>\n${markdownToTelegram(n.body.slice(0, 3500))}${secretHint}\n<a href="${n.appUrl}/tasks/${n.taskId}">Open task</a>`;
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
  // Photo first, then the question with its buttons: the buttons stay on the latest message.
  if (n.image) await sendPhoto(deps, chatId, n.image, n.title, about);
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
  await track(deps, body.chat_id, result?.message_id, about);
}

/** Remembers a sent message: its task (for replies to it) and that it is the bot's latest. */
async function track(
  deps: TelegramDeps,
  chatId: number,
  messageId: number | undefined,
  about: SentRef | null,
): Promise<void> {
  if (typeof messageId !== 'number') return;
  try {
    const ref = about ? stripUndef({ ...about }) : null;
    if (ref) {
      await deps.db
        .doc(sentDoc(chatId, messageId))
        .set({ ...ref, chatId, messageId, createdAt: Date.now() });
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
  const task = (await taskRef.get()).data() as
    | { title?: string; status?: string; ai?: { enabled?: boolean } }
    | undefined;
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
  let input: { kind?: string; answer?: unknown; secret?: boolean } | undefined;
  const inputRef = ref.inputMessageId
    ? deps.db.doc(`${paths.messages(ref.taskId)}/${ref.inputMessageId}`)
    : undefined;
  if (inputRef) {
    input = (await inputRef.get()).get('input') as typeof input;
    if (input?.secret && !input.answer) {
      await answerSecretFromChat(deps, chatId, replyTo, ref, task.title, text);
      return;
    }
  }
  // Only an AI task that is still open gets a run to process the text; for any other the text
  // is simply stored, which is all there is to do.
  const willRun = !!task.ai?.enabled && task.status !== 'done' && task.status !== 'cancelled';
  // Remembered before the text lands, so a run that ends quickly still finds it (see ackTelegram).
  if (willRun) {
    await deps.db.doc(pendingDoc(ref.taskId)).set(
      { messages: { [`${chatId}_${replyTo}`]: { chatId, messageId: replyTo, at: now } } },
      {
        merge: true,
      },
    );
  }
  if (inputRef && input && !input.answer) {
    await inputRef.update({
      'input.answer': {
        value: answerValue(input.kind, text),
        answeredAt: now,
        via: 'telegram',
      },
    });
  } else {
    await deps.db
      .doc(`${paths.messages(ref.taskId)}/tg_${chatId}_${replyTo}`)
      .set({ author: 'user', body: text, createdAt: now, via: 'telegram' });
  }
  await taskRef.update({ updatedAt: now });
  // 👀: received and handed to the agent; 👍 follows when its run is through (ackTelegram).
  await react(deps, chatId, replyTo, willRun ? EYES : THUMBS_UP);
}

const EYES = '👀';
const THUMBS_UP = '👍';

/** Server-only: the Telegram messages a task's agent has not finished processing yet. */
const pendingDoc = (taskId: string) => `telegramPending/${taskId}`;

/** Sets the bot's reaction on a message (replacing any earlier one). Never throws. */
async function react(deps: TelegramDeps, chatId: number, messageId: number, emoji: string) {
  try {
    await deps.send('setMessageReaction', {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: 'emoji', emoji }],
    });
  } catch (err) {
    deps.log?.('telegram reaction failed', { err: String(err) });
  }
}

/**
 * The agent is through with the task's Telegram messages: its run ended or asked the next
 * question. Each message it got from Telegram trades its 👀 for a 👍. Never throws.
 */
export async function ackTelegram(deps: TelegramDeps, taskId: string): Promise<void> {
  if (!deps.token) return;
  try {
    const ref = deps.db.doc(pendingDoc(taskId));
    const pending = (await ref.get()).data()?.messages as
      | Record<string, { chatId: number; messageId: number }>
      | undefined;
    const entries = Object.entries(pending ?? {});
    if (!entries.length) return;
    // Only the entries read here: one that lands meanwhile waits for the run it starts.
    await ref.update(
      Object.fromEntries(entries.map(([k]) => [`messages.${k}`, FieldValue.delete()])),
    );
    for (const [, m] of entries) await react(deps, m.chatId, m.messageId, THUMBS_UP);
  } catch (err) {
    deps.log?.('telegram ack failed', { taskId, err: String(err) });
  }
}

/**
 * A code sent as the answer to a secret question: stored apart (never in the thread), and the
 * user's message with the code is deleted from the chat. The confirmation never repeats it.
 */
async function answerSecretFromChat(
  deps: TelegramDeps,
  chatId: number,
  userMessageId: number,
  ref: SentRef,
  title: string | undefined,
  text: string,
): Promise<void> {
  const name = esc(title || 'Untitled task');
  if (!deps.saveSecret || !ref.inputMessageId) {
    await sendTracked(
      deps,
      {
        chat_id: chatId,
        text: `This code can only be answered in the app for now: <b>${name}</b>.`,
        parse_mode: 'HTML',
      },
      { taskId: ref.taskId },
    );
    return;
  }
  let reply: string;
  try {
    await deps.saveSecret({
      taskId: ref.taskId,
      messageId: ref.inputMessageId,
      value: text,
      via: 'telegram',
    });
    await deps.db.doc(paths.task(ref.taskId)).update({ updatedAt: Date.now() });
    reply = `Code sent to the browser for <b>${name}</b>.`;
  } catch (err) {
    deps.log?.('telegram secret answer failed', { taskId: ref.taskId, err: String(err) });
    reply = `Could not store the code for <b>${name}</b>; answer in the app.`;
  }
  // Bots may delete messages in a private chat; the code then leaves the chat history.
  await deps
    .send('deleteMessage', { chat_id: chatId, message_id: userMessageId })
    .catch((err) => deps.log?.('telegram delete failed', { err: String(err) }));
  await sendTracked(
    deps,
    { chat_id: chatId, text: reply, parse_mode: 'HTML' },
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
