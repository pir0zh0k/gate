import type { Message } from '@gate/contracts';
import { Children, isValidElement, type ReactNode } from 'react';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CopyButton } from '../../shared/ui/CopyButton';
function textContent(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) => {
      if (typeof child === 'string' || typeof child === 'number') return String(child);
      if (isValidElement<{ children?: ReactNode }>(child)) return textContent(child.props.children);
      return '';
    })
    .join('');
}
export function MessageView({ message }: { message: Message }) {
  if (message.role === 'user')
    return (
      <article className="message-user" aria-label="Ваше сообщение">
        <div>{message.content}</div>
      </article>
    );
  return (
    <article className="message-assistant" aria-label="Ответ ИИ">
      <div className="assistant-name">
        <span className="gate-mark" aria-hidden="true">
          g
        </span>
        <span>gate</span>
      </div>
      <div className="markdown">
        <Markdown
          remarkPlugins={[remarkGfm]}
          skipHtml
          urlTransform={(url) =>
            /^(https?:|mailto:|\/|#)/i.test(url) ? defaultUrlTransform(url) : ''
          }
          components={{
            a: ({ children, href }) =>
              href ? (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              ) : (
                <span>{children}</span>
              ),
            img: ({ alt }) => <span>{alt}</span>,
            pre: ({ children }) => (
              <div className="code-block">
                <div className="code-header">
                  <span>Код</span>
                  <CopyButton text={textContent(children)} label="Копировать код" />
                </div>
                <pre>{children}</pre>
              </div>
            ),
          }}
        >
          {message.content}
        </Markdown>
        {message.status === 'generating' && <span className="stream-dot" aria-hidden="true" />}
      </div>
      <div className="response-tools">
        {message.content && <CopyButton text={message.content} label="Копировать ответ" />}
        {message.status === 'interrupted' && <span>Ответ прерван</span>}
        {message.status === 'error' && <span>Не удалось завершить ответ</span>}
      </div>
    </article>
  );
}
