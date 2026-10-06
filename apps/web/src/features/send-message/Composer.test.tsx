// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Composer } from './Composer';
afterEach(cleanup);
it('sends Enter, preserves Shift Enter and IME composition, and stops pending generation', () => {
  const send = vi.fn();
  const stop = vi.fn();
  const change = vi.fn();
  const { rerender } = render(
    <Composer
      value="Привет"
      onChange={change}
      onSend={send}
      onStop={stop}
      busy={false}
      disabled={false}
    />,
  );
  const input = screen.getByRole('textbox', { name: 'Сообщение' });
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
  expect(send).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  expect(send).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(send).toHaveBeenCalledOnce();
  fireEvent.change(input, { target: { value: 'Новый текст' } });
  expect(change).toHaveBeenCalledWith('Новый текст');
  rerender(
    <Composer value="Привет" onChange={change} onSend={send} onStop={stop} busy disabled={false} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Остановить ответ' }));
  expect(stop).toHaveBeenCalledOnce();
});
