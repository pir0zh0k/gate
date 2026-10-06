import type { Pool } from 'pg';
const schema = `
CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  next_sequence integer NOT NULL DEFAULT 0,
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  sequence integer NOT NULL CHECK (sequence >= 0),
  role text NOT NULL CHECK (role IN ('user','assistant')),
  content text NOT NULL,
  status text NOT NULL CHECK (status IN ('complete','generating','interrupted','error')),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE(session_id, sequence),
  CHECK (expires_at > created_at),
  CHECK (role <> 'user' OR status = 'complete')
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_request_idx ON messages(session_id,request_id,role);
CREATE UNIQUE INDEX IF NOT EXISTS messages_active_idx ON messages(session_id) WHERE status='generating';
CREATE INDEX IF NOT EXISTS messages_expiry_idx ON messages(expires_at);
CREATE INDEX IF NOT EXISTS messages_context_idx ON messages(session_id,sequence DESC) WHERE status='complete';
CREATE INDEX IF NOT EXISTS messages_recovery_idx ON messages(updated_at) WHERE status='generating';
`;
export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(741218031)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const applied = await client.query('SELECT version FROM schema_migrations WHERE version=1');
    if (!applied.rowCount) {
      await client.query(schema);
      await client.query('INSERT INTO schema_migrations(version) VALUES(1)');
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
