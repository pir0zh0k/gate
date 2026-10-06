import { z } from 'zod';

export const SESSION_TTL_MS = 60 * 60 * 1000;
export const HISTORY_TTL_MS = 6 * 60 * 60 * 1000;
export const CONTEXT_LIMIT = 10;
export const MAX_INPUT_LENGTH = 16_000;

const timestamp = z.iso.datetime({ offset: true });
export const sessionSchema = z.object({
  id: z.uuid(),
  expiresAt: timestamp,
  serverTime: timestamp,
});
export type Session = z.infer<typeof sessionSchema>;

export const messageSchema = z.object({
  id: z.uuid(),
  sessionId: z.uuid(),
  sequence: z.number().int().nonnegative(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  status: z.enum(['complete', 'generating', 'interrupted', 'error']),
  createdAt: timestamp,
  expiresAt: timestamp,
});
export type Message = z.infer<typeof messageSchema>;

export const historySchema = z.object({
  session: sessionSchema,
  messages: z.array(messageSchema),
  nextCursor: z.string().nullable(),
});
export type History = z.infer<typeof historySchema>;

export const sendMessageSchema = z.object({
  content: z.string().trim().min(1).max(MAX_INPUT_LENGTH),
  requestId: z.uuid(),
});
export type SendMessage = z.infer<typeof sendMessageSchema>;

export const streamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), message: messageSchema }),
  z.object({ type: z.literal('delta'), messageId: z.uuid(), text: z.string() }),
  z.object({ type: z.literal('done'), message: messageSchema }),
  z.object({
    type: z.literal('error'),
    code: z.string(),
    message: z.string(),
    partial: messageSchema.optional(),
  }),
]);
export type StreamEvent = z.infer<typeof streamEventSchema>;

export const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
