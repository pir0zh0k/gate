import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { migrate } from './migrate.js';
dotenv.config({ path: fileURLToPath(new URL('../../../../.env', import.meta.url)), quiet: true });
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 5000 });
try {
  await migrate(pool);
  console.info('Database migrations applied');
} catch {
  console.error('Database migration failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
