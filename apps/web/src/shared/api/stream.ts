import { streamEventSchema, type StreamEvent } from '@gate/contracts';
export async function consumeStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let terminal = false;
  let messageId: string | null = null;
  const emit = (line: string) => {
    if (!line.trim()) return;
    const value: unknown = JSON.parse(line);
    const event = streamEventSchema.parse(value);
    if (event.type === 'start') {
      if (messageId || event.message.role !== 'assistant')
        throw new Error('Неверный порядок событий потока');
      messageId = event.message.id;
    }
    if (
      (event.type === 'delta' && event.messageId !== messageId) ||
      (event.type === 'done' && event.message.id !== messageId)
    )
      throw new Error('Неверный порядок событий потока');
    if (event.type === 'done' || event.type === 'error') terminal = true;
    onEvent(event);
  };
  try {
    while (!terminal) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 2_000_000) throw new Error('Слишком большое событие потока');
      let newline = buffer.indexOf('\n');
      while (newline !== -1 && !terminal) {
        emit(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    }
    if (!terminal) {
      buffer += decoder.decode();
      emit(buffer);
    }
    if (!terminal) throw new Error('Поток прерван. Частичный ответ сохранён.');
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* A disconnected transport is already closed. */
    }
    reader.releaseLock();
  }
}
