import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../config.js';
import { ApiFailure, type Repository } from '../models/repository.js';
import type { GenerationService } from '../services/generation.js';
import { streamResponse } from '../controllers/stream.js';
export function registerApiRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: Config,
  repository: Repository,
  service: GenerationService,
  active: Set<AbortController>,
  generations: Set<Promise<void>>,
): void {
  app.post(
    '/api/session',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const existing = await repository.findSession(request.cookies.gate_session);
      if (existing) return existing;
      const created = await repository.createSession();
      reply.setCookie('gate_session', created.token, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: config.production,
        maxAge: 3600,
      });
      return created.session;
    },
  );
  app.get('/api/messages', async (request) => {
    const session = await repository.findSession(request.cookies.gate_session);
    if (!session)
      throw new ApiFailure(401, 'SESSION_EXPIRED', 'Сессия истекла. Начните новый диалог.');
    const query = request.query;
    if (!query || typeof query !== 'object' || Array.isArray(query))
      throw new ApiFailure(400, 'INVALID_REQUEST', 'Некорректные параметры запроса.');
    const cursor = 'cursor' in query ? query.cursor : undefined;
    if (
      cursor !== undefined &&
      (typeof cursor !== 'string' ||
        !/^(0|[1-9]\d{0,9})$/.test(cursor) ||
        Number(cursor) > 2147483647)
    )
      throw new ApiFailure(400, 'INVALID_REQUEST', 'Некорректный указатель страницы.');
    const rawLimit = 'limit' in query ? query.limit : undefined;
    if (
      rawLimit !== undefined &&
      (typeof rawLimit !== 'string' ||
        !/^\d{1,3}$/.test(rawLimit) ||
        Number(rawLimit) < 1 ||
        Number(rawLimit) > 100)
    )
      throw new ApiFailure(400, 'INVALID_REQUEST', 'Размер страницы должен быть от 1 до 100.');
    return {
      session,
      ...(await repository.history(
        session.id,
        cursor === undefined ? null : Number(cursor),
        rawLimit === undefined ? 30 : Number(rawLimit),
      )),
    };
  });
  app.post(
    '/api/messages/stream',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const session = await repository.findSession(request.cookies.gate_session);
      if (!session)
        throw new ApiFailure(401, 'SESSION_EXPIRED', 'Сессия истекла. Начните новый диалог.');
      const generation = streamResponse(reply, service, config, session.id, request.body, active);
      generations.add(generation);
      try {
        await generation;
      } finally {
        generations.delete(generation);
      }
    },
  );
  app.get('/api/health', async (_request, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({
        error: {
          code: 'DATABASE_UNAVAILABLE',
          message: 'История временно недоступна. Попробуйте ещё раз.',
        },
      });
    }
  });
}
