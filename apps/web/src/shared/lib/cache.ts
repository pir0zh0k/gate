import { messageSchema, sessionSchema, type Message, type Session } from '@gate/contracts';
export const CACHE_KEY = 'gate.history.v1';
export interface CacheStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export function readCache(storage: CacheStorage, session: Session, now: number): Message[] {
  try {
    const raw = storage.getItem(CACHE_KEY);
    if (!raw) return [];
    const value: unknown = JSON.parse(raw);
    if (
      !value ||
      typeof value !== 'object' ||
      !('version' in value) ||
      value.version !== 1 ||
      !('session' in value) ||
      !('messages' in value)
    )
      throw new Error('Invalid cache');
    const cachedSession = sessionSchema.parse(value.session);
    if (
      cachedSession.id !== session.id ||
      Date.parse(session.expiresAt) <= now ||
      Date.parse(cachedSession.expiresAt) <= now
    )
      throw new Error('Expired cache');
    return messageSchema
      .array()
      .parse(value.messages)
      .filter((message) => message.sessionId === session.id && Date.parse(message.expiresAt) > now)
      .map((message) =>
        message.status === 'generating' ? { ...message, status: 'interrupted' } : message,
      );
  } catch {
    clearCache(storage);
    return [];
  }
}
export function writeCache(storage: CacheStorage, session: Session, messages: Message[]): void {
  try {
    storage.setItem(CACHE_KEY, JSON.stringify({ version: 1, session, messages }));
  } catch {
    /* Storage is an optional optimization. */
  }
}
export function clearCache(storage: CacheStorage): void {
  try {
    storage.removeItem(CACHE_KEY);
  } catch {
    /* Denied storage must not block chat. */
  }
}
