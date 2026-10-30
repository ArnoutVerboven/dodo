import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runAgent } from './loop.js';
import { createSecretResolver, findVaultRefs } from './secrets.js';
import { FakeControlPlane, MemoryTaskStore, MemoryTrace, sampleTask } from './testing.js';
import { define, type ToolDef, taskTools } from './tools.js';

const values: Record<string, string> = { 'energy.password': 's3cret!', 'energy.phone': '+32470' };

describe('vault references', () => {
  it('finds references once each', () => {
    expect(
      findVaultRefs('{{vault:energy.phone}} and {{vault:energy.phone}} {{vault:Bad.x}}'),
    ).toEqual([{ entryId: 'energy', field: 'phone', ref: '{{vault:energy.phone}}' }]);
  });

  it('resolves for a host and redacts what it handed out', async () => {
    const hosts: string[] = [];
    const s = createSecretResolver(async (e, f, host) => {
      hosts.push(host);
      const v = values[`${e}.${f}`];
      if (!v) throw new Error(`No ${e}.${f}`);
      return v;
    });
    expect(s.redact('s3cret!')).toBe('s3cret!'); // nothing resolved yet
    expect(await s.resolve('pw={{vault:energy.password}}', 'engie.be')).toBe('pw=s3cret!');
    expect(hosts).toEqual(['engie.be']);
    expect(s.redact('page shows s3cret! twice: s3cret!')).toBe(
      'page shows {{vault:energy.password}} twice: {{vault:energy.password}}',
    );
    await expect(s.resolve('{{vault:energy.pin}}', 'engie.be')).rejects.toThrow('No energy.pin');
  });
});

describe('loop redaction', () => {
  it('keeps resolved values out of tool results, the trace and the thread', async () => {
    const secrets = createSecretResolver(async (e, f) => values[`${e}.${f}`] as string);
    const typeTool = define({
      name: 'type_into_page',
      description: 'test',
      schema: z.object({ text: z.string() }),
      async execute({ text }, ctx) {
        const typed = await ctx.secrets?.resolve(text, 'engie.be');
        return { result: { page: `field now contains ${typed}` } };
      },
    });
    const control = new FakeControlPlane([
      { calls: [{ name: 'type_into_page', args: { text: '{{vault:energy.password}}' } }] },
      // A model that somehow saw the value and tries to post it.
      { calls: [{ name: 'post_message', args: { body: 'the password is s3cret!' } }] },
      { calls: [{ name: 'finish', args: { outcome: 'done' } }] },
    ]);
    const store = new MemoryTaskStore(sampleTask());
    const trace = new MemoryTrace();
    const result = await runAgent(
      {
        runId: 'r',
        task: sampleTask(),
        project: undefined,
        model: 'm',
        trigger: 'new',
        session: [],
      },
      { control, store, trace, tools: [...taskTools, typeTool as ToolDef], secrets },
    );
    expect(result.reason).toBe('finished');
    expect(JSON.stringify(result.session)).not.toContain('s3cret!');
    expect(JSON.stringify(trace.events)).not.toContain('s3cret!');
    expect(store.messages.map((m) => m.body)).toEqual([
      'the password is {{vault:energy.password}}',
    ]);
  });
});

describe('vault and personal info tools', () => {
  it('lists entries without values and asks approval for one entry', async () => {
    const store = new MemoryTaskStore(sampleTask());
    store.vault = [
      {
        id: 'energy',
        name: 'Energy provider',
        domains: ['engie.be'],
        fields: [{ key: 'phone', label: 'itsme phone' }],
        hint: 'itsme',
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    store.personalInfo = { email: 'a@b.be', extra: [], schedulingNotes: 'Mon–Thu late' };
    const control = new FakeControlPlane([
      { calls: [{ name: 'get_personal_info', args: {} }] },
      { calls: [{ name: 'list_vault', args: {} }] },
      { calls: [{ name: 'request_vault_access', args: { entryId: 'energy', reason: 'log in' } }] },
    ]);
    const result = await runAgent(
      {
        runId: 'r',
        task: sampleTask(),
        project: undefined,
        model: 'm',
        trigger: 'new',
        session: [],
      },
      { control, store, trace: new MemoryTrace(), tools: taskTools },
    );
    expect(result.reason).toBe('waiting_input');
    const text = JSON.stringify(result.session);
    expect(text).toContain('Mon–Thu late');
    expect(text).toContain('{{vault:energy.phone}}');
    expect(control.inputRequests[0]).toMatchObject({
      kind: 'approval',
      suggestedRule: 'Vault(energy)',
      prompt:
        'Use your vault entry "Energy provider" (itsme phone) on engie.be for this task? log in',
    });
  });

  it('will not let ask_user write a card that grants a vault entry', async () => {
    const control = new FakeControlPlane([
      {
        calls: [
          {
            name: 'ask_user',
            args: {
              kind: 'approval',
              prompt: 'Download the invoice?',
              suggestedRule: 'Vault(energy)',
            },
          },
        ],
      },
      { calls: [{ name: 'finish', args: { outcome: 'done' } }] },
    ]);
    const result = await runAgent(
      {
        runId: 'r',
        task: sampleTask(),
        project: undefined,
        model: 'm',
        trigger: 'new',
        session: [],
      },
      {
        control,
        store: new MemoryTaskStore(sampleTask()),
        trace: new MemoryTrace(),
        tools: taskTools,
      },
    );
    expect(control.inputRequests).toEqual([]);
    expect(JSON.stringify(result.session)).toContain('request_vault_access');
  });
});

describe('escaped values', () => {
  it('redacts a value however a result quotes it', async () => {
    const s = createSecretResolver(async () => `it's "a\\b" <&>`);
    await s.resolve('{{vault:x.pw}}', 'x.be');
    const raw = `it's "a\\b" <&>`;
    for (const shown of [
      raw,
      JSON.stringify(raw),
      `fill('it\\'s "a\\\\b" <&>')`,
      encodeURIComponent(raw),
      'it&#39;s &quot;a\\b&quot; &lt;&amp;&gt;',
    ])
      expect(s.redact(shown)).toContain('{{vault:x.pw}}');
  });
});

describe('secret answers', () => {
  it('resolves {{answer:…}} through its own fetch and redacts the value after', async () => {
    const asked: string[] = [];
    const s = createSecretResolver(
      async () => {
        throw new Error('no vault');
      },
      async (id) => {
        asked.push(id);
        return '482913';
      },
    );
    expect(await s.resolve('{{answer:m1}}', 'bank.be')).toBe('482913');
    expect(asked).toEqual(['m1']);
    expect(s.redact('code 482913 accepted')).toBe('code {{answer:m1}} accepted');
  });

  it('refuses answer references when the run has no way to fetch them', async () => {
    const s = createSecretResolver(async () => 'x');
    await expect(s.resolve('{{answer:m1}}', 'bank.be')).rejects.toThrow('not available');
  });
});
