// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatPage } from './ChatPage';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('has a real composer, useful suggestions, one live status region, and working theme control', async () => {
  const session = {
    id: '00000000-0000-4000-8000-000000000001',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    serverTime: new Date().toISOString(),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      Response.json(url === '/api/session' ? session : { session, messages: [], nextCursor: null }),
    ),
  );
  render(<ChatPage />);
  await waitFor(() =>
    expect(
      (screen.getByRole('textbox', { name: 'Сообщение' }) as HTMLTextAreaElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: /Объяснить сложное/ }));
  expect(
    (screen.getByRole('textbox', { name: 'Сообщение' }) as HTMLTextAreaElement).value,
  ).toContain('Объясни');
  expect(screen.getAllByRole('status')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Включить тёмную тему' }));
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(screen.queryByRole('button', { name: /Новый чат/ })).toBeNull();
});

it('disables the composer during delayed synchronization and preserves the draft', async () => {
  const session = {
    id: '00000000-0000-4000-8000-000000000001',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    serverTime: new Date().toISOString(),
  };
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let historyRequests = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/session') return Response.json(session);
      if (String(input) === '/api/messages/stream') throw new TypeError('offline');
      historyRequests += 1;
      if (historyRequests === 3) await pending;
      return Response.json({ session, messages: [], nextCursor: null });
    }),
  );
  render(<ChatPage />);
  const textarea = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Сообщение' });
  await waitFor(() => expect(textarea.disabled).toBe(false));
  fireEvent.change(textarea, { target: { value: 'Черновик' } });
  fireEvent.click(screen.getByRole('button', { name: 'Отправить сообщение' }));
  const syncButton = await screen.findByRole('button', { name: 'Обновить историю' });
  await waitFor(() => expect((syncButton as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(syncButton);
  const textareaDisabledDuringSync = textarea.disabled;
  const sendDisabledDuringSync = screen.getByRole<HTMLButtonElement>('button', {
    name: 'Отправить сообщение',
  }).disabled;
  await act(async () => {
    release?.();
    await pending;
  });
  await waitFor(() => expect(textarea.disabled).toBe(false));
  expect(textareaDisabledDuringSync).toBe(true);
  expect(sendDisabledDuringSync).toBe(true);
  expect(textarea.value).toBe('Черновик');
});
