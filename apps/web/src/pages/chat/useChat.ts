import { useCallback, useEffect, useRef, useState } from 'react';
import {
  HISTORY_TTL_MS,
  sendMessageSchema,
  type History,
  type Message,
  type Session,
} from '@gate/contracts';
import { ApiFailure, createSession, fetchHistory, postMessage } from '../../shared/api/client';
import { consumeStream } from '../../shared/api/stream';
import { clearCache, readCache, writeCache } from '../../shared/lib/cache';
const storage = {
  getItem: (key: string) => window.localStorage.getItem(key),
  setItem: (key: string, value: string) => window.localStorage.setItem(key, value),
  removeItem: (key: string) => window.localStorage.removeItem(key),
};
function assertHistorySession(history: History, id: string): void {
  if (history.session.id !== id || history.messages.some((message) => message.sessionId !== id))
    throw new ApiFailure('SESSION_EXPIRED', 'Session mismatch');
}
function merge(messages: Message[], incoming: Message[]): Message[] {
  const map = new Map(messages.map((message) => [message.id, message]));
  for (const message of incoming) map.set(message.id, message);
  return [...map.values()].sort((a, b) => a.sequence - b.sequence);
}
export function useChat() {
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState('Подключаемся…');
  const [error, setError] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [revision, setRevision] = useState(0);
  const active = useRef<AbortController | null>(null);
  const syncInFlight = useRef(false);
  const lifecycle = useRef<AbortController | null>(null);
  const offset = useRef(0);
  const sessionRef = useRef<Session | null>(null);
  const optimisticId = useRef<string | null>(null);
  const retry = useRef<{ content: string; requestId: string } | null>(null);
  const expire = useCallback(() => {
    active.current?.abort();
    lifecycle.current?.abort();
    clearCache(storage);
    sessionRef.current = null;
    setSession(null);
    setMessages([]);
    setDraft('');
    retry.current = null;
    setReady(false);
    setBusy(false);
    setCursor(null);
    setError('');
    setNotice('Сессия завершилась через час. Предыдущий диалог больше недоступен.');
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    setReady(false);
    setError('');
    void (async () => {
      try {
        const authenticated = await createSession(controller.signal);
        if (controller.signal.aborted) return;
        offset.current = Date.parse(authenticated.serverTime) - Date.now();
        sessionRef.current = authenticated;
        setSession(authenticated);
        setMessages(readCache(storage, authenticated, Date.now() + offset.current));
        const history = await fetchHistory(controller.signal);
        if (controller.signal.aborted) return;
        assertHistorySession(history, authenticated.id);
        setMessages(history.messages);
        setCursor(history.nextCursor);
        writeCache(storage, authenticated, history.messages);
        setReady(true);
        setNotice('');
      } catch (reason: unknown) {
        if (controller.signal.aborted) return;
        if (reason instanceof ApiFailure && reason.code === 'SESSION_EXPIRED') expire();
        else {
          setError('Не удалось подключиться. Проверьте сеть и попробуйте снова.');
          setNotice('');
        }
      }
    })();
    return () => {
      controller.abort();
      active.current?.abort();
    };
  }, [revision, expire]);
  useEffect(() => {
    if (!session) return;
    const remaining = Date.parse(session.expiresAt) - Date.now() - offset.current;
    if (remaining <= 0) {
      expire();
      return;
    }
    const timer = setTimeout(expire, remaining);
    const check = () => {
      if (Date.now() + offset.current >= Date.parse(session.expiresAt)) expire();
    };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [session, expire]);
  const reconnect = () => {
    clearCache(storage);
    setMessages([]);
    setRevision((value) => value + 1);
    setNotice('Подключаемся…');
  };
  const reconcile = async (signal: AbortSignal) => {
    const history = await fetchHistory(signal);
    if (signal.aborted || !sessionRef.current) return;
    assertHistorySession(history, sessionRef.current.id);
    setMessages((previous) => {
      const oldest = history.messages[0]?.sequence ?? 0;
      const incoming = history.messages.map((message) => {
        const local = previous.find((item) => item.id === message.id);
        return message.status === 'generating' && local && local.status !== 'generating'
          ? {
              ...message,
              content:
                local.content.length > message.content.length ? local.content : message.content,
              status: local.status,
            }
          : message;
      });
      const updated = merge(
        previous.filter(
          (message) => message.sequence < oldest && message.id !== optimisticId.current,
        ),
        incoming,
      );
      writeCache(storage, history.session, updated);
      return updated;
    });
    setCursor((previous) => previous ?? history.nextCursor);
  };
  const send = async () => {
    if (!ready || active.current || syncInFlight.current || !sessionRef.current) return;
    const current = sessionRef.current;
    const content = draft.trim();
    if (!content) return;
    const request = sendMessageSchema.parse({
      content,
      requestId: retry.current?.content === content ? retry.current.requestId : crypto.randomUUID(),
    });
    retry.current = request;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError('');
    setNotice('Готовим ответ…');
    const now = new Date(Date.now() + offset.current).toISOString();
    const previousOptimisticId = optimisticId.current;
    optimisticId.current = request.requestId;
    setMessages((previous) => [
      ...previous.filter((message) => message.id !== previousOptimisticId),
      {
        id: request.requestId,
        sessionId: current.id,
        sequence: (previous.at(-1)?.sequence ?? -1) + 1,
        role: 'user',
        content,
        status: 'complete',
        createdAt: now,
        expiresAt: new Date(Date.parse(now) + HISTORY_TTL_MS).toISOString(),
      },
    ]);
    let accepted = false;
    try {
      const response = await postMessage(request, controller.signal);
      if (!response.body) throw new Error('Нет потока');
      await consumeStream(response.body, (event) => {
        if (controller.signal.aborted || sessionRef.current?.id !== current.id) return;
        const incomingMessage =
          event.type === 'start' || event.type === 'done'
            ? event.message
            : event.type === 'error'
              ? event.partial
              : undefined;
        if (incomingMessage && incomingMessage.sessionId !== current.id)
          throw new ApiFailure('SESSION_EXPIRED', 'Session mismatch');
        if (event.type === 'error' && event.code === 'SESSION_EXPIRED')
          throw new ApiFailure('SESSION_EXPIRED', 'Session expired');
        if (event.type === 'start') {
          accepted = true;
          retry.current = null;
          setDraft((value) => (value.trim() === content ? '' : value));
          setNotice('Ответ поступает…');
          setMessages((previous) => merge(previous, [event.message]));
        } else if (event.type === 'delta')
          setMessages((previous) =>
            previous.map((message) =>
              message.id === event.messageId
                ? { ...message, content: message.content + event.text }
                : message,
            ),
          );
        else if (event.type === 'done') {
          setMessages((previous) => merge(previous, [event.message]));
          setNotice('Ответ готов.');
        } else {
          if (event.partial) {
            const partial = event.partial;
            setMessages((previous) => merge(previous, [partial]));
          }
          setError('Не удалось завершить ответ. Попробуйте отправить сообщение позже.');
          setNotice('');
        }
      });
    } catch (reason: unknown) {
      if (sessionRef.current?.id !== current.id) return;
      if (reason instanceof ApiFailure && reason.code === 'SESSION_EXPIRED') {
        expire();
        return;
      }
      setMessages((previous) =>
        previous.map((message) =>
          message.status === 'generating' ? { ...message, status: 'interrupted' } : message,
        ),
      );
      if (controller.signal.aborted) setNotice('Ответ остановлен.');
      else {
        setError(
          accepted
            ? 'Соединение прервалось. Частичный ответ остаётся в диалоге.'
            : 'Не удалось отправить сообщение. Текст сохранён — повторите отправку.',
        );
        setNotice('');
      }
    } finally {
      if (
        sessionRef.current?.id === current.id &&
        lifecycle.current &&
        !lifecycle.current.signal.aborted
      ) {
        try {
          await reconcile(lifecycle.current.signal);
        } catch (reason: unknown) {
          if (reason instanceof ApiFailure && reason.code === 'SESSION_EXPIRED') expire();
          else
            setError(
              'Не удалось обновить историю. Повторите синхронизацию перед следующим сообщением.',
            );
        }
      }
      if (active.current === controller) active.current = null;
      setBusy(false);
    }
  };
  const loadOlder = async () => {
    if (!cursor || !lifecycle.current || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const history = await fetchHistory(lifecycle.current.signal, cursor);
      if (!lifecycle.current.signal.aborted && sessionRef.current) {
        assertHistorySession(history, sessionRef.current.id);
        setMessages((previous) => merge(history.messages, previous));
        setCursor(history.nextCursor);
      }
    } catch (reason: unknown) {
      if (reason instanceof ApiFailure && reason.code === 'SESSION_EXPIRED') expire();
      else setError('Не удалось загрузить предыдущие сообщения. Попробуйте ещё раз.');
    } finally {
      setLoadingOlder(false);
    }
  };
  const sync = async () => {
    if (!lifecycle.current || active.current || syncInFlight.current) return;
    syncInFlight.current = true;
    setSyncing(true);
    try {
      await reconcile(lifecycle.current.signal);
      setError('');
      setNotice('История обновлена.');
    } catch (reason: unknown) {
      if (reason instanceof ApiFailure && reason.code === 'SESSION_EXPIRED') expire();
      else setError('Не удалось обновить историю. Проверьте сеть и попробуйте снова.');
    } finally {
      syncInFlight.current = false;
      setSyncing(false);
    }
  };
  return {
    session,
    messages,
    draft,
    setDraft,
    ready,
    busy,
    notice,
    error,
    cursor,
    loadingOlder,
    syncing,
    sync,
    send,
    stop: () => active.current?.abort(),
    reconnect,
    loadOlder,
  };
}
