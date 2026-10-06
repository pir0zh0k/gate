import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  SESSION_TTL_MS,
  HISTORY_TTL_MS,
  CONTEXT_LIMIT,
  type Session,
  type Message,
  type SendMessage,
} from '@gate/contracts';
import type { AIInput } from '../integrations/provider.js';
interface SessionRow {
  id: string;
  expires_at: Date;
}
export interface MessageRow {
  id: string;
  session_id: string;
  sequence: number;
  role: Message['role'];
  content: string;
  status: Message['status'];
  created_at: Date;
  expires_at: Date;
}
export function messageView(row: MessageRow): Message {
  return {
    id: row.id,
    sessionId: row.session_id,
    sequence: row.sequence,
    role: row.role,
    content: row.content,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  };
}
export class ApiFailure extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export class Repository {
  constructor(
    readonly pool: Pool,
    readonly now: () => Date = () => new Date(),
  ) {}
  private sessionView(row: SessionRow): Session {
    return {
      id: row.id,
      expiresAt: row.expires_at.toISOString(),
      serverTime: this.now().toISOString(),
    };
  }
  async findSession(token: string | undefined): Promise<Session | null> {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const result = await this.pool.query<SessionRow>(
      'SELECT id,expires_at FROM sessions WHERE token_hash=$1 AND expires_at>$2',
      [createHash('sha256').update(token).digest('hex'), this.now()],
    );
    return result.rows[0] ? this.sessionView(result.rows[0]) : null;
  }
  async createSession(): Promise<{ session: Session; token: string }> {
    const token = randomBytes(32).toString('hex');
    const now = this.now();
    const result = await this.pool.query<SessionRow>(
      'INSERT INTO sessions(id,token_hash,created_at,expires_at) VALUES($1,$2,$3,$4) RETURNING id,expires_at',
      [
        randomUUID(),
        createHash('sha256').update(token).digest('hex'),
        now,
        new Date(now.getTime() + SESSION_TTL_MS),
      ],
    );
    return { session: this.sessionView(result.rows[0]!), token };
  }
  async beginGeneration(
    sessionId: string,
    payload: SendMessage,
  ): Promise<{ message: Message; input: AIInput; replay: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const now = this.now();
      const session = await client.query<{ next_sequence: number }>(
        'SELECT next_sequence FROM sessions WHERE id=$1 AND expires_at>$2 FOR UPDATE',
        [sessionId, now],
      );
      if (!session.rows[0])
        throw new ApiFailure(401, 'SESSION_EXPIRED', 'Сессия истекла. Начните новый диалог.');
      const duplicate = await client.query<MessageRow>(
        'SELECT * FROM messages WHERE session_id=$1 AND request_id=$2 ORDER BY sequence',
        [sessionId, payload.requestId],
      );
      if (duplicate.rows.length) {
        if (duplicate.rows[0]!.content !== payload.content)
          throw new ApiFailure(
            409,
            'IDEMPOTENCY_CONFLICT',
            'Этот requestId уже использован для другого запроса.',
          );
        const assistant = duplicate.rows[1]!;
        if (assistant.status === 'generating')
          throw new ApiFailure(409, 'GENERATION_IN_PROGRESS', 'Этот запрос ещё обрабатывается.');
        await client.query('COMMIT');
        return { message: messageView(assistant), input: [], replay: true };
      }
      const busy = await client.query(
        "SELECT id FROM messages WHERE session_id=$1 AND status='generating'",
        [sessionId],
      );
      if (busy.rowCount)
        throw new ApiFailure(
          409,
          'GENERATION_IN_PROGRESS',
          'Дождитесь завершения текущего ответа.',
        );
      const sequence = session.rows[0].next_sequence;
      const expires = new Date(now.getTime() + HISTORY_TTL_MS);
      await client.query(
        "INSERT INTO messages(id,session_id,sequence,role,content,status,request_id,created_at,expires_at,updated_at) VALUES($1,$2,$3,'user',$4,'complete',$5,$6,$7,$6)",
        [randomUUID(), sessionId, sequence, payload.content, payload.requestId, now, expires],
      );
      const assistant = await client.query<MessageRow>(
        "INSERT INTO messages(id,session_id,sequence,role,content,status,request_id,created_at,expires_at,updated_at) VALUES($1,$2,$3,'assistant','','generating',$4,$5,$6,$5) RETURNING *",
        [randomUUID(), sessionId, sequence + 1, payload.requestId, now, expires],
      );
      await client.query('UPDATE sessions SET next_sequence=next_sequence+2 WHERE id=$1', [
        sessionId,
      ]);
      const context = await client.query<MessageRow>(
        "SELECT * FROM messages WHERE session_id=$1 AND status='complete' AND expires_at>$2 ORDER BY sequence DESC LIMIT $3",
        [sessionId, now, CONTEXT_LIMIT],
      );
      await client.query('COMMIT');
      return {
        message: messageView(assistant.rows[0]!),
        input: context.rows.reverse().map((row) => ({ role: row.role, content: row.content })),
        replay: false,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async saveMessage(id: string, content: string, status: Message['status']): Promise<Message> {
    const result = await this.pool.query<MessageRow>(
      "UPDATE messages SET content=$2,status=$3,updated_at=$4 WHERE id=$1 AND status='generating' RETURNING *",
      [id, content, status, this.now()],
    );
    if (!result.rows[0]) throw new Error('Generation is no longer active');
    return messageView(result.rows[0]);
  }
  async recoverStale(staleMs: number): Promise<number> {
    const result = await this.pool.query(
      "UPDATE messages SET status='interrupted',updated_at=$1 WHERE status='generating' AND updated_at<$2",
      [this.now(), new Date(this.now().getTime() - staleMs)],
    );
    return result.rowCount ?? 0;
  }
  async cleanup(batchSize = 1000): Promise<{ messages: number; sessions: number }> {
    const now = this.now();
    const messages = await this.pool.query(
      'DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE expires_at<=$1 ORDER BY expires_at LIMIT $2 FOR UPDATE SKIP LOCKED)',
      [now, batchSize],
    );
    const sessions = await this.pool.query(
      'DELETE FROM sessions WHERE id IN (SELECT s.id FROM sessions s WHERE s.expires_at<=$1 AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id=s.id) ORDER BY s.expires_at LIMIT $2 FOR UPDATE SKIP LOCKED)',
      [now, batchSize],
    );
    return { messages: messages.rowCount ?? 0, sessions: sessions.rowCount ?? 0 };
  }
  async history(
    sessionId: string,
    before: number | null,
    limit: number,
  ): Promise<{ messages: Message[]; nextCursor: string | null }> {
    const result = await this.pool.query<MessageRow>(
      'SELECT * FROM messages WHERE session_id=$1 AND expires_at>$2 AND ($3::integer IS NULL OR sequence<$3) ORDER BY sequence DESC LIMIT $4',
      [sessionId, this.now(), before, limit + 1],
    );
    const rows = result.rows.slice(0, limit);
    return {
      messages: rows.reverse().map(messageView),
      nextCursor: result.rows.length > limit ? String(rows[0]!.sequence) : null,
    };
  }
}
