import { randomUUID } from 'node:crypto';
import type { GenerateResponse, Part } from '@dodo/core';
import {
  BudgetStop,
  type EventAction,
  type Generate,
  type GmailMessage,
  type GmailThread,
  handleEventAnswer,
  handleReplyAnswer,
  type ReplyAction,
  runGmailJob,
} from '@dodo/jobs';
import { FirestoreJobStore } from '@dodo/jobs/firestore';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { taskSink } from './jobs.js';

const enabled = !!process.env.FIRESTORE_EMULATOR_HOST;
const app = enabled ? initializeApp({ projectId: 'demo-dodo' }, 'jobs-test') : undefined;
const db = app ? getFirestore(app) : undefined;

const HOUR = 3_600_000;
const ME = 'arnout@example.com';
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

/** An in-memory Gmail: threads, drafts, and sending a draft adds it to its thread as SENT. */
class FakeGmail {
  threads = new Map<string, GmailMessage[]>();
  drafts = new Map<string, { raw: string; threadId: string }>();
  sent: string[] = [];
  private n = 0;
  constructor(private readonly now: () => number) {}

  add(
    threadId: string,
    from: string,
    hoursAgo: number,
    text: string,
    labels = ['INBOX'],
    extra: Array<{ name: string; value: string }> = [],
  ) {
    const id = `${threadId}-m${++this.n}`;
    const list = this.threads.get(threadId) ?? [];
    list.push({
      id,
      threadId,
      labelIds: labels,
      internalDate: String(this.now() - hoursAgo * HOUR),
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'From', value: from },
          { name: 'Subject', value: 'Bezoek Kerkstraat 12' },
          { name: 'Message-ID', value: `<${id}@x>` },
          ...extra,
        ],
        body: { data: b64(text) },
      },
    });
    this.threads.set(threadId, list);
    return id;
  }
  async profile() {
    return { emailAddress: ME };
  }
  async listThreads() {
    return [...this.threads.keys()].map((id) => ({ id }));
  }
  async getThread(id: string): Promise<GmailThread> {
    return { id, messages: structuredClone(this.threads.get(id) ?? []) };
  }
  async createDraft(raw: string, threadId: string) {
    const id = `d${++this.n}`;
    this.drafts.set(id, { raw, threadId });
    return { id, message: { id: `${id}-msg` } };
  }
  async updateDraft(id: string, raw: string, threadId: string) {
    this.drafts.set(id, { raw, threadId });
    return { id, message: { id: `${id}-msg` } };
  }
  async getDraft(id: string) {
    const d = this.drafts.get(id);
    if (!d) throw Object.assign(new Error('not found'), { status: 404 });
    const mime = Buffer.from(d.raw, 'base64url').toString('utf8');
    const body = Buffer.from(
      (mime.split('\r\n\r\n')[1] ?? '').replace(/\r\n/g, ''),
      'base64',
    ).toString('utf8');
    return {
      id,
      message: {
        id: `${id}-msg`,
        threadId: d.threadId,
        payload: { mimeType: 'text/plain', body: { data: b64(body) } },
      },
    };
  }
  async sendDraft(id: string) {
    const d = this.drafts.get(id);
    if (!d) throw new Error('draft gone');
    this.drafts.delete(id);
    this.sent.push(id);
    this.add(d.threadId, `Arnout <${ME}>`, 0, 'sent reply', ['SENT']);
    return { id: 'sent', threadId: d.threadId };
  }
}

const reply = (parts: Part[], cost = 100): GenerateResponse => ({
  content: { role: 'model', parts },
  usage: { inputTokens: 10, outputTokens: 10, thinkingTokens: 0, cachedInputTokens: 0 },
  cost,
  remaining: 1_000_000,
});
const decide = (args: Record<string, unknown>) =>
  reply([{ functionCall: { name: 'decide', args } }]);

describe.skipIf(!enabled)('Gmail follow-up job (emulator)', () => {
  afterAll(async () => app && deleteApp(app));

  async function setup(config: Record<string, unknown> = {}) {
    if (!db) throw new Error('no db');
    const jobId = `gmail-${randomUUID().slice(0, 8)}`;
    const clock = { now: Date.UTC(2026, 9, 27, 10) };
    const now = clock.now;
    await db
      .doc(`jobs/${jobId}`)
      .set({ kind: 'gmail-followup', enabled: true, config, state: { consecutiveFailures: 0 } });
    await db
      .doc('connectors/google')
      .set({ status: 'connected', email: ME, scopes: [], missingScopes: [], updatedAt: now });
    const gmail = new FakeGmail(() => clock.now);
    const store = new FirestoreJobStore(db);
    const tasks = taskSink(db);
    const notify = vi.fn(async () => {});
    const deps = (generate: Generate) => ({
      store,
      tasks,
      gmail,
      calendar: { timeZone: async () => 'Europe/Brussels', busy: async () => [] },
      generate,
      notify: { notify },
      now: () => clock.now,
      ids: () => randomUUID(),
    });
    return { db, jobId, gmail, store, tasks, notify, deps, now, clock };
  }

  it('creates a task with a draft and an approval card once per message, and never repeats it', async () => {
    const { db, jobId, gmail, deps, notify, clock } = await setup();
    const thread = `t-${randomUUID().slice(0, 8)}`;
    gmail.add(thread, `Arnout <${ME}>`, 30, 'Can I visit Kerkstraat 12?', ['SENT']);
    gmail.add(thread, '"Jan Peeters" <jan@immo.be>', 2, 'Sure: Tuesday or Wednesday?');
    // Noise the job must not spend a model call on.
    gmail.add(
      `n-${thread}`,
      'news@shop.be',
      2,
      'Sale!',
      ['INBOX'],
      [{ name: 'List-Unsubscribe', value: '<x>' }],
    );
    gmail.add(`a-${thread}`, 'ann@x.be', 2, 'Archived', ['CATEGORY_PERSONAL']);

    const generate = vi.fn<Generate>().mockResolvedValue(
      decide({
        action: 'create',
        reason: 'The agent proposes visit times',
        title: 'Schedule house visit Kerkstraat 12',
        summary: 'Jan proposes Tuesday or Wednesday.',
        priority: 'high',
        reply: 'Dag Jan, woensdag om 10u past mij.',
      }),
    );
    const run = await runGmailJob(deps(generate), { jobId, trigger: 'manual' });
    expect(run.state).toBe('succeeded');
    expect(run.counts).toMatchObject({ scanned: 1, created: 1, skipped: 1 });
    expect(generate).toHaveBeenCalledOnce();

    const taskId = run.entries.find((e) => e.threadId === thread)?.taskId as string;
    const task = (await db.doc(`tasks/${taskId}`).get()).data();
    expect(task).toMatchObject({
      title: 'Schedule house visit Kerkstraat 12',
      priority: 'high',
      ai: { enabled: false, profile: 'untrusted' },
      source: { kind: 'gmail', ref: thread, jobId, label: 'Jan Peeters' },
      tags: ['email'],
    });
    expect(gmail.drafts.size).toBe(1);
    const messages = await db.collection(`tasks/${taskId}/messages`).get();
    const card = messages.docs.find((m) => m.get('action.type') === 'jobs.reply');
    expect(card?.get('input')).toMatchObject({
      kind: 'approval',
      prompt: 'Send this reply to Jan Peeters?',
    });
    expect(card?.get('action')).toMatchObject({ state: 'pending', threadId: thread, revision: 0 });
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ taskId, input: { messageId: card?.id, kind: 'approval' } }),
    );

    // Second run: same messages, nothing new, no model call, no second draft.
    const again = await runGmailJob(deps(generate), { jobId, trigger: 'manual' });
    expect(again.counts).toMatchObject({ scanned: 0, created: 0 });
    expect(generate).toHaveBeenCalledOnce();
    expect(gmail.drafts.size).toBe(1);

    // Approve: sent once, task done; a duplicate trigger does nothing.
    const action = card?.get('action') as ReplyAction;
    const replyDeps = { tasks: deps(generate).tasks, store: deps(generate).store, gmail, generate };
    await card?.ref.update({ 'input.answer': { value: 'yes', answeredAt: 1 } });
    expect(await handleReplyAnswer(replyDeps, taskId, card?.id as string, action, 'yes')).toBe(
      'sent',
    );
    expect(await handleReplyAnswer(replyDeps, taskId, card?.id as string, action, 'yes')).toBe(
      'noop',
    );
    expect(gmail.sent).toHaveLength(1);
    expect((await db.doc(`tasks/${taskId}`).get()).get('status')).toBe('done');

    // Jan answers again: the same task reopens with a new message, not a second task.
    clock.now += 3 * HOUR;
    gmail.add(thread, '"Jan Peeters" <jan@immo.be>', 1.5, 'Wednesday 10:00 is confirmed.');
    generate.mockResolvedValueOnce(
      decide({ action: 'update', reason: 'Visit confirmed', summary: 'Confirmed for Wednesday.' }),
    );
    const third = await runGmailJob(deps(generate), { jobId, trigger: 'manual' });
    expect(third.counts).toMatchObject({ updated: 1, created: 0 });
    expect((await db.doc(`tasks/${taskId}`).get()).get('status')).toBe('todo');
  });

  it('rewrites a draft on "deny: reason" and keeps it on a plain deny', async () => {
    const { jobId, gmail, deps, db } = await setup();
    const thread = `t-${randomUUID().slice(0, 8)}`;
    gmail.add(thread, 'jan@immo.be', 2, 'When can you come?');
    const generate = vi.fn<Generate>().mockResolvedValueOnce(
      decide({
        action: 'create',
        reason: 'needs a time',
        title: 'Pick a visit time',
        reply: 'Tuesday?',
      }),
    );
    const run = await runGmailJob(deps(generate), { jobId, trigger: 'manual' });
    const taskId = run.entries[0]?.taskId as string;
    const card = (await db.collection(`tasks/${taskId}/messages`).get()).docs.find((m) =>
      m.get('action'),
    );
    const replyDeps = { tasks: deps(generate).tasks, store: deps(generate).store, gmail, generate };

    generate.mockResolvedValueOnce(reply([{ text: 'Thursday at 14:00?' }]));
    const result = await handleReplyAnswer(
      replyDeps,
      taskId,
      card?.id as string,
      card?.get('action'),
      'deny: propose Thursday',
    );
    expect(result).toBe('revised');
    const draft = await gmail.getDraft(card?.get('action.draftId'));
    expect(Buffer.from(draft.message.payload?.body?.data ?? '', 'base64url').toString()).toBe(
      'Thursday at 14:00?',
    );
    const cards = (await db.collection(`tasks/${taskId}/messages`).get()).docs.filter((m) =>
      m.get('action'),
    );
    expect(cards.map((c) => c.get('action.state')).sort()).toEqual(['pending', 'superseded']);
    const fresh = cards.find((c) => c.get('action.state') === 'pending');
    expect(fresh?.get('action.revision')).toBe(1);
    expect(
      await handleReplyAnswer(replyDeps, taskId, fresh?.id as string, fresh?.get('action'), 'no'),
    ).toBe('declined');
    expect(gmail.sent).toHaveLength(0);
  });

  it('closes the task when you reply in Gmail yourself', async () => {
    const { jobId, gmail, deps, db } = await setup({ draftReplies: false });
    const thread = `t-${randomUUID().slice(0, 8)}`;
    gmail.add(thread, 'jan@immo.be', 2, 'Can you send the lease?');
    const generate = vi
      .fn<Generate>()
      .mockResolvedValue(
        decide({ action: 'create', reason: 'action', title: 'Send lease to Jan' }),
      );
    const run = await runGmailJob(deps(generate), { jobId, trigger: 'manual' });
    const taskId = run.entries[0]?.taskId as string;
    gmail.add(thread, ME, 0.2, 'Here it is', ['SENT']);
    generate.mockResolvedValueOnce(decide({ action: 'done', reason: 'You sent the lease' }));
    const next = await runGmailJob(deps(generate), { jobId, trigger: 'manual' });
    expect(next.counts.resolved).toBe(1);
    expect(next.entries[0]).toMatchObject({ decision: 'done', taskId });
    expect((await db.doc(`tasks/${taskId}`).get()).get('status')).toBe('done');
  });

  it('keeps the task open with the next step when your reply leaves something to do', async () => {
    const { jobId, gmail, deps, db } = await setup({ draftReplies: false });
    const thread = `t-${randomUUID().slice(0, 8)}`;
    gmail.add(thread, 'jan@immo.be', 2, 'Can you send the lease?');
    const generate = vi
      .fn<Generate>()
      .mockResolvedValueOnce(decide({ action: 'create', reason: 'action', title: 'Send lease' }))
      .mockResolvedValueOnce(
        decide({ action: 'open', reason: 'You promised it for tomorrow', nextStep: 'Send lease' }),
      );
    const run = await runGmailJob(deps(generate), { jobId, trigger: 'manual' });
    const taskId = run.entries[0]?.taskId as string;
    gmail.add(thread, ME, 0.2, 'I will send it tomorrow', ['SENT']);
    const next = await runGmailJob(deps(generate), { jobId, trigger: 'manual' });
    expect(next.counts.updated).toBe(1);
    const task = await db.doc(`tasks/${taskId}`).get();
    expect(task.get('status')).not.toBe('done');
    expect(task.get('statusLine.text')).toBe('Send lease');
    // The same reply is not rechecked again.
    const third = await runGmailJob(deps(generate), { jobId, trigger: 'manual' });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(third.counts.updated).toBe(0);
  });

  it('removes the task when the email is deleted in Gmail', async () => {
    const { jobId, gmail, deps, db } = await setup({ draftReplies: false });
    const thread = `t-${randomUUID().slice(0, 8)}`;
    gmail.add(thread, 'jan@immo.be', 2, 'Can you send the lease?');
    const generate = vi
      .fn<Generate>()
      .mockResolvedValue(decide({ action: 'create', reason: 'action', title: 'Send lease' }));
    const run = await runGmailJob(deps(generate), { jobId, trigger: 'manual' });
    const taskId = run.entries[0]?.taskId as string;
    for (const m of gmail.threads.get(thread) ?? []) m.labelIds = ['TRASH'];
    const next = await runGmailJob(deps(generate), { jobId, trigger: 'manual' });
    expect(next.counts.removed).toBe(1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect((await db.doc(`tasks/${taskId}`).get()).get('status')).toBe('cancelled');
  });

  it('dry runs write nothing, and a budget stop gives the message back', async () => {
    const { jobId, gmail, deps, db, store } = await setup();
    const thread = `t-${randomUUID().slice(0, 8)}`;
    const msgId = gmail.add(thread, 'jan@immo.be', 2, 'Question?');
    const generate = vi
      .fn<Generate>()
      .mockResolvedValue(
        decide({ action: 'create', reason: 'q', title: 'Answer Jan', reply: 'Yes.' }),
      );
    const dry = await runGmailJob(deps(generate), { jobId, trigger: 'manual', dryRun: true });
    expect(dry.counts.created).toBe(1);
    expect(dry.entries[0]).toMatchObject({
      decision: 'create',
      title: 'Answer Jan',
      draft: 'Yes.',
    });
    expect(await store.peekItem(jobId, msgId)).toBeUndefined();
    expect(gmail.drafts.size).toBe(0);
    expect((await db.collection('tasks').where('source.ref', '==', thread).get()).empty).toBe(true);

    const broke = vi.fn<Generate>().mockRejectedValue(new BudgetStop('budget_exhausted'));
    const stopped = await runGmailJob(deps(broke), { jobId, trigger: 'manual' });
    expect(stopped.state).toBe('budget_exhausted');
    expect(await store.peekItem(jobId, msgId)).toBeUndefined();
    // The lock was released: the next run can go.
    const later = await runGmailJob(deps(generate), { jobId, trigger: 'manual' });
    expect(later.counts.created).toBe(1);
  });

  it('skips scheduled runs that are not due, off, or locked', async () => {
    const { jobId, deps, db, store, now } = await setup({ intervalMinutes: 30 });
    const generate = vi.fn<Generate>();
    await db.doc(`jobs/${jobId}`).update({ 'state.lastRunAt': now - 10 * 60_000 });
    expect((await runGmailJob(deps(generate), { jobId, trigger: 'schedule' })).error).toBe(
      'Not due yet',
    );
    await db.doc(`jobs/${jobId}`).update({ 'state.lastRunAt': 0 });
    expect(await store.lock(jobId, 'other', now, 60_000)).toBe(true);
    expect((await runGmailJob(deps(generate), { jobId, trigger: 'schedule' })).error).toMatch(
      /still going/,
    );
    await db.doc(`jobs/${jobId}`).update({ enabled: false });
    expect((await runGmailJob(deps(generate), { jobId, trigger: 'schedule' })).error).toBe(
      'Job is off',
    );
  });
  it('offers a confirmed appointment for the calendar and adds it once on approval', async () => {
    const { db, jobId, gmail, store, tasks, deps, notify } = await setup();
    const thread = `e-${randomUUID().slice(0, 8)}`;
    gmail.add(thread, `Arnout <${ME}>`, 5, 'Donderdag 14u past mij.', ['SENT']);
    gmail.add(thread, '"Jan Peeters" <jan@immo.be>', 2, 'Perfect, tot donderdag om 14u!');
    const generate = vi.fn<Generate>().mockResolvedValue(
      decide({
        action: 'create',
        reason: 'The visit is confirmed',
        title: 'House visit Kerkstraat 12',
        event: {
          title: 'House visit Kerkstraat 12',
          start: '2026-10-29T14:00',
          location: 'Kerkstraat 12',
        },
      }),
    );
    const busy = vi.fn(async () => [
      { start: Date.UTC(2026, 9, 29, 13, 30), end: Date.UTC(2026, 9, 29, 14) },
    ]);
    const run = await runGmailJob(
      { ...deps(generate), calendar: { timeZone: async () => 'Europe/Brussels', busy } },
      { jobId, trigger: 'manual' },
    );
    const entry = run.entries.find((e) => e.threadId === thread);
    expect(entry?.event).toBe('House visit Kerkstraat 12, Thu 29 Oct, 14:00');
    const taskId = entry?.taskId as string;
    const messages = await db.collection(`tasks/${taskId}/messages`).get();
    const card = messages.docs.find((m) => m.get('action.type') === 'jobs.event');
    expect(card?.get('action')).toMatchObject({
      state: 'pending',
      start: '2026-10-29T14:00',
      durationMinutes: 60,
      timeZone: 'Europe/Brussels',
    });
    // 13:30–14:00 UTC is 14:30–15:00 in Brussels: it overlaps the visit.
    expect(card?.get('body')).toContain('already has something');
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Add to your calendar?',
        input: { messageId: card?.id, kind: 'approval' },
      }),
    );
    expect((await store.getThread(jobId, thread))?.event).toEqual({ taskId, messageId: card?.id });

    const insertEvent = vi.fn(async () => ({
      id: 'ev1',
      htmlLink: 'https://calendar.google.com/e/1',
    }));
    const eventDeps = { tasks, store, calendar: { insertEvent } };
    const action = card?.get('action') as EventAction;
    expect(await handleEventAnswer(eventDeps, taskId, card?.id as string, action, 'approve')).toBe(
      'created',
    );
    expect(await handleEventAnswer(eventDeps, taskId, card?.id as string, action, 'approve')).toBe(
      'noop',
    );
    expect(insertEvent).toHaveBeenCalledOnce();
    expect(insertEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'House visit Kerkstraat 12',
        start: '2026-10-29T14:00:00',
        end: '2026-10-29T15:00:00',
        timeZone: 'Europe/Brussels',
      }),
    );
    expect(
      (await db.doc(`tasks/${taskId}/messages/${card?.id}`).get()).get('action'),
    ).toMatchObject({ state: 'created', eventUrl: 'https://calendar.google.com/e/1' });
    expect((await store.getThread(jobId, thread))?.event).toBeUndefined();
  });
});
