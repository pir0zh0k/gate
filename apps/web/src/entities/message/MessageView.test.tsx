// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MessageView } from './MessageView';
const message = {
  id: '00000000-0000-4000-8000-000000000002',
  sessionId: '00000000-0000-4000-8000-000000000001',
  sequence: 1,
  role: 'assistant' as const,
  status: 'complete' as const,
  content:
    '**Ответ**\n\n```ts\nconst x = 1;\n```\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))',
  createdAt: '2030-01-01T00:00:00Z',
  expiresAt: '2030-01-01T06:00:00Z',
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('renders safe markdown and copies code and the complete response', async () => {
  const copy = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
  const { container } = render(<MessageView message={message} />);
  expect(container.querySelector('strong')?.textContent).toBe('Ответ');
  expect(container.querySelector('script')).toBeNull();
  expect(container.querySelector('a')?.getAttribute('href') ?? '').not.toContain('javascript:');
  fireEvent.click(screen.getByRole('button', { name: 'Копировать код' }));
  await waitFor(() => expect(copy).toHaveBeenCalledWith('const x = 1;\n'));
  fireEvent.click(screen.getByRole('button', { name: 'Копировать ответ' }));
  await waitFor(() => expect(copy).toHaveBeenCalledWith(message.content));
});
