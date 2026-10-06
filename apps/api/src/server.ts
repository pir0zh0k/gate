import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { createApp } from './app.js';
import { loadConfig, type Config } from './config.js';
import { migrate } from './database/migrate.js';
import type { AIProvider } from './integrations/provider.js';
export async function startServer(options: {
  config: Config;
  provider?: AIProvider;
  staticRoot?: string;
}) {
  const pool = new Pool({
    connectionString: options.config.databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
  });
  pool.on('error', () => console.error('Database connection error'));
  try {
    await migrate(pool);
    const staticRoot =
      options.staticRoot ??
      (options.config.production
        ? fileURLToPath(new URL('../../../apps/web/dist/', import.meta.url))
        : undefined);
    const app = await createApp({
      pool,
      config: options.config,
      ...(options.provider ? { provider: options.provider } : {}),
      ...(staticRoot ? { staticRoot } : {}),
    });
    app.addHook('onClose', async () => {
      await pool.end();
    });
    try {
      const address = await app.listen({ host: options.config.host, port: options.config.port });
      return { app, pool, address };
    } catch (error) {
      await app.close();
      throw error;
    }
  } catch (error) {
    if (!pool.ended) await pool.end();
    throw error;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });
  Promise.resolve()
    .then(() => startServer({ config: loadConfig() }))
    .then(({ app }) => {
      let closing = false;
      const shutdown = () => {
        if (closing) return;
        closing = true;
        void app.close().catch(() => {
          console.error('Server shutdown failed');
          process.exitCode = 1;
        });
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
      console.info('Gate API ready');
    })
    .catch(() => {
      console.error('Gate API startup failed; check server configuration and database readiness');
      process.exitCode = 1;
    });
}
