import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { createApp } from '../src/app.js';
import { migrate } from '../src/database/migrate.js';
import { loadConfig } from '../src/config.js';
import type { AIProvider, AIInput } from '../src/integrations/provider.js';
import { randomUUID } from 'node:crypto';
import { Repository } from '../src/models/repository.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { startServer } from '../src/server.js';
import Fastify from 'fastify';
import { streamResponse } from '../src/controllers/stream.js';
import { GenerationService } from '../src/services/generation.js';
class ControlledProvider implements AIProvider {
  inputs: AIInput[] = [];
  async *stream(input: AIInput, signal: AbortSignal): AsyncIterable<string> {
    this.inputs.push(input);
    if (signal.aborted) throw new Error('aborted');
    yield 'Hello';
    yield ' world';
  }
}
const provider = new ControlledProvider();
const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw new Error(
    'TEST_DATABASE_URL is required: real PostgreSQL integration tests must not silently skip',
  );
const pool = new Pool({ connectionString: url });
const config = loadConfig({ DATABASE_URL: url, APP_ORIGIN: 'http://gate.test' });
let app: Awaited<ReturnType<typeof createApp>>;
const origin = { origin: config.appOrigin };
describe('anonymous session and persistent history', () => {
  beforeAll(async () => {
    await migrate(pool);
    await pool.query('TRUNCATE messages, sessions CASCADE');
    app = await createApp({ pool, config, provider });
  });
  afterAll(async () => {
    await app?.close();
    await pool.end();
  });
  it('requires origin, preserves a session, and isolates its history', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/session' })).statusCode).toBe(403);
    const first = await app.inject({ method: 'POST', url: '/api/session', headers: origin });
    expect(first.statusCode).toBe(200);
    const cookie = first.headers['set-cookie'] as string;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    const token = cookie.split(';')[0]!;
    const again = await app.inject({
      method: 'POST',
      url: '/api/session',
      headers: { ...origin, cookie: token },
    });
    expect(again.json().id).toBe(first.json().id);
    expect((await app.inject({ url: '/api/messages' })).statusCode).toBe(401);
    const history = await app.inject({ url: '/api/messages', headers: { cookie: token } });
    expect(history.json().messages).toEqual([]);
    const stored = await pool.query<{ token_hash: string }>(
      'SELECT token_hash FROM sessions WHERE id=$1',
      [first.json().id],
    );
    expect(stored.rows[0]!.token_hash).not.toBe(token.split('=')[1]);
  });
  it('streams and saves both messages, replaying a request without duplication', async () => {
    const session = await app.inject({ method: 'POST', url: '/api/session', headers: origin });
    const cookie = (session.headers['set-cookie'] as string).split(';')[0]!;
    const payload = { content: '  Hi  ', requestId: randomUUID() };
    const response = await app.inject({
      method: 'POST',
      url: '/api/messages/stream',
      headers: { ...origin, cookie },
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/x-ndjson');
    const events = response.body
      .trim()
      .split('\n')
      .map(
        (line: string) =>
          JSON.parse(line) as { type: string; message?: { content: string; status: string } },
      );
    expect(events.map((e) => e.type)).toEqual(['start', 'delta', 'delta', 'done']);
    expect(events.at(-1)?.message).toMatchObject({ content: 'Hello world', status: 'complete' });
    expect(provider.inputs.at(-1)).toEqual([{ role: 'user', content: 'Hi' }]);
    const replay = await app.inject({
      method: 'POST',
      url: '/api/messages/stream',
      headers: { ...origin, cookie },
      payload,
    });
    expect(replay.statusCode).toBe(200);
    expect(provider.inputs).toHaveLength(1);
    const history = await app.inject({ url: '/api/messages', headers: { cookie } });
    expect(history.json().messages.map((m: { content: string }) => m.content)).toEqual([
      'Hi',
      'Hello world',
    ]);
  });
  it('recovers stale partials and retains expired sessions until message TTL cleanup', async () => {
    let now = new Date('2030-01-01T00:00:00.000Z');
    const repository = new Repository(pool, () => now);
    const created = await repository.createSession();
    const prepared = await repository.beginGeneration(created.session.id, {
      content: 'Hi',
      requestId: randomUUID(),
    });
    await repository.saveMessage(prepared.message.id, 'partial', 'generating');
    now = new Date(now.getTime() + 130000);
    expect(await repository.recoverStale(125000)).toBe(1);
    expect((await repository.history(created.session.id, null, 30)).messages.at(-1)).toMatchObject({
      status: 'interrupted',
      content: 'partial',
    });
    now = new Date('2030-01-01T01:00:00.000Z');
    expect(await repository.findSession(created.token)).toBeNull();
    await repository.cleanup();
    expect(
      (await pool.query('SELECT id FROM sessions WHERE id=$1', [created.session.id])).rowCount,
    ).toBe(1);
    now = new Date('2030-01-01T06:00:00.000Z');
    expect((await repository.history(created.session.id, null, 30)).messages).toEqual([]);
    await repository.cleanup();
    expect(
      (await pool.query('SELECT id FROM sessions WHERE id=$1', [created.session.id])).rowCount,
    ).toBe(0);
  });
  it('serves only the configured public build and does not turn unknown API routes into HTML', async () => {
    const root = await mkdtemp(
      join(process.env.TMPDIR ?? join(homedir(), '.hermes/cache/scratch'), 'gate-static-'),
    );
    await writeFile(join(root, 'index.html'), '<html>Gate test</html>');
    await writeFile(join(root, 'public.txt'), 'public asset');
    const staticApp = await createApp({
      pool,
      config: { ...config, production: true },
      staticRoot: root,
    });
    try {
      expect((await staticApp.inject({ url: '/' })).body).toContain('Gate test');
      expect((await staticApp.inject({ url: '/public.txt' })).body).toBe('public asset');
      const apiMissing = await staticApp.inject({ url: '/api/missing' });
      expect(apiMissing.statusCode).toBe(404);
      expect(apiMissing.json()).toHaveProperty('error.code', 'NOT_FOUND');
      const traversal = await staticApp.inject({ url: '/%2e%2e/%2e%2e/AGENTS.md' });
      expect(traversal.body).not.toContain('Данный проект');
      const session = await staticApp.inject({
        method: 'POST',
        url: '/api/session',
        headers: origin,
      });
      expect(session.headers['set-cookie']).toContain('Secure');
      expect(session.headers['cache-control']).toBe('no-store');
    } finally {
      await staticApp.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('uses the latest ten complete messages and paginates older history chronologically', async () => {
    const repository = new Repository(pool);
    const created = await repository.createSession();
    for (let i = 0; i < 7; i++) {
      const generated = await repository.beginGeneration(created.session.id, {
        content: `user-${i}`,
        requestId: randomUUID(),
      });
      await repository.saveMessage(
        generated.message.id,
        `assistant-${i}`,
        i === 6 ? 'error' : 'complete',
      );
    }
    const current = await repository.beginGeneration(created.session.id, {
      content: 'current',
      requestId: randomUUID(),
    });
    const history = await repository.history(created.session.id, null, 100);
    expect(current.input).toEqual(
      history.messages
        .filter((m) => m.status === 'complete')
        .slice(-10)
        .map((m) => ({ role: m.role, content: m.content })),
    );
    expect(current.input).toHaveLength(10);
    expect(current.input.at(-1)?.content).toBe('current');
    expect(current.input.some((m) => m.content === 'assistant-6')).toBe(false);
    await repository.saveMessage(current.message.id, 'done', 'complete');
    const cookie = `gate_session=${created.token}`;
    const latest = await app.inject({ url: '/api/messages?limit=3', headers: { cookie } });
    expect(latest.json().messages.map((m: { sequence: number }) => m.sequence)).toEqual([
      13, 14, 15,
    ]);
    const older = await app.inject({
      url: `/api/messages?limit=3&cursor=${latest.json().nextCursor}`,
      headers: { cookie },
    });
    expect(older.json().messages.map((m: { sequence: number }) => m.sequence)).toEqual([
      10, 11, 12,
    ]);
    const other = await repository.createSession();
    expect(
      (
        await app.inject({
          url: '/api/messages',
          headers: { cookie: `gate_session=${other.token}` },
        })
      ).json().messages,
    ).toEqual([]);
    expect(
      (await app.inject({ url: '/api/messages?cursor=-1', headers: { cookie } })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ url: '/api/messages?limit=101', headers: { cookie } })).statusCode,
    ).toBe(400);
  });
  it('serializes competing app instances without holding a database connection during AI work', async () => {
    const singlePool = new Pool({ connectionString: url, max: 1 });
    let start!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: AIProvider = {
      async *stream() {
        start();
        yield 'partial';
        await gate;
        yield ' end';
      },
    };
    const firstApp = await createApp({ pool: singlePool, config, provider: slow });
    const secondApp = await createApp({ pool: singlePool, config, provider: slow });
    try {
      const session = await firstApp.inject({
        method: 'POST',
        url: '/api/session',
        headers: origin,
      });
      const cookie = (session.headers['set-cookie'] as string).split(';')[0]!;
      const payload = { content: 'wait', requestId: randomUUID() };
      const first = firstApp.inject({
        method: 'POST',
        url: '/api/messages/stream',
        headers: { ...origin, cookie },
        payload,
      });
      await started;
      expect((await secondApp.inject({ url: '/api/health' })).statusCode).toBe(200);
      const competing = await secondApp.inject({
        method: 'POST',
        url: '/api/messages/stream',
        headers: { ...origin, cookie },
        payload: { ...payload, requestId: randomUUID() },
      });
      expect(competing.statusCode).toBe(409);
      expect(competing.json().error.code).toBe('GENERATION_IN_PROGRESS');
      const duplicate = await secondApp.inject({
        method: 'POST',
        url: '/api/messages/stream',
        headers: { ...origin, cookie },
        payload,
      });
      expect(duplicate.statusCode).toBe(409);
      release();
      expect((await first).statusCode).toBe(200);
      const conflict = await secondApp.inject({
        method: 'POST',
        url: '/api/messages/stream',
        headers: { ...origin, cookie },
        payload: { ...payload, content: 'different' },
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(
        (await singlePool.query('SELECT id FROM messages WHERE session_id=$1', [session.json().id]))
          .rowCount,
      ).toBe(2);
    } finally {
      release();
      await firstApp.close();
      await secondApp.close();
      await singlePool.end();
    }
  });
  it.each([false, true])('persists an error with partial output=%s', async (partial) => {
    const failing: AIProvider = {
      async *stream() {
        if (partial) yield 'saved partial';
        throw new Error('secret provider details must not leak');
      },
    };
    const failingApp = await createApp({ pool, config, provider: failing });
    try {
      const session = await failingApp.inject({
        method: 'POST',
        url: '/api/session',
        headers: origin,
      });
      const cookie = (session.headers['set-cookie'] as string).split(';')[0]!;
      const response = await failingApp.inject({
        method: 'POST',
        url: '/api/messages/stream',
        headers: { ...origin, cookie },
        payload: { content: 'Hi', requestId: randomUUID() },
      });
      expect(response.body).not.toContain('secret provider');
      const events = response.body
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { type: string; code?: string });
      expect(events.at(-1)).toMatchObject({ type: 'error', code: 'PROVIDER_ERROR' });
      const history = await failingApp.inject({ url: '/api/messages', headers: { cookie } });
      expect(history.json().messages.at(-1)).toMatchObject({
        content: partial ? 'saved partial' : '',
        status: 'error',
      });
    } finally {
      await failingApp.close();
    }
  });
  it('times out a stalled provider and keeps its partial result', async () => {
    let signal: AbortSignal | undefined;
    const stalled: AIProvider = {
      async *stream(_input, upstreamSignal) {
        signal = upstreamSignal;
        yield 'partial';
        await new Promise<void>(() => undefined);
      },
    };
    const timedApp = await createApp({
      pool,
      config: { ...config, generationTimeoutMs: 40, flushIntervalMs: 10 },
      provider: stalled,
    });
    try {
      const session = await timedApp.inject({
        method: 'POST',
        url: '/api/session',
        headers: origin,
      });
      const cookie = (session.headers['set-cookie'] as string).split(';')[0]!;
      const response = await timedApp.inject({
        method: 'POST',
        url: '/api/messages/stream',
        headers: { ...origin, cookie },
        payload: { content: 'Hi', requestId: randomUUID() },
      });
      expect(signal?.aborted).toBe(true);
      expect(response.body).toContain('GENERATION_TIMEOUT');
      const history = await timedApp.inject({ url: '/api/messages', headers: { cookie } });
      expect(history.json().messages.at(-1)).toMatchObject({
        content: 'partial',
        status: 'interrupted',
      });
    } finally {
      await timedApp.close();
    }
  });
  it('persists partials periodically and aborts upstream when the HTTP client disconnects', async () => {
    let signal: AbortSignal | undefined;
    const stalled: AIProvider = {
      async *stream(_input, upstreamSignal) {
        signal = upstreamSignal;
        yield 'disconnect partial';
        await new Promise<void>(() => undefined);
      },
    };
    const networkApp = await createApp({
      pool,
      config: { ...config, flushIntervalMs: 10 },
      provider: stalled,
    });
    const client = new AbortController();
    try {
      const address = await networkApp.listen({ host: '127.0.0.1', port: 0 });
      const session = await networkApp.inject({
        method: 'POST',
        url: '/api/session',
        headers: origin,
      });
      const cookie = (session.headers['set-cookie'] as string).split(';')[0]!;
      const response = await fetch(address + '/api/messages/stream', {
        method: 'POST',
        headers: { ...origin, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'Hi', requestId: randomUUID() }),
        signal: client.signal,
      });
      const reader = response.body!.getReader();
      let received = '';
      while (!received.includes('disconnect partial'))
        received += new TextDecoder().decode((await reader.read()).value);
      await vi.waitFor(async () => {
        const rows = await pool.query<{ content: string; status: string }>(
          "SELECT content,status FROM messages WHERE session_id=$1 AND role='assistant'",
          [session.json().id],
        );
        expect(rows.rows[0]).toMatchObject({ content: 'disconnect partial', status: 'generating' });
      });
      client.abort();
      await reader.cancel().catch(() => undefined);
      await vi.waitFor(async () => {
        expect(signal?.aborted).toBe(true);
        const rows = await pool.query<{ content: string; status: string }>(
          "SELECT content,status FROM messages WHERE session_id=$1 AND role='assistant'",
          [session.json().id],
        );
        expect(rows.rows[0]).toMatchObject({
          content: 'disconnect partial',
          status: 'interrupted',
        });
      });
    } finally {
      client.abort();
      await networkApp.close();
    }
  });
  it('boots the real server with database migrations and shuts its owned pool down', async () => {
    const server = await startServer({
      config: { ...config, host: '127.0.0.1', port: 0 },
      provider,
    });
    try {
      const response = await fetch(server.address + '/api/health');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok' });
    } finally {
      await server.app.close();
    }
    await expect(server.pool.query('SELECT 1')).rejects.toThrow();
  });
  it('does not overwrite a completed message if disconnect wins just after final persistence', async () => {
    const repository = new Repository(pool);
    const session = await repository.createSession();
    const active = new Set<AbortController>();
    const original = repository.saveMessage.bind(repository);
    const save = vi
      .spyOn(repository, 'saveMessage')
      .mockImplementation(async (id, content, status) => {
        const message = await original(id, content, status);
        if (status === 'complete')
          for (const controller of active) controller.abort(new Error('CLIENT_DISCONNECTED'));
        return message;
      });
    const regressionApp = Fastify();
    regressionApp.post('/', async (_request, reply) => {
      await streamResponse(
        reply,
        new GenerationService(repository, provider),
        config,
        session.session.id,
        { content: 'Hi', requestId: randomUUID() },
        active,
      );
    });
    try {
      await regressionApp.inject({ method: 'POST', url: '/' });
      expect(save.mock.calls.map((call) => call[2])).toEqual(['complete']);
      expect((await repository.history(session.session.id, null, 30)).messages.at(-1)?.status).toBe(
        'complete',
      );
      expect(active.size).toBe(0);
    } finally {
      save.mockRestore();
      await regressionApp.close();
    }
  });
  it('ends the stream safely when persisting both terminal states fails', async () => {
    const repository = new Repository(pool);
    const session = await repository.createSession();
    const active = new Set<AbortController>();
    const save = vi
      .spyOn(repository, 'saveMessage')
      .mockRejectedValue(new Error('private database failure'));
    const regressionApp = Fastify();
    regressionApp.post('/', async (_request, reply) => {
      await streamResponse(
        reply,
        new GenerationService(repository, provider),
        config,
        session.session.id,
        { content: 'Hi', requestId: randomUUID() },
        active,
      );
    });
    try {
      const response = await regressionApp.inject({ method: 'POST', url: '/' });
      expect(response.body).toContain('PERSISTENCE_ERROR');
      expect(response.body).not.toContain('private database failure');
      expect(active.size).toBe(0);
      expect((await repository.history(session.session.id, null, 30)).messages.at(-1)?.status).toBe(
        'generating',
      );
    } finally {
      save.mockRestore();
      await regressionApp.close();
    }
  });
  it('returns an actionable safe Russian error when the AI key is missing', async () => {
    const missingKeyApp = await createApp({ pool, config: { ...config, apiKey: undefined } });
    try {
      const session = await missingKeyApp.inject({
        method: 'POST',
        url: '/api/session',
        headers: origin,
      });
      const cookie = (session.headers['set-cookie'] as string).split(';')[0]!;
      const response = await missingKeyApp.inject({
        method: 'POST',
        url: '/api/messages/stream',
        headers: { ...origin, cookie },
        payload: { content: 'Hi', requestId: randomUUID() },
      });
      expect(response.body).toContain('AI_NOT_CONFIGURED');
      expect(response.body).toContain('OPENAI_API_KEY');
      expect(response.body).toContain('Администратор');
    } finally {
      await missingKeyApp.close();
    }
  });
  it('waits for interrupted persistence before application close completes', async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const stalled: AIProvider = {
      async *stream() {
        started();
        yield 'shutdown partial';
        await new Promise<void>(() => undefined);
      },
    };
    let persisted = false;
    const original = Repository.prototype.saveMessage;
    const save = vi.spyOn(Repository.prototype, 'saveMessage').mockImplementation(async function (
      this: Repository,
      id,
      content,
      status,
    ) {
      if (status === 'interrupted') await new Promise<void>((resolve) => setTimeout(resolve, 30));
      const result = await original.call(this, id, content, status);
      if (status === 'interrupted') persisted = true;
      return result;
    });
    const shuttingApp = await createApp({ pool, config, provider: stalled });
    const session = await shuttingApp.inject({
      method: 'POST',
      url: '/api/session',
      headers: origin,
    });
    const cookie = (session.headers['set-cookie'] as string).split(';')[0]!;
    const response = shuttingApp.inject({
      method: 'POST',
      url: '/api/messages/stream',
      headers: { ...origin, cookie },
      payload: { content: 'Hi', requestId: randomUUID() },
    });
    try {
      await ready;
      await shuttingApp.close();
      expect(persisted).toBe(true);
    } finally {
      await shuttingApp.close();
      await response;
      save.mockRestore();
    }
  });
  it('interrupts a generation whose preparation completes after shutdown begins', async () => {
    let prepared!: () => void;
    const ready = new Promise<void>((resolve) => {
      prepared = resolve;
    });
    const original = GenerationService.prototype.begin;
    const begin = vi.spyOn(GenerationService.prototype, 'begin').mockImplementation(async function (
      this: GenerationService,
      id,
      payload,
    ) {
      const result = await original.call(this, id, payload);
      prepared();
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      return result;
    });
    const localProvider = new ControlledProvider();
    const shuttingApp = await createApp({ pool, config, provider: localProvider });
    const session = await shuttingApp.inject({
      method: 'POST',
      url: '/api/session',
      headers: origin,
    });
    const cookie = (session.headers['set-cookie'] as string).split(';')[0]!;
    const response = shuttingApp.inject({
      method: 'POST',
      url: '/api/messages/stream',
      headers: { ...origin, cookie },
      payload: { content: 'Hi', requestId: randomUUID() },
    });
    try {
      await ready;
      await shuttingApp.close();
      await response;
      expect(localProvider.inputs).toHaveLength(0);
      const rows = await pool.query<{ status: string }>(
        "SELECT status FROM messages WHERE session_id=$1 AND role='assistant'",
        [session.json().id],
      );
      expect(rows.rows[0]?.status).toBe('interrupted');
    } finally {
      await shuttingApp.close();
      await response;
      begin.mockRestore();
    }
  });
  it('rejects malformed input and client session IDs but accepts maximum-length escaped JSON', async () => {
    const session = await app.inject({ method: 'POST', url: '/api/session', headers: origin });
    const cookie = (session.headers['set-cookie'] as string).split(';')[0]!;
    for (const payload of [
      { content: ' ', requestId: randomUUID() },
      { content: 'x'.repeat(16001), requestId: randomUUID() },
      { content: 'Hi', requestId: 'bad' },
      null,
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/messages/stream',
        headers: { ...origin, cookie, 'content-type': 'application/json' },
        payload: JSON.stringify(payload),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('INVALID_REQUEST');
    }
    const bypass = await app.inject({
      method: 'POST',
      url: '/api/messages/stream',
      headers: origin,
      payload: { content: 'Hi', requestId: randomUUID(), sessionId: session.json().id },
    });
    expect(bypass.statusCode).toBe(401);
    expect(bypass.json().error.code).toBe('SESSION_EXPIRED');
    const escaped =
      '{"content":"' + '\\u0061'.repeat(16000) + '","requestId":"' + randomUUID() + '"}';
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/messages/stream',
      headers: { ...origin, cookie, 'content-type': 'application/json' },
      payload: escaped,
    });
    expect(accepted.statusCode).toBe(200);
    const tooLarge = await app.inject({
      method: 'POST',
      url: '/api/messages/stream',
      headers: { ...origin, cookie, 'content-type': 'application/json' },
      payload: 'x'.repeat(100001),
    });
    expect(tooLarge.statusCode).toBe(413);
    const rejectedOrigin = await app.inject({
      method: 'POST',
      url: '/api/messages/stream',
      headers: { origin: 'https://attacker.test', cookie },
      payload: { content: 'Hi', requestId: randomUUID() },
    });
    expect(rejectedOrigin.statusCode).toBe(403);
  });
  it('rate limits anonymous session creation with the shared error contract', async () => {
    const limitedApp = await createApp({ pool, config });
    try {
      for (let i = 0; i < 30; i++)
        expect(
          (await limitedApp.inject({ method: 'POST', url: '/api/session', headers: origin }))
            .statusCode,
        ).toBe(200);
      const rejected = await limitedApp.inject({
        method: 'POST',
        url: '/api/session',
        headers: origin,
      });
      expect(rejected.statusCode).toBe(429);
      expect(rejected.json().error.code).toBe('RATE_LIMITED');
    } finally {
      await limitedApp.close();
    }
  });
});
