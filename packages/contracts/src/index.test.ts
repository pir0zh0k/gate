import { describe, expect, it } from 'vitest';
import {
  HISTORY_TTL_MS,
  SESSION_TTL_MS,
  CONTEXT_LIMIT,
  sendMessageSchema,
  streamEventSchema,
  historySchema,
} from './index';

const id = '11111111-1111-4111-8111-111111111111';
const now = '2026-10-06T12:00:00.000Z';
const message = {
  id,
  sessionId: id,
  sequence: 1,
  role: 'assistant',
  content: '',
  status: 'generating',
  createdAt: now,
  expiresAt: '2026-10-06T18:00:00.000Z',
};

describe('API contracts', () => {
  it('expresses the agreed lifetime and context limits', () => {
    expect(SESSION_TTL_MS).toBe(60 * 60 * 1000);
    expect(HISTORY_TTL_MS).toBe(6 * 60 * 60 * 1000);
    expect(CONTEXT_LIMIT).toBe(10);
  });
  it('trims content and requires a request identifier', () => {
    expect(sendMessageSchema.parse({ content: '  Привет  ', requestId: id }).content).toBe(
      'Привет',
    );
    expect(sendMessageSchema.safeParse({ content: 'Привет' }).success).toBe(false);
  });
  it('rejects empty and oversized messages', () => {
    expect(sendMessageSchema.safeParse({ content: '   ', requestId: id }).success).toBe(false);
    expect(sendMessageSchema.safeParse({ content: 'a'.repeat(16001), requestId: id }).success).toBe(
      false,
    );
  });
  it('validates events and rejects unknown types', () => {
    expect(streamEventSchema.safeParse({ type: 'start', message }).success).toBe(true);
    expect(
      streamEventSchema.safeParse({ type: 'delta', messageId: id, text: 'Привет' }).success,
    ).toBe(true);
    expect(
      streamEventSchema.safeParse({
        type: 'done',
        message: { ...message, content: 'Да', status: 'complete' },
      }).success,
    ).toBe(true);
    expect(
      streamEventSchema.safeParse({
        type: 'error',
        code: 'UPSTREAM_ERROR',
        message: 'Недоступен',
        partial: { ...message, status: 'error' },
      }).success,
    ).toBe(true);
    expect(streamEventSchema.safeParse({ type: 'other' }).success).toBe(false);
    expect(streamEventSchema.safeParse({ type: 'delta', text: 'Привет' }).success).toBe(false);
  });
  it('validates server history and expiry timestamps', () => {
    const history = {
      session: { id, expiresAt: '2026-10-06T13:00:00.000Z', serverTime: now },
      messages: [message],
      nextCursor: null,
    };
    expect(historySchema.safeParse(history).success).toBe(true);
    expect(
      historySchema.safeParse({
        ...history,
        session: { ...history.session, expiresAt: 'tomorrow' },
      }).success,
    ).toBe(false);
  });
});
