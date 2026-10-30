import { describe, expect, it } from 'vitest';
import {
  checkLocalModel,
  findMlxModels,
  isLoopback,
  ModelServer,
  normaliseBaseUrl,
  startSharedEndpoint,
} from './local-model.js';

describe('local model settings', () => {
  it('normalises the server URL to its /v1 base', () => {
    expect(normaliseBaseUrl('http://localhost:8080')).toBe('http://localhost:8080/v1');
    expect(normaliseBaseUrl('http://localhost:1234/v1/')).toBe('http://localhost:1234/v1');
    expect(normaliseBaseUrl('http://127.0.0.1:11434/v1/chat/completions')).toBe(
      'http://127.0.0.1:11434/v1',
    );
    expect(() => normaliseBaseUrl('ftp://localhost')).toThrow(/http/);
  });

  it('accepts only this Mac', () => {
    expect(isLoopback('http://localhost:8080/v1')).toBe(true);
    expect(isLoopback('http://127.0.0.1:8080/v1')).toBe(true);
    expect(isLoopback('http://192.168.1.4:8080/v1')).toBe(false);
  });

  it('reports the models and whether the model calls tools', async () => {
    const fetchFn = (async (url: string) =>
      url.endsWith('/models')
        ? new Response(JSON.stringify({ data: [{ id: 'qwen' }] }))
        : new Response(
            JSON.stringify({
              choices: [{ message: { tool_calls: [{ function: { name: 'set_status' } }] } }],
            }),
          )) as unknown as typeof fetch;
    const r = await checkLocalModel({ url: 'http://localhost:8080' }, fetchFn);
    expect(r).toMatchObject({ ok: true, models: ['qwen'], toolCalls: true });
  });

  it('says so when nothing answers', async () => {
    const fetchFn = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const r = await checkLocalModel({ url: 'http://localhost:8080' }, fetchFn);
    expect(r.ok).toBe(false);
    expect(r.problem).toMatch(/nothing answers/);
  });
});

describe('ModelServer (on demand)', () => {
  function setup(opts: { upAlready?: boolean } = {}) {
    let up = !!opts.upAlready;
    let alive = false;
    const spawned: string[][] = [];
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const fetchFn = (async () => {
      if (!up) throw new Error('ECONNREFUSED');
      return new Response('{"data":[]}');
    }) as unknown as typeof fetch;
    const server = new ModelServer(
      { url: 'http://localhost:8080/v1', command: ['mlx_lm.server'], idleMinutes: 10 },
      {
        fetchFn,
        log: () => {},
        sleep: async () => {
          if (alive) up = true; // the model finished loading
        },
        spawn: (command) => {
          spawned.push(command);
          alive = true;
          return {
            running: () => alive,
            stop: () => {
              alive = false;
              up = false;
            },
          };
        },
        setTimer: (fn, ms) => {
          const t = { fn, ms };
          timers.push(t);
          return t;
        },
        clearTimer: (t) => {
          const i = timers.indexOf(t as (typeof timers)[number]);
          if (i >= 0) timers.splice(i, 1);
        },
      },
    );
    return { server, spawned, timers, isAlive: () => alive };
  }

  it('starts the server on the first request and stops it after the idle time', async () => {
    const { server, spawned, timers, isAlive } = setup();
    expect(await server.acquire()).toBe(true);
    expect(spawned).toEqual([['mlx_lm.server']]);
    expect(timers).toHaveLength(0); // busy: no idle clock
    server.done();
    expect(timers).toEqual([expect.objectContaining({ ms: 600_000 })]);
    // Another request before the time is up keeps it.
    expect(await server.acquire()).toBe(true);
    expect(timers).toHaveLength(0);
    expect(spawned).toHaveLength(1);
    server.done();
    timers[0]?.fn();
    expect(isAlive()).toBe(false);
  });

  it('uses a server it did not start and never stops it', async () => {
    const { server, spawned, timers } = setup({ upAlready: true });
    expect(await server.acquire()).toBe(true);
    server.done();
    expect(spawned).toHaveLength(0);
    expect(timers).toHaveLength(0);
  });
});

describe('shared endpoint', () => {
  it('forwards OpenAI requests to the server', async () => {
    const { createServer } = await import('node:http');
    const upstream = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ path: req.url, got: body ? JSON.parse(body) : null }));
      });
    });
    await new Promise<void>((r) => upstream.listen(0, 'localhost', () => r()));
    const port = (upstream.address() as { port: number }).port;
    const config = { url: `http://localhost:${port}/v1`, port: 0 };
    const server = new ModelServer(config, {
      log: () => {},
      spawn: () => {
        throw new Error('not started: one is up');
      },
    });
    const shared = await startSharedEndpoint(config, server, () => {});
    try {
      const r = await fetch(`${shared.url}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [] }),
      });
      expect(await r.json()).toEqual({ path: '/v1/chat/completions', got: { messages: [] } });
      expect((await fetch(shared.url.replace('/v1', '/other'))).status).toBe(404);
    } finally {
      await shared.close();
      upstream.close();
    }
  });
});

describe('findMlxModels', () => {
  it('finds the downloaded MLX chat models, instruct and Qwen first', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const os = await import('node:os');
    const hub = mkdtempSync(`${os.tmpdir()}/hub-`);
    const add = (dir: string, complete = true) => {
      mkdirSync(`${hub}/${dir}/snapshots/abc`, { recursive: true });
      if (complete) writeFileSync(`${hub}/${dir}/snapshots/abc/config.json`, '{}');
    };
    add('models--mlx-community--parakeet-tdt-0.6b-v2');
    add('models--pyannote--speaker-diarization-community-1');
    add('models--mlx-community--Llama-3.2-3B-4bit');
    add('models--mlx-community--Qwen3-30B-A3B-Instruct-2507-4bit');
    add('models--mlx-community--Qwen3-8B-4bit', false); // download never finished
    mkdirSync(`${hub}/.locks`);
    expect(await findMlxModels(hub)).toEqual([
      'mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit',
      'mlx-community/Llama-3.2-3B-4bit',
    ]);
    expect(await findMlxModels(`${hub}/missing`)).toEqual([]);
  });
});
