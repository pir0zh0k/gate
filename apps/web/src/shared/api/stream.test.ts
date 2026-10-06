import { expect, it } from 'vitest';
import { consumeStream } from './stream';
import type { StreamEvent } from '@gate/contracts';
const id = '00000000-0000-4000-8000-000000000002';
const message = {
  id,
  sessionId: '00000000-0000-4000-8000-000000000001',
  sequence: 1,
  role: 'assistant',
  content: 'Привет 🌿',
  status: 'complete',
  createdAt: '2030-01-01T00:00:00Z',
  expiresAt: '2030-01-01T06:00:00Z',
};
function body(text: string) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
}
it('decodes fragmented UTF8 and final unterminated NDJSON line', async () => {
  const events: StreamEvent[] = [];
  await consumeStream(
    body(
      JSON.stringify({
        type: 'start',
        message: { ...message, content: '', status: 'generating' },
      }) +
        '\n' +
        JSON.stringify({ type: 'delta', messageId: id, text: 'Привет 🌿' }) +
        '\n' +
        JSON.stringify({ type: 'done', message }),
    ),
    (event) => events.push(event),
  );
  expect(events.map((event) => event.type)).toEqual(['start', 'delta', 'done']);
  expect(events[1]).toMatchObject({ text: 'Привет 🌿' });
});
it('rejects EOF without terminal event', async () => {
  await expect(
    consumeStream(
      body(JSON.stringify({ type: 'start', message: { ...message, status: 'generating' } }) + '\n'),
      () => {},
    ),
  ).rejects.toThrow('Поток прерван');
});

it('rejects a delta before start instead of silently losing response text', async () => {
  await expect(
    consumeStream(
      body(
        JSON.stringify({ type: 'delta', messageId: id, text: 'lost' }) +
          '\n' +
          JSON.stringify({ type: 'done', message }),
      ),
      () => {},
    ),
  ).rejects.toThrow('порядок');
});

it('validates every external event as unknown and rejects malformed JSON and schemas', async () => {
  for (const text of [
    '{bad}\n',
    '{"type":"delta","messageId":"invalid","text":"x"}\n',
    '{"type":"unknown"}\n',
    '{"type":"start"}\n',
  ])
    await expect(consumeStream(body(text), () => {})).rejects.toThrow();
});
it('accepts a terminal provider error before start and delivers the server partial when present', async () => {
  const events: StreamEvent[] = [];
  await consumeStream(
    body(
      JSON.stringify({
        type: 'error',
        code: 'PROVIDER_ERROR',
        message: 'unavailable',
        partial: { ...message, status: 'error' },
      }),
    ),
    (event) => events.push(event),
  );
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: 'error', partial: { status: 'error' } });
});
it('rejects a truncated JSON tail and incomplete UTF8 rather than displaying corrupt text', async () => {
  await expect(consumeStream(body('{"type":'), () => {})).rejects.toThrow();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0xf0, 0x9f]));
      controller.close();
    },
  });
  await expect(consumeStream(stream, () => {})).rejects.toThrow();
});
