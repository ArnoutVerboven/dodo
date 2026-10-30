import { randomUUID } from 'node:crypto';
import { GOOGLE_SCOPE, paths, type Run } from '@dodo/core';
import { jobPaths } from '@dodo/jobs';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { afterAll, describe, expect, it } from 'vitest';
import { googleAccessForRun, runGoogleTool } from './google-tools.js';

const enabled = !!process.env.FIRESTORE_EMULATOR_HOST;
const app = enabled ? initializeApp({ projectId: 'demo-dodo' }, 'google-tools-test') : undefined;
const db = app ? getFirestore(app) : undefined;

afterAll(async () => {
  if (app) await deleteApp(app);
});

const oauth = () => ({ clientId: 'c', clientSecret: 's', redirectUri: 'http://x' });
const CONNECTOR = `google-test-${randomUUID()}`;
const tokens = { get: async () => 'refresh', put: async () => {}, clear: async () => {} };

/** A fake Google: a token endpoint, then whatever `route` answers; records every call. */
function fakeGoogle(route: (url: URL, init: RequestInit) => unknown) {
  const calls: Array<{ url: URL; method: string; body?: string }> = [];
  const f = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'oauth2.googleapis.com')
      return Response.json({ access_token: 'at', expires_in: 3600 });
    calls.push({
      url,
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? init.body : undefined,
    });
    const out = route(url, init);
    return out instanceof Response ? out : Response.json(out);
  }) as typeof fetch;
  return { f, calls };
}

async function setup(scopes: string[] = Object.values(GOOGLE_SCOPE)) {
  const d = db as NonNullable<typeof db>;
  const taskId = `t-${randomUUID()}`;
  await d.doc(paths.task(taskId)).set({ title: 'Book dermatologist', allowRules: [] });
  await d.doc(jobPaths.connector(CONNECTOR)).set({
    status: 'connected',
    email: 'me@example.com',
    scopes,
    missingScopes: [],
    updatedAt: Date.now(),
  });
  await d.doc(paths.settings()).set({ google: { driveFolder: 'dodo' } }, { merge: true });
  const run = { id: `r-${randomUUID()}`, taskId } as Run;
  return { d, run, taskId };
}

describe.skipIf(!enabled)('googleTool', () => {
  it('tells runStart which account, scopes and folder a run gets', async () => {
    await setup([GOOGLE_SCOPE.gmailRead]);
    const access = await googleAccessForRun(db as NonNullable<typeof db>, CONNECTOR);
    expect(access).toEqual({
      email: 'me@example.com',
      scopes: [GOOGLE_SCOPE.gmailRead],
      folder: 'dodo',
    });
  });

  it('refuses an operation the connection has no scope for', async () => {
    const { d, run } = await setup([GOOGLE_SCOPE.gmailRead]);
    const { f } = fakeGoogle(() => ({}));
    await expect(
      runGoogleTool({ db: d, oauth, tokens, fetch: f, connectorId: CONNECTOR }, run, {
        op: 'drive_search',
        inFolder: false,
        max: 5,
      }),
    ).rejects.toThrow(/lacks access/);
  });

  it('creates an event only after the task approved it', async () => {
    const { d, run, taskId } = await setup();
    const { f, calls } = fakeGoogle((url) =>
      url.pathname.endsWith('/events')
        ? { id: 'e1', summary: 'Dermatologist', htmlLink: 'https://calendar.google.com/e1' }
        : { timeZone: 'Europe/Brussels' },
    );
    const call = {
      op: 'calendar_create_event' as const,
      title: 'Dermatologist',
      start: '2026-11-03T10:00',
      end: '2026-11-03T10:30',
    };
    await expect(
      runGoogleTool({ db: d, oauth, tokens, fetch: f, connectorId: CONNECTOR }, run, call),
    ).rejects.toThrow(/Calendar\(create:Dermatologist\)/);
    expect(calls).toEqual([]);

    await d.collection(paths.messages(taskId)).add({
      author: 'system',
      body: 'Approve?',
      input: {
        kind: 'approval',
        prompt: 'Add Dermatologist?',
        suggestedRule: 'Calendar(create:Dermatologist)',
        answer: { value: 'yes' },
      },
      createdAt: Date.now(),
    });
    const r = await runGoogleTool(
      { db: d, oauth, tokens, fetch: f, connectorId: CONNECTOR },
      run,
      call,
    );
    expect(r).toMatchObject({
      ok: true,
      event: { id: 'e1', url: 'https://calendar.google.com/e1' },
    });
    const insert = calls.find((c) => c.method === 'POST');
    expect(insert?.url.searchParams.get('sendUpdates')).toBe('none');
    expect(JSON.parse(insert?.body ?? '{}').start).toEqual({
      dateTime: '2026-11-03T10:00:00',
      timeZone: 'Europe/Brussels',
    });
  });

  it('saves into the dodo folder, creating it once and remembering it', async () => {
    const { d, run } = await setup();
    await d.doc(jobPaths.connector(CONNECTOR)).update({ driveFolder: FieldValue.delete() });
    let folders = 0;
    const { f, calls } = fakeGoogle((url, init) => {
      if (url.pathname === '/drive/v3/files' && init.method === 'POST') {
        folders++;
        return { id: 'F1', name: 'dodo', mimeType: 'application/vnd.google-apps.folder' };
      }
      if (url.pathname === '/drive/v3/files') return { files: [] };
      if (url.pathname === '/upload/drive/v3/files')
        return {
          id: 'D1',
          name: 'report.md',
          mimeType: 'text/markdown',
          webViewLink: 'https://drive.google.com/file/d/D1/view',
          parents: ['F1'],
        };
      return new Response('not found', { status: 404 });
    });
    const save = {
      op: 'drive_save' as const,
      name: 'report.md',
      mimeType: 'text/markdown',
      data: Buffer.from('# Hi').toString('base64'),
      convert: false,
    };
    const r = await runGoogleTool(
      { db: d, oauth, tokens, fetch: f, connectorId: CONNECTOR },
      run,
      save,
    );
    expect(r).toMatchObject({
      ok: true,
      file: { id: 'D1', url: 'https://drive.google.com/file/d/D1/view' },
      folder: { name: 'dodo' },
    });
    await runGoogleTool({ db: d, oauth, tokens, fetch: f, connectorId: CONNECTOR }, run, save);
    expect(folders).toBe(1);
    expect((await d.doc(jobPaths.connector(CONNECTOR)).get()).get('driveFolder.id')).toBe('F1');
    const upload = calls.find((c) => c.url.pathname === '/upload/drive/v3/files');
    expect(upload?.url.searchParams.get('uploadType')).toBe('multipart');
  });
});
