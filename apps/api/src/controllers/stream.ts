import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import type { FastifyReply } from 'fastify';
import { sendMessageSchema, type StreamEvent } from '@gate/contracts';
import { ApiFailure } from '../models/repository.js';
import type { GenerationService } from '../services/generation.js';
import type { Config } from '../config.js';
import { ProviderConfigurationError } from '../integrations/provider.js';
export function parseSend(body: unknown) {
  const parsed = sendMessageSchema.safeParse(body);
  if (!parsed.success)
    throw new ApiFailure(
      400,
      'INVALID_REQUEST',
      'Введите от 1 до 16000 символов и корректный requestId.',
    );
  return parsed.data;
}
export async function streamResponse(
  reply: FastifyReply,
  service: GenerationService,
  config: Config,
  sessionId: string,
  body: unknown,
  active: Set<AbortController>,
): Promise<void> {
  const controller = new AbortController();
  const { signal } = controller;
  active.add(controller);
  let prepared: Awaited<ReturnType<GenerationService['begin']>>;
  try {
    prepared = await service.begin(sessionId, parseSend(body));
  } catch (error) {
    active.delete(controller);
    throw error;
  }
  const output = new PassThrough();
  let finished = false;
  output.on('close', () => {
    if (!finished) controller.abort(new Error('CLIENT_DISCONNECTED'));
  });
  reply
    .header('content-type', 'application/x-ndjson; charset=utf-8')
    .header('cache-control', 'no-store')
    .header('x-accel-buffering', 'no');
  void reply.send(output);
  const write = async (event: StreamEvent): Promise<void> => {
    signal.throwIfAborted();
    if (!output.write(JSON.stringify(event) + '\n')) await once(output, 'drain', { signal });
  };
  let content = prepared.message.content;
  let flushPromise: Promise<void> = Promise.resolve();
  let persistenceError: unknown;
  let finalized = false;
  const timeout = setTimeout(
    () => controller.abort(new Error('GENERATION_TIMEOUT')),
    config.generationTimeoutMs,
  );
  const flush = setInterval(() => {
    if (prepared.replay) return;
    flushPromise = flushPromise
      .then(async () => {
        await service.save(prepared.message.id, content, 'generating');
      })
      .catch((error) => {
        persistenceError = error;
        controller.abort(new Error('PERSISTENCE_ERROR'));
      });
  }, config.flushIntervalMs);
  try {
    await write({ type: 'start', message: prepared.message });
    if (prepared.replay) {
      if (prepared.message.status === 'complete')
        await write({ type: 'done', message: prepared.message });
      else
        await write({
          type: 'error',
          code: 'GENERATION_INTERRUPTED',
          message: 'Предыдущий ответ был прерван. Отправьте новый запрос.',
          partial: prepared.message,
        });
    } else {
      const iterator = service.generate(prepared.input, signal)[Symbol.asyncIterator]();
      try {
        while (true) {
          const step = await abortable(iterator.next(), signal);
          if (step.done) break;
          content += step.value;
          if (content.length > 200000) throw new Error('OUTPUT_LIMIT');
          await write({ type: 'delta', messageId: prepared.message.id, text: step.value });
        }
      } finally {
        void iterator.return?.().catch(() => undefined);
      }
      clearInterval(flush);
      await flushPromise;
      if (persistenceError) throw persistenceError;
      const message = await service.save(prepared.message.id, content, 'complete');
      finalized = true;
      await write({ type: 'done', message });
    }
  } catch (error) {
    clearInterval(flush);
    await flushPromise;
    if (!prepared.replay && !finalized) {
      const reason = signal.reason instanceof Error ? signal.reason.message : '';
      const interrupted = signal.aborted;
      let event: StreamEvent;
      try {
        const message = await service.save(
          prepared.message.id,
          content,
          interrupted ? 'interrupted' : 'error',
        );
        finalized = true;
        event = {
          type: 'error',
          code:
            reason === 'GENERATION_TIMEOUT'
              ? 'GENERATION_TIMEOUT'
              : error instanceof ProviderConfigurationError
                ? error.code
                : 'PROVIDER_ERROR',
          message:
            reason === 'GENERATION_TIMEOUT'
              ? 'Ответ не успел завершиться. Попробуйте отправить запрос ещё раз.'
              : error instanceof ProviderConfigurationError
                ? error.message
                : 'Не удалось получить ответ ИИ. Попробуйте ещё раз.',
          partial: message,
        };
      } catch {
        // The DB remains the source of truth: never report unsaved content as persisted.
        reply.log.error('Generation persistence failed');
        event = {
          type: 'error',
          code: 'PERSISTENCE_ERROR',
          message: 'Не удалось сохранить ответ. Обновите историю после восстановления соединения.',
        };
      }
      if (
        !output.destroyed &&
        (!signal.aborted || reason === 'GENERATION_TIMEOUT' || reason === 'PERSISTENCE_ERROR')
      ) {
        try {
          output.write(JSON.stringify(event) + '\n');
        } catch {
          /* Client may have disconnected concurrently. */
        }
      }
    }
  } finally {
    clearTimeout(timeout);
    clearInterval(flush);
    active.delete(controller);
    finished = true;
    output.end();
  }
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
