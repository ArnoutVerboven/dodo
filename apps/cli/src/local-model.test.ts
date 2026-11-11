import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import * as localModel from './local-model.js';
import {
  checkLocalModel,
  DEFAULT_GATEWAY_URL,
  findMlxModels,
  gatewayUp,
  gatewayUrl,
  isLoopback,
  LocalModelHost,
  ModelServer,
  mlxServerCommand,
  normaliseBaseUrl,
  type ServerProcess,
} from './local-model.js';

/** A fake server on a free port of 127.0.0.1 (the gateway, or mlx_lm.server). */
const servers: Server[] = [];
async function fakeServer(
  handle: (req: IncomingMessage, body: string, res: ServerResponse) => void,
  port = 0,
): Promise<{ url: string; port: number; server: Server }> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => handle(req, body, res));
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  servers.push(server);
  const p = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${p}/v1`, port: p, server };
}
const json = (res: ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const p = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return p;
}
/** The gateway as the contract has it: a model list, and chat completions echoing the model. */
const gateway = (seen: string[] = []) =>
  fakeServer((req, body, res) => {
    if (req.url === '/v1/models') return json(res, 200, { data: [{ id: 'default' }] });
    seen.push(JSON.parse(body).model);
    json(res, 200, { choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] });
  });
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

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

describe('the gateway', () => {
  it('is $LOCAL_LLM_URL, else 127.0.0.1:8090; the config overrides or turns it off', () => {
    expect(gatewayUrl({}, {})).toBe('http://127.0.0.1:8090/v1');
    expect(DEFAULT_GATEWAY_URL).toBe('http://127.0.0.1:8090/v1');
    expect(gatewayUrl({}, { LOCAL_LLM_URL: 'http://127.0.0.1:9000' })).toBe(
      'http://127.0.0.1:9000/v1',
    );
    expect(gatewayUrl({}, { LOCAL_LLM_URL: '' })).toBeUndefined();
    expect(gatewayUrl({ gateway: 'http://127.0.0.1:9001/v1' }, { LOCAL_LLM_URL: '' })).toBe(
      'http://127.0.0.1:9001/v1',
    );
    expect(gatewayUrl({ gateway: false }, { LOCAL_LLM_URL: 'http://127.0.0.1:9000' })).toBe(
      undefined,
    );
    expect(gatewayUrl({ gateway: '' }, {})).toBeUndefined();
    // The run's sandbox reaches only this Mac.
    expect(gatewayUrl({ gateway: 'http://192.168.1.4:8090/v1' }, {})).toBeUndefined();
    expect(gatewayUrl({ gateway: 'not a url' }, {})).toBeUndefined();
  });

  it('is up on a 200 with a data list from its model list', async () => {
    const up = await gateway();
    expect(await gatewayUp(up.url)).toBe(true);
    const noList = await fakeServer((_req, _body, res) => json(res, 200, { models: [] }));
    expect(await gatewayUp(noList.url)).toBe(false);
    const failing = await fakeServer((_req, _body, res) => json(res, 503, { data: [] }));
    expect(await gatewayUp(failing.url)).toBe(false);
    expect(await gatewayUp(`http://127.0.0.1:${await closedPort()}/v1`)).toBe(false);
  });
});

describe('LocalModelHost (what a run talks to)', () => {
  /** A stand-in for mlx_lm.server that only listens once "spawned". */
  async function ownServer(seen: string[] = []) {
    const port = await closedPort();
    const spawned: string[][] = [];
    let server: Server | undefined;
    const spawn = (command: string[]): ServerProcess => {
      spawned.push(command);
      server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => {
          body += c;
        });
        req.on('end', () => {
          if (req.url === '/health') return json(res, 200, { status: 'ok' });
          if (req.url === '/v1/models') return json(res, 200, { data: [{ id: 'repo' }] });
          seen.push(JSON.parse(body).model);
          json(res, 200, { choices: [{ message: { content: 'hi' } }] });
        });
      });
      server.listen(port, '127.0.0.1');
      servers.push(server);
      let alive = true;
      return {
        running: () => alive,
        stop: () => {
          alive = false;
          server?.closeAllConnections();
          server?.close();
        },
      };
    };
    return { url: `http://127.0.0.1:${port}/v1`, spawn, spawned };
  }
  const deps = (spawn: (c: string[]) => ServerProcess, env: NodeJS.ProcessEnv = {}) => ({
    spawn,
    log: () => {},
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 20))),
    env,
  });
  const chat = (url: string) =>
    fetch(`${url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'repo', messages: [] }),
    });

  it('gives runs the gateway with model "default" when it is up, and starts nothing', async () => {
    const gw = await gateway();
    const own = await ownServer();
    const host = new LocalModelHost(
      { url: own.url, model: 'repo', command: ['mlx_lm.server'] },
      deps(own.spawn, { LOCAL_LLM_URL: gw.url }),
    );
    expect(await host.forRun()).toEqual({ url: gw.url, model: 'default', via: 'gateway' });
    expect(own.spawned).toHaveLength(0);
    await host.close();
  });

  it("falls back to dodo's own server, started on the first request, when no gateway answers", async () => {
    const seen: string[] = [];
    const own = await ownServer(seen);
    const host = new LocalModelHost(
      { url: own.url, model: 'repo', command: ['mlx_lm.server', '--model', 'repo'] },
      deps(own.spawn, { LOCAL_LLM_URL: `http://127.0.0.1:${await closedPort()}/v1` }),
    );
    const route = await host.forRun();
    expect(route).toMatchObject({ model: 'repo', via: 'own' });
    expect(route.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(new URL(route.url).port).not.toBe('8090');
    expect(own.spawned).toHaveLength(0); // nothing loaded until a run calls the model
    const r = await chat(route.url);
    expect(r.status).toBe(200);
    expect(own.spawned).toEqual([['mlx_lm.server', '--model', 'repo']]);
    expect(seen).toEqual(['repo']);
    await host.close();
  });

  it('asks again for each run: a gateway that came up later wins, and frees our own', async () => {
    const own = await ownServer();
    const port = await closedPort();
    const host = new LocalModelHost(
      { url: own.url, model: 'repo', command: ['mlx_lm.server'] },
      deps(own.spawn, { LOCAL_LLM_URL: `http://127.0.0.1:${port}/v1` }),
    );
    const first = await host.forRun();
    expect(first.via).toBe('own');
    expect((await chat(first.url)).status).toBe(200);
    expect(host.server?.idleOwnServer()).toBe(true);
    await fakeServer(
      (req, _body, res) =>
        req.url === '/v1/models' ? json(res, 200, { data: [] }) : json(res, 404, {}),
      port,
    );
    expect(await host.forRun()).toMatchObject({ via: 'gateway', model: 'default' });
    expect(host.server?.idleOwnServer()).toBe(false); // stopped
    await host.close();
  });

  it('skips the gateway when the config turns it off or points elsewhere', async () => {
    const gw = await gateway();
    const own = await ownServer();
    const off = new LocalModelHost(
      { url: own.url, command: ['mlx_lm.server'], gateway: false },
      deps(own.spawn, { LOCAL_LLM_URL: gw.url }),
    );
    expect((await off.forRun()).via).toBe('own');
    await off.close();
    const other = await gateway();
    const elsewhere = new LocalModelHost(
      { url: own.url, command: ['mlx_lm.server'], gateway: other.url },
      deps(own.spawn, { LOCAL_LLM_URL: '' }),
    );
    expect(await elsewhere.forRun()).toEqual({ url: other.url, model: 'default', via: 'gateway' });
    await elsewhere.close();
  });

  it('uses a server you run yourself as it is, when there is no gateway and no command', async () => {
    const host = new LocalModelHost(
      { url: 'http://localhost:1234', model: 'qwen' },
      deps(
        () => {
          throw new Error('nothing to start');
        },
        { LOCAL_LLM_URL: '' },
      ),
    );
    expect(await host.forRun()).toEqual({
      url: 'http://localhost:1234/v1',
      model: 'qwen',
      via: 'yours',
    });
  });

  it("reads an old config with the shared endpoint's port, and no longer listens there", async () => {
    const own = await ownServer();
    const host = new LocalModelHost(
      { url: own.url, command: ['mlx_lm.server'], port: 8090, idleMinutes: 10 },
      deps(own.spawn, { LOCAL_LLM_URL: '' }),
    );
    const route = await host.forRun();
    expect(route.via).toBe('own');
    expect(new URL(route.url).port).not.toBe('8090');
    await host.close();
    expect('startSharedEndpoint' in localModel).toBe(false);
    expect('DEFAULT_SHARED_PORT' in localModel).toBe(false);
  });
});

describe('the fallback command', () => {
  it('binds 127.0.0.1 and turns thinking off, as the gateway contract has it', () => {
    expect(mlxServerCommand('/bin/mlx_lm.server', 'mlx-community/m', '8080')).toEqual([
      '/bin/mlx_lm.server',
      '--model',
      'mlx-community/m',
      '--host',
      '127.0.0.1',
      '--port',
      '8080',
      '--chat-template-args',
      '{"enable_thinking":false}',
    ]);
    expect(localModel.DEFAULT_LOCAL_MODEL_URL).toBe('http://127.0.0.1:8080/v1');
    expect(localModel.DEFAULT_IDLE_MINUTES).toBe(15);
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
