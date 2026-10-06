import { describe, expect, it } from 'vitest';
import { readCache, writeCache, CACHE_KEY } from './cache';
const session = {
  id: '00000000-0000-4000-8000-000000000001',
  expiresAt: '2030-01-01T01:00:00.000Z',
  serverTime: '2030-01-01T00:00:00.000Z',
};
const message = {
  id: '00000000-0000-4000-8000-000000000002',
  sessionId: session.id,
  sequence: 0,
  role: 'user' as const,
  status: 'complete' as const,
  content: 'Текст',
  createdAt: session.serverTime,
  expiresAt: '2030-01-01T06:00:00.000Z',
};
function storage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}
describe('authenticated history cache', () => {
  it('roundtrips validated messages for the authenticated session only', () => {
    const store = storage();
    writeCache(store, session, [message]);
    expect(readCache(store, session, Date.parse(session.serverTime))).toEqual([message]);
  });
});

it('clears expired, malformed, foreign and wrong-version cache', () => {
  const store = storage();
  const now = Date.parse(session.serverTime);
  for (const raw of [
    'broken',
    JSON.stringify({ version: 2, session, messages: [message] }),
    JSON.stringify({ version: 1, session: { ...session, id: message.id }, messages: [message] }),
  ]) {
    store.setItem(CACHE_KEY, raw);
    expect(readCache(store, session, now)).toEqual([]);
    expect(store.getItem(CACHE_KEY)).toBeNull();
  }
  writeCache(store, session, [message]);
  expect(readCache(store, session, Date.parse(session.expiresAt))).toEqual([]);
  expect(store.getItem(CACHE_KEY)).toBeNull();
});
it('removes messages that have reached their six-hour history TTL', () => {
  const store = storage();
  writeCache(store, session, [{ ...message, expiresAt: session.serverTime }]);
  expect(readCache(store, session, Date.parse(session.serverTime))).toEqual([]);
});
it('survives denied storage', () => {
  const denied = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('denied');
    },
    removeItem: () => {
      throw new Error('denied');
    },
  };
  expect(readCache(denied, session, 0)).toEqual([]);
  expect(() => writeCache(denied, session, [message])).not.toThrow();
});
it('does not present a cached generating response as a live server stream', () => {
  const store = storage();
  writeCache(store, session, [{ ...message, role: 'assistant', status: 'generating' }]);
  expect(readCache(store, session, Date.parse(session.serverTime))[0]?.status).toBe('interrupted');
});
