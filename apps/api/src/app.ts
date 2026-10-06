import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { Pool } from 'pg';
import type { Config } from './config.js';
import { ApiFailure, Repository } from './models/repository.js';
import type { AIProvider } from './integrations/provider.js';
import { OpenAIProvider } from './integrations/openai.js';
import { GenerationService } from './services/generation.js';
import { registerApiRoutes } from './routes/api.js';
import { startMaintenance } from './services/maintenance.js';
export interface AppOptions {
  pool: Pool;
  config: Config;
  now?: () => Date;
  provider?: AIProvider;
  staticRoot?: string;
}
export async function createApp(options: AppOptions) {
  const { pool, config } = options;
  const repository = new Repository(pool, options.now);
  const service = new GenerationService(repository, options.provider ?? new OpenAIProvider(config));
  const active = new Set<AbortController>();
  const generations = new Set<Promise<void>>();
  const app = Fastify({ bodyLimit: 100000, logger: false, trustProxy: false });
  await app.register(cookie);
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  app.setErrorHandler((error, _request, reply) => {
    const failure = error instanceof ApiFailure ? error : null;
    const errorStatus =
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : 500;
    const status =
      failure?.statusCode ?? (errorStatus >= 400 && errorStatus < 500 ? errorStatus : 500);
    void reply.code(status).send({
      error: {
        code:
          failure?.code ??
          (status === 429 ? 'RATE_LIMITED' : status < 500 ? 'INVALID_REQUEST' : 'INTERNAL_ERROR'),
        message:
          failure?.message ??
          (status < 500 ? 'Запрос отклонён.' : 'Ошибка сервера. Попробуйте ещё раз.'),
      },
    });
  });
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff').header('referrer-policy', 'same-origin');
    if (
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) &&
      request.headers.origin !== config.appOrigin
    )
      throw new ApiFailure(403, 'INVALID_ORIGIN', 'Источник запроса не разрешён.');
  });
  registerApiRoutes(app, pool, config, repository, service, active, generations);
  let maintenance: ReturnType<typeof startMaintenance> | undefined;
  app.addHook('onReady', async () => {
    const staleMs = config.generationTimeoutMs + 5000;
    await repository.recoverStale(staleMs);
    maintenance = startMaintenance(repository, staleMs, () =>
      app.log.error('Database maintenance failed'),
    );
  });
  app.addHook('onClose', async () => {
    await maintenance?.stop();
  });
  app.addHook('preClose', async () => {
    for (const controller of active) controller.abort(new Error('SERVER_SHUTDOWN'));
    await Promise.allSettled([...generations]);
  });
  if (options.staticRoot)
    await app.register(fastifyStatic, {
      root: options.staticRoot,
      index: ['index.html'],
      dotfiles: 'deny',
    });
  app.setNotFoundHandler((request, reply) => {
    if (
      options.staticRoot &&
      request.method === 'GET' &&
      !request.url.startsWith('/api/') &&
      !request.url.includes('.')
    )
      return reply.sendFile('index.html');
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Маршрут не найден.' } });
  });
  return app;
}
