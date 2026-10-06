import { useLayoutEffect, useRef } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { MAX_INPUT_LENGTH } from '@gate/contracts';
interface Props {
  value: string;
  onChange(value: string): void;
  onSend(): void;
  onStop(): void;
  busy: boolean;
  disabled: boolean;
}
export function Composer({ value, onChange, onSend, onStop, busy, disabled }: Props) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight || 28, 200)}px`;
  }, [value]);
  const canSend = !disabled && !busy && value.trim().length > 0;
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) onSend();
      }}
    >
      <textarea
        ref={textarea}
        aria-label="Сообщение"
        placeholder="Спросите о чём угодно"
        value={value}
        maxLength={MAX_INPUT_LENGTH}
        rows={1}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key === 'Enter' &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing &&
            event.keyCode !== 229
          ) {
            event.preventDefault();
            if (canSend) onSend();
          }
        }}
      />
      <div className="composer-tools">
        <span className="composer-hint">
          {value.length > MAX_INPUT_LENGTH - 500
            ? `${value.length} / ${MAX_INPUT_LENGTH}`
            : 'Enter — отправить · Shift + Enter — новая строка'}
        </span>
        {busy ? (
          <button
            type="button"
            className="send-button"
            aria-label="Остановить ответ"
            title="Остановить ответ"
            onClick={onStop}
          >
            <Square size={15} fill="currentColor" aria-hidden="true" />
          </button>
        ) : (
          <button
            className="send-button"
            type="submit"
            disabled={!canSend}
            aria-label="Отправить сообщение"
            title="Отправить сообщение"
          >
            <ArrowUp size={21} aria-hidden="true" />
          </button>
        )}
      </div>
    </form>
  );
}
