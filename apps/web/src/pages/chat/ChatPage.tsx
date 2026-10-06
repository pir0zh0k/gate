import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUpRight,
  BookOpen,
  Lightbulb,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PenLine,
  Sun,
} from 'lucide-react';
import { Composer } from '../../features/send-message/Composer';
import { MessageView } from '../../entities/message/MessageView';
import { useChat } from './useChat';
const suggestions = [
  {
    title: 'Объяснить сложное',
    icon: BookOpen,
    prompt:
      'Объясни сложную тему простыми словами. Для начала спроси, какую тему я хочу разобрать.',
  },
  {
    title: 'Найти идею',
    icon: Lightbulb,
    prompt: 'Помоги найти свежую идею. Спроси о моей задаче и предложи несколько направлений.',
  },
  {
    title: 'Написать текст',
    icon: PenLine,
    prompt: 'Помоги написать текст. Сначала уточни его цель, аудиторию и желаемый тон.',
  },
];
function initialTheme(): 'light' | 'dark' {
  try {
    return window.localStorage.getItem('gate.theme') === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}
export function ChatPage() {
  const chat = useChat();
  const [theme, setTheme] = useState(initialTheme);
  const [railOpen, setRailOpen] = useState(true);
  const scroll = useRef<HTMLDivElement>(null);
  const bottom = useRef(true);
  const [away, setAway] = useState(false);
  const previousHeight = useRef<number | null>(null);
  const empty = chat.messages.length === 0;
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem('gate.theme', theme);
    } catch {
      /* Optional preference. */
    }
  }, [theme]);
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    if (previousHeight.current !== null) {
      element.scrollTop += element.scrollHeight - previousHeight.current;
      previousHeight.current = null;
    } else if (bottom.current) element.scrollTop = element.scrollHeight;
  }, [chat.messages]);
  const toBottom = () => {
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    bottom.current = true;
    setAway(false);
  };
  return (
    <div className={`chat-shell ${railOpen ? '' : 'rail-collapsed'}`}>
      <aside className="left-rail" aria-label="О диалоге">
        <div className="rail-top">
          <span className="brand">
            gate<span className="brand-dot">.</span>
          </span>
          <button
            className="icon-button"
            aria-label="Свернуть панель"
            title="Свернуть панель"
            onClick={() => setRailOpen(false)}
          >
            <PanelLeftClose size={19} aria-hidden="true" />
          </button>
        </div>
        <div className="rail-dialog">
          <span className="dialog-dot" />
          <div>
            <strong>Ваш диалог</strong>
            <span>Без регистрации</span>
          </div>
        </div>
        <div className="rail-bottom">
          <span className="rail-caption">МЕСТО ДЛЯ ВАШИХ МЫСЛЕЙ</span>
          <p>
            Один диалог.
            <br />
            Никаких лишних шагов.
          </p>
          <div className="session-note">
            <span />
            Сессия — 1 час
          </div>
        </div>
      </aside>
      <div className="chat-main">
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="icon-button rail-toggle"
              aria-label={railOpen ? 'Свернуть панель' : 'Открыть панель'}
              onClick={() => setRailOpen((value) => !value)}
            >
              <PanelLeftOpen size={20} aria-hidden="true" />
            </button>
            <span className="mobile-brand">gate.</span>
            <span className="model-label">
              GPT-5.6 Terra<span className="model-tag">ИИ</span>
            </span>
          </div>
          <button
            className="icon-button"
            aria-label={theme === 'light' ? 'Включить тёмную тему' : 'Включить светлую тему'}
            title={theme === 'light' ? 'Тёмная тема' : 'Светлая тема'}
            onClick={() => setTheme((value) => (value === 'light' ? 'dark' : 'light'))}
          >
            {theme === 'light' ? (
              <Moon size={19} aria-hidden="true" />
            ) : (
              <Sun size={19} aria-hidden="true" />
            )}
          </button>
        </header>
        <main className={`conversation-layout ${empty ? 'is-empty' : ''}`}>
          <div
            ref={scroll}
            className="conversation-scroll"
            onScroll={() => {
              const element = scroll.current;
              if (!element) return;
              bottom.current =
                element.scrollHeight - element.scrollTop - element.clientHeight < 100;
              setAway(!bottom.current);
            }}
          >
            {empty ? (
              <section className="welcome">
                <span className="welcome-eyebrow">ПРОСТРАНСТВО ДЛЯ МЫСЛИ</span>
                <h1>С чего начнём?</h1>
                <p>
                  Вопрос, идея или чистый лист —<br className="mobile-break" /> начните с того, что
                  важно вам.
                </p>
              </section>
            ) : (
              <div className="message-list">
                {chat.cursor && (
                  <button
                    className="older-button"
                    disabled={chat.loadingOlder || chat.busy}
                    onClick={() => {
                      previousHeight.current = scroll.current?.scrollHeight ?? null;
                      void chat.loadOlder();
                    }}
                  >
                    {chat.loadingOlder ? 'Загружаем…' : 'Показать предыдущие сообщения'}
                  </button>
                )}
                {chat.messages.map((message) => (
                  <MessageView key={message.id} message={message} />
                ))}
              </div>
            )}
          </div>
          <div className="composer-region">
            <div className="composer-width">
              {away && !empty && (
                <button
                  className="jump-button"
                  aria-label="К последнему сообщению"
                  onClick={toBottom}
                >
                  <ArrowDown size={18} aria-hidden="true" />
                </button>
              )}
              <div className="feedback" role="status" aria-live="polite" aria-atomic="true">
                {chat.error || chat.notice}
                {chat.ready && chat.error && (
                  <button
                    className="retry-button"
                    disabled={chat.busy || chat.syncing}
                    onClick={() => {
                      void chat.sync();
                    }}
                  >
                    {chat.syncing ? 'Обновляем…' : 'Обновить историю'}
                  </button>
                )}
                {!chat.ready &&
                  (chat.error || (!chat.session && chat.notice.includes('завершилась'))) && (
                    <button className="retry-button" onClick={chat.reconnect}>
                      {chat.error ? 'Повторить подключение' : 'Начать новый диалог'}
                    </button>
                  )}
              </div>
              <Composer
                value={chat.draft}
                onChange={chat.setDraft}
                onSend={() => {
                  bottom.current = true;
                  setAway(false);
                  void chat.send();
                }}
                onStop={chat.stop}
                busy={chat.busy}
                disabled={!chat.ready || chat.syncing}
              />
              {empty && (
                <div className="suggestions">
                  {suggestions.map(({ title, icon: Icon, prompt }) => (
                    <button
                      key={title}
                      disabled={!chat.ready}
                      onClick={() => {
                        chat.setDraft(prompt);
                        scroll.current?.parentElement?.querySelector('textarea')?.focus();
                      }}
                    >
                      <Icon size={16} aria-hidden="true" />
                      <span>{title}</span>
                      <ArrowUpRight className="suggestion-arrow" size={14} aria-hidden="true" />
                    </button>
                  ))}
                </div>
              )}
              <p className="disclaimer">ИИ может ошибаться. Проверяйте важную информацию.</p>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
