import { paths } from '@dodo/core';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';

/**
 * Telegram as a notification channel. One bot, one chat (yours), paired once with a code
 * shown in Settings so that nobody else who finds the bot can bind it. Approval cards get
 * inline Yes / No buttons; tapping one answers the input request exactly as the web app would.
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
  input?: { messageId: string; kind: 'text' | 'choice' | 'approval'; options?: string[] };
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

const esc = (s: string) =>
  s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);

export async function notifyTelegram(deps: TelegramDeps, n: Notification): Promise<boolean> {
  if (!deps.token) return false;
  const settings = (await deps.db.doc(paths.settings()).get()).data() ?? {};
  const chatId = settings.telegram?.chatId as number | undefined;
  if (!chatId) return false;
  const text = `<b>${esc(n.title)}</b>\n${esc(n.body).slice(0, 3500)}\n<a href="${n.appUrl}/tasks/${n.taskId}">Open task</a>`;
  const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
  if (n.input) {
    const cb = (v: string) => `a:${n.taskId}:${n.input?.messageId}:${v}`.slice(0, 64);
    if (n.input.kind === 'approval')
      buttons.push([
        { text: '✅ Yes', callback_data: cb('yes') },
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
  try {
    await deps.send('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: buttons.length ? { inline_keyboard: buttons } : undefined,
    });
    return true;
  } catch (err) {
    deps.log?.('telegram send failed', { err: String(err) });
    return false;
  }
}

export interface TelegramUpdate {
  message?: { chat: { id: number }; text?: string; from?: { username?: string } };
  callback_query?: {
    id: string;
    data?: string;
    message?: { chat: { id: number }; message_id: number };
  };
}

/** Handles one webhook update: pairing (`/start CODE`) and button taps. */
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
        await deps.send('sendMessage', {
          chat_id: chatId,
          text: 'Paired. dodo will notify you here.',
        });
      } else if (paired === chatId) {
        await deps.send('sendMessage', { chat_id: chatId, text: 'Already paired.' });
      } else {
        await deps.send('sendMessage', {
          chat_id: chatId,
          text: 'Send /start <code> with the pairing code from dodo Settings.',
        });
      }
      return;
    }
    if (paired !== chatId) return; // strangers get silence
    await deps.send('sendMessage', {
      chat_id: chatId,
      text: 'Reply on the task in the app; this chat is for notifications and approvals.',
    });
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
    const input = snap.get('input') as { answer?: unknown } | undefined;
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
    await ref.update({ 'input.answer': { value, answeredAt: Date.now(), via: 'telegram' } });
    await deps.send('answerCallbackQuery', {
      callback_query_id: cq.id,
      text: `Answered: ${value}`,
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
