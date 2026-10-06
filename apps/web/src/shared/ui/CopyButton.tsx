import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus('idle'), 2500);
  };
  return (
    <button
      type="button"
      className="copy-button"
      onClick={() => {
        void copy();
      }}
      aria-label={
        status === 'copied'
          ? 'Скопировано'
          : status === 'failed'
            ? 'Не удалось скопировать — попробуйте снова'
            : label
      }
      title={status === 'copied' ? 'Скопировано' : label}
    >
      {status === 'copied' ? (
        <Check size={15} aria-hidden="true" />
      ) : (
        <Copy size={15} aria-hidden="true" />
      )}
      {status === 'failed' && <span>Не удалось скопировать</span>}
    </button>
  );
}
