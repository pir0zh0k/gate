import { messageSchema } from '@gate/contracts';
// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useChat } from './useChat';
const session = {
  id: '00000000-0000-4000-8000-000000000001',
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  serverTime: new Date().toISOString(),
};
const user = {
  id: '00000000-0000-4000-8000-000000000002',
  sessionId: session.id,
  sequence: 0,
  role: 'user',
  content: 'Привет',
  status: 'complete',
  createdAt: session.serverTime,
  expiresAt: new Date(Date.now() + 21600000).toISOString(),
};
const assistant = {
  ...user,
  id: '00000000-0000-4000-8000-000000000003',
  sequence: 1,
  role: 'assistant',
  content: 'Здравствуйте',
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('authenticates, streams one response and reconciles server messages without optimistic duplicates', async () => {
  let sent = false;
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/session') return Response.json(session);
    if (url === '/api/messages/stream') {
      sent = true;
      return new Response(
        [
          JSON.stringify({
            type: 'start',
            message: { ...assistant, content: '', status: 'generating' },
          }),
          JSON.stringify({ type: 'delta', messageId: assistant.id, text: assistant.content }),
          JSON.stringify({ type: 'done', message: assistant }),
        ].join('\n'),
        { headers: { 'Content-Type': 'application/x-ndjson' } },
      );
    }
    return Response.json({ session, messages: sent ? [user, assistant] : [], nextCursor: null });
  });
  vi.stubGlobal('fetch', fetcher);
  const { result } = renderHook(() => useChat());
  await waitFor(() => expect(result.current.ready).toBe(true));
  act(() => result.current.setDraft('Привет'));
  await act(async () => {
    await result.current.send();
  });
  expect(result.current.messages).toHaveLength(2);
  expect(result.current.messages[1]?.content).toBe('Здравствуйте');
  expect(result.current.busy).toBe(false);
  expect(result.current.draft).toBe('');
  expect(fetcher).toHaveBeenCalledWith(
    '/api/session',
    expect.objectContaining({ credentials: 'same-origin' }),
  );
});

it('blocks sending until a delayed history sync completes without losing the draft or fresh messages', async () => {
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let historyRequests = 0;
  let streamRequests = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/session') return Response.json(session);
      if (String(input) === '/api/messages/stream') {
        streamRequests += 1;
        return new Response(
          JSON.stringify({
            type: 'start',
            message: { ...assistant, content: '', status: 'generating' },
          }) +
            '\n' +
            JSON.stringify({ type: 'done', message: assistant }),
        );
      }
      historyRequests += 1;
      if (historyRequests === 2) {
        await pending;
        return Response.json({ session, messages: [], nextCursor: null });
      }
      return Response.json({
        session,
        messages: streamRequests ? [user, assistant] : [],
        nextCursor: null,
      });
    }),
  );
  const { result } = renderHook(() => useChat());
  await waitFor(() => expect(result.current.ready).toBe(true));
  act(() => result.current.setDraft('Привет'));
  let syncTask: Promise<void> | undefined;
  let sendTask: Promise<void> | undefined;
  act(() => {
    syncTask = result.current.sync();
    sendTask = result.current.send();
  });
  await act(async () => {
    await sendTask;
  });
  const streamsDuringSync = streamRequests;
  const draftDuringSync = result.current.draft;
  await act(async () => {
    release?.();
    await syncTask;
  });
  expect(streamsDuringSync).toBe(0);
  expect(draftDuringSync).toBe('Привет');
  expect(result.current.draft).toBe('Привет');
  expect(result.current.syncing).toBe(false);
  await act(async () => {
    await result.current.send();
  });
  expect(streamRequests).toBe(1);
  expect(result.current.messages.map((message) => message.id)).toEqual([user.id, assistant.id]);
  expect(result.current.draft).toBe('');
});

it.each(['sync', 'send'] as const)(
  'rejects same-tick sync while %s is in flight',
  async (operation) => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let historyRequests = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === '/api/session') return Response.json(session);
        if (String(input) === '/api/messages/stream') {
          await pending;
          return new Response(JSON.stringify({ type: 'done', message: assistant }));
        }
        historyRequests += 1;
        if (historyRequests > 1) await pending;
        return Response.json({ session, messages: [], nextCursor: null });
      }),
    );
    const { result } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.setDraft('Привет'));
    let first: Promise<void> | undefined;
    let duplicate: Promise<void> | undefined;
    act(() => {
      first = result.current[operation]();
      duplicate = result.current.sync();
    });
    const requestsDuringOperation = historyRequests;
    await act(async () => {
      release?.();
      await Promise.all([first, duplicate]);
    });
    expect(requestsDuringOperation).toBe(operation === 'sync' ? 2 : 1);
    expect(result.current.busy).toBe(false);
    expect(result.current.syncing).toBe(false);
  },
);

it('clears history and draft at fixed server expiry even with client clock skew', async () => {
  vi.useFakeTimers();
  const server = new Date('2030-01-01T00:00:00.000Z');
  const shortSession = {
    ...session,
    serverTime: server.toISOString(),
    expiresAt: new Date(server.getTime() + 1000).toISOString(),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      Response.json(
        String(input) === '/api/session'
          ? shortSession
          : { session: shortSession, messages: [user], nextCursor: null },
      ),
    ),
  );
  const { result } = renderHook(() => useChat());
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(result.current.ready).toBe(true);
  act(() => result.current.setDraft('Черновик'));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1001);
  });
  expect(result.current.ready).toBe(false);
  expect(result.current.messages).toEqual([]);
  expect(result.current.draft).toBe('');
  expect(result.current.notice).toContain('Сессия завершилась');
});

it('keeps partial text when stop races with a stale generating history snapshot', async () => {
  let sending = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/session') return Response.json(session);
      if (String(input) === '/api/messages/stream') {
        sending = true;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                JSON.stringify({
                  type: 'start',
                  message: { ...assistant, content: '', status: 'generating' },
                }) +
                  '\n' +
                  JSON.stringify({
                    type: 'delta',
                    messageId: assistant.id,
                    text: 'Частичный ответ',
                  }) +
                  '\n',
              ),
            );
            init?.signal?.addEventListener(
              'abort',
              () => controller.error(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          },
        });
        return new Response(stream);
      }
      return Response.json({
        session,
        messages: sending ? [user, { ...assistant, content: '', status: 'generating' }] : [],
        nextCursor: null,
      });
    }),
  );
  const { result } = renderHook(() => useChat());
  await waitFor(() => expect(result.current.ready).toBe(true));
  act(() => result.current.setDraft('Привет'));
  let task: Promise<void> | undefined;
  act(() => {
    task = result.current.send();
  });
  await waitFor(() => expect(result.current.messages.at(-1)?.content).toBe('Частичный ответ'));
  await act(async () => {
    result.current.stop();
    await task;
  });
  expect(result.current.messages.at(-1)).toMatchObject({
    content: 'Частичный ответ',
    status: 'interrupted',
  });
  expect(result.current.busy).toBe(false);
});

it('preserves draft and request ID on ambiguous network failure without duplicate retry', async () => {
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/session') return Response.json(session);
      if (String(input) === '/api/messages/stream') {
        const raw: unknown = JSON.parse(String(init?.body));
        if (
          typeof raw === 'object' &&
          raw !== null &&
          'requestId' in raw &&
          typeof raw.requestId === 'string'
        )
          requests.push(raw.requestId);
        throw new TypeError('offline');
      }
      return Response.json({ session, messages: [], nextCursor: null });
    }),
  );
  const { result } = renderHook(() => useChat());
  await waitFor(() => expect(result.current.ready).toBe(true));
  act(() => result.current.setDraft('Привет'));
  await act(async () => {
    await result.current.send();
  });
  expect(result.current.draft).toBe('Привет');
  await act(async () => {
    await result.current.send();
  });
  expect(requests).toHaveLength(2);
  expect(requests[0]).toBe(requests[1]);
});
it('rejects history from a different session and clears access', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      Response.json(
        String(input) === '/api/session'
          ? session
          : { session: { ...session, id: user.id }, messages: [user], nextCursor: null },
      ),
    ),
  );
  const { result } = renderHook(() => useChat());
  await waitFor(() => expect(result.current.notice).toContain('Сессия завершилась'));
  expect(result.current.messages).toEqual([]);
  expect(result.current.ready).toBe(false);
});

it('allows retrying server synchronization without clearing the existing dialog', async () => {
  let failure = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/session') return Response.json(session);
      if (failure) throw new TypeError('offline');
      return Response.json({ session, messages: [user], nextCursor: null });
    }),
  );
  const { result } = renderHook(() => useChat());
  await waitFor(() => expect(result.current.ready).toBe(true));
  failure = true;
  await act(async () => {
    await result.current.sync();
  });
  expect(result.current.error).not.toBe('');
  expect(result.current.messages).toHaveLength(1);
  failure = false;
  await act(async () => {
    await result.current.sync();
  });
  expect(result.current.error).toBe('');
  expect(result.current.messages).toHaveLength(1);
});

it('keeps provider failure feedback in Russian and does not expose raw upstream details', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/session') return Response.json(session);
      if (String(input) === '/api/messages/stream')
        return new Response(
          JSON.stringify({
            type: 'error',
            code: 'PROVIDER_ERROR',
            message: 'Upstream secret detail',
          }) + '\n',
        );
      return Response.json({ session, messages: [], nextCursor: null });
    }),
  );
  const { result } = renderHook(() => useChat());
  await waitFor(() => expect(result.current.ready).toBe(true));
  act(() => result.current.setDraft('Привет'));
  await act(async () => {
    await result.current.send();
  });
  expect(result.current.error).toContain('Не удалось');
  expect(result.current.error).not.toContain('Upstream');
});

it('uses schema-valid UUIDs for optimistic messages', async () => {
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/session') return Response.json(session);
      if (String(input) === '/api/messages/stream') {
        await pending;
        return new Response(
          JSON.stringify({ type: 'error', code: 'PROVIDER_ERROR', message: 'failed' }),
        );
      }
      return Response.json({ session, messages: [], nextCursor: null });
    }),
  );
  const { result } = renderHook(() => useChat());
  await waitFor(() => expect(result.current.ready).toBe(true));
  act(() => result.current.setDraft('Привет'));
  let task: Promise<void> | undefined;
  act(() => {
    task = result.current.send();
  });
  const valid = messageSchema.safeParse(result.current.messages[0]).success;
  await act(async () => {
    release?.();
    await task;
  });
  expect(valid).toBe(true);
});

it('paginates older history chronologically without duplicating overlap', async () => {
  const old = {
    ...user,
    id: '00000000-0000-4000-8000-000000000009',
    sequence: 0,
    content: 'Ранее',
  };
  const recent = { ...user, sequence: 2 };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/session') return Response.json(session);
      return Response.json({
        session,
        messages: url.includes('cursor=') ? [old, recent] : [recent],
        nextCursor: url.includes('cursor=') ? null : 'older:2',
      });
    }),
  );
  const { result } = renderHook(() => useChat());
  await waitFor(() => expect(result.current.ready).toBe(true));
  await act(async () => {
    await result.current.loadOlder();
  });
  expect(result.current.messages.map((message) => message.sequence)).toEqual([0, 2]);
  expect(result.current.cursor).toBeNull();
});
it('clears cached history and draft on unauthorized session responses', async () => {
  let expired = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/session') return Response.json(session);
      if (expired)
        return Response.json(
          { error: { code: 'SESSION_EXPIRED', message: 'expired' } },
          { status: 401 },
        );
      return Response.json({ session, messages: [user], nextCursor: null });
    }),
  );
  const { result } = renderHook(() => useChat());
  await waitFor(() => expect(result.current.ready).toBe(true));
  act(() => result.current.setDraft('Черновик'));
  expired = true;
  await act(async () => {
    await result.current.sync();
  });
  expect(result.current.ready).toBe(false);
  expect(result.current.messages).toEqual([]);
  expect(result.current.draft).toBe('');
});

it('rejects a stream message belonging to another session', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/session') return Response.json(session);
      if (String(input) === '/api/messages/stream')
        return new Response(
          JSON.stringify({
            type: 'start',
            message: { ...assistant, sessionId: user.id, status: 'generating' },
          }) +
            '\n' +
            JSON.stringify({ type: 'done', message: { ...assistant, sessionId: user.id } }),
        );
      return Response.json({ session, messages: [], nextCursor: null });
    }),
  );
  const { result } = renderHook(() => useChat());
  await waitFor(() => expect(result.current.ready).toBe(true));
  act(() => result.current.setDraft('Привет'));
  await act(async () => {
    await result.current.send();
  });
  expect(result.current.ready).toBe(false);
  expect(result.current.messages).toEqual([]);
});
