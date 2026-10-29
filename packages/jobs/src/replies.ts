import { type Generate, reviseDraft, threadPrompt } from './agent.js';
import { postApproval, type ReplyAction, type UserProfile, userContext } from './gmail-job.js';
import { type GmailMessage, type GmailThread, GoogleApiError } from './google.js';
import { draftText, nameOf, replyMime, toThread } from './mail.js';
import { gmailConfig, LIMITS } from './model.js';
import type { JobStore, Notifier, TaskSink } from './ports.js';

/**
 * What happens when you answer a reply approval card (web or Telegram):
 *   approve / yes   → send the Gmail draft, once
 *   deny: <reason>  → rewrite the draft with the reason, new card
 *   deny / no       → keep the draft in Gmail, do nothing
 * Every branch starts with a state transition from `pending`, so a repeated trigger, a
 * superseded card or a double tap can never send twice.
 */
export interface ReplyDeps {
  tasks: TaskSink;
  store: JobStore;
  gmail: {
    sendDraft(id: string): Promise<GmailMessage>;
    getDraft(id: string): Promise<{ id: string; message: GmailMessage }>;
    updateDraft(id: string, raw: string, threadId: string): Promise<{ id: string }>;
    getThread(id: string, format: 'metadata' | 'full'): Promise<GmailThread>;
    profile(): Promise<{ emailAddress: string }>;
  };
  generate: Generate;
  notify?: Notifier;
  profile?: () => Promise<UserProfile | undefined>;
  now?: () => number;
}

export const isReplyAction = (a: unknown): a is ReplyAction =>
  !!a && typeof a === 'object' && (a as { type?: unknown }).type === 'jobs.reply';

const APPROVE = /^(y|yes|approve|approved|ok|send)\b/i;
const DENY_WITH_REASON = /^deny:\s*([\s\S]+)$/i;

export async function handleReplyAnswer(
  deps: ReplyDeps,
  taskId: string,
  messageId: string,
  action: ReplyAction,
  answer: string,
): Promise<'sent' | 'declined' | 'revised' | 'failed' | 'noop'> {
  const now = deps.now ?? Date.now;
  const name = nameOf(action.to);
  const value = answer.trim();

  if (APPROVE.test(value)) {
    if (!(await deps.tasks.transition(taskId, messageId, ['pending'], 'sending'))) return 'noop';
    try {
      await deps.gmail.sendDraft(action.draftId);
    } catch (err) {
      const msg =
        err instanceof GoogleApiError && err.status === 404
          ? 'The draft no longer exists in Gmail (sent or deleted there?).'
          : `Could not send: ${(err as Error).message.slice(0, 300)}`;
      await deps.tasks.transition(taskId, messageId, ['sending'], 'failed', { error: msg });
      await deps.tasks.post(taskId, msg);
      return 'failed';
    }
    await deps.tasks.transition(taskId, messageId, ['sending'], 'sent', { sentAt: now() });
    await deps.tasks.update(taskId, {
      status: 'done',
      statusLine: { text: `Reply sent to ${name}`.slice(0, 200), needsYou: false },
    });
    await deps.tasks.post(
      taskId,
      `Sent the reply to ${name}. A new message in the thread reopens this task.`,
    );
    const thread = await deps.store.getThread(action.jobId, action.threadId);
    if (thread)
      await deps.store.setThread(action.jobId, {
        ...thread,
        open: false,
        approval: null,
        updatedAt: now(),
      });
    return 'sent';
  }

  const reason = DENY_WITH_REASON.exec(value)?.[1]?.trim();
  if (!reason) {
    if (!(await deps.tasks.transition(taskId, messageId, ['pending'], 'declined'))) return 'noop';
    await deps.tasks.update(taskId, {
      statusLine: { text: 'Reply not sent; the draft stays in Gmail', needsYou: false },
    });
    return 'declined';
  }

  if (action.revision >= LIMITS.maxRevisions) {
    if (!(await deps.tasks.transition(taskId, messageId, ['pending'], 'declined'))) return 'noop';
    await deps.tasks.post(
      taskId,
      `That was rewrite ${action.revision}: edit the draft in Gmail and send it from there.`,
    );
    return 'declined';
  }
  if (!(await deps.tasks.transition(taskId, messageId, ['pending'], 'revising'))) return 'noop';
  try {
    const job = await deps.store.getJob(action.jobId);
    const config = gmailConfig(job?.config);
    const me = (await deps.gmail.profile()).emailAddress.toLowerCase();
    const profile = await deps.profile?.().catch(() => undefined);
    const thread = toThread(await deps.gmail.getThread(action.threadId, 'full'));
    const inReplyTo =
      thread.messages.find((m) => m.id === action.replyToMessageId) ?? thread.messages.at(-1);
    if (!inReplyTo) throw new Error('The thread is empty');
    const current = draftText((await deps.gmail.getDraft(action.draftId)).message);
    const { text } = await reviseDraft({
      model: config.model,
      generate: deps.generate,
      thread: threadPrompt({
        thread,
        me,
        now: now(),
        timeZone: config.timezone || profile?.timeZone || 'Europe/Brussels',
        hours: config.workingHours,
        userContext: userContext(profile, config.context),
      }),
      draft: current,
      instruction: reason,
    });
    await deps.gmail.updateDraft(
      action.draftId,
      replyMime({ from: me, inReplyTo, body: text, to: action.to }),
      action.threadId,
    );
    await deps.tasks.transition(taskId, messageId, ['revising'], 'superseded');
    const newId = await postApproval(deps.tasks, {
      taskId,
      jobId: action.jobId,
      threadId: action.threadId,
      draftId: action.draftId,
      to: action.to,
      text,
      revision: action.revision + 1,
      replyToMessageId: inReplyTo.id,
      account: action.account,
    });
    const known = await deps.store.getThread(action.jobId, action.threadId);
    if (known) {
      await deps.store.setThread(action.jobId, {
        ...known,
        approval: { taskId, messageId: newId },
        updatedAt: now(),
      });
    }
    if (config.notify) {
      await deps.notify
        ?.notify({
          kind: 'job_approval',
          title: `Rewritten reply to ${name}`,
          body: text.slice(0, 1500),
          taskId,
          input: { messageId: newId, kind: 'approval' },
        })
        .catch(() => undefined);
    }
    return 'revised';
  } catch (err) {
    const msg = `Could not rewrite the draft: ${(err as Error).message.slice(0, 300)}`;
    await deps.tasks.transition(taskId, messageId, ['revising'], 'failed', { error: msg });
    await deps.tasks.post(taskId, `${msg} The draft in Gmail is unchanged.`);
    return 'failed';
  }
}
