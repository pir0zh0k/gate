import { apiErrorSchema, historySchema, sessionSchema, type SendMessage } from '@gate/contracts';
export class ApiFailure extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiFailure';
  }
}
async function checked(response: Response): Promise<Response> {
  if (response.ok) return response;
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new ApiFailure('NETWORK', 'Сервер недоступен. Попробуйте ещё раз.');
  }
  const result = apiErrorSchema.safeParse(value);
  throw result.success
    ? new ApiFailure(result.data.error.code, result.data.error.message)
    : new ApiFailure('NETWORK', 'Не удалось выполнить запрос. Попробуйте ещё раз.');
}
export async function createSession(signal: AbortSignal) {
  const response = await checked(
    await fetch('/api/session', { method: 'POST', credentials: 'same-origin', signal }),
  );
  const value: unknown = await response.json();
  return sessionSchema.parse(value);
}
export async function fetchHistory(signal: AbortSignal, cursor?: string) {
  const response = await checked(
    await fetch(`/api/messages${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, {
      credentials: 'same-origin',
      signal,
    }),
  );
  const value: unknown = await response.json();
  return historySchema.parse(value);
}
export async function postMessage(body: SendMessage, signal: AbortSignal) {
  return checked(
    await fetch('/api/messages/stream', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body: JSON.stringify(body),
      signal,
    }),
  );
}
