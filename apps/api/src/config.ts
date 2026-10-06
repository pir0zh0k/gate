export interface Config {
  databaseUrl: string;
  appOrigin: string;
  production: boolean;
  port: number;
  host: string;
  model: string;
  apiKey: string | undefined;
  generationTimeoutMs: number;
  flushIntervalMs: number;
  maxOutputTokens: number;
}
function parseUrl(value: string, name: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${name} is invalid`);
  }
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  const appOrigin = env.APP_ORIGIN;
  if (!databaseUrl || !appOrigin) throw new Error('DATABASE_URL and APP_ORIGIN are required');
  const origin = parseUrl(appOrigin, 'APP_ORIGIN');
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== appOrigin)
    throw new Error('APP_ORIGIN must be an exact HTTP origin');
  if (!['postgres:', 'postgresql:'].includes(parseUrl(databaseUrl, 'DATABASE_URL').protocol))
    throw new Error('DATABASE_URL must be PostgreSQL');
  const port = Number(env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT is invalid');
  return {
    databaseUrl,
    appOrigin,
    production: env.NODE_ENV === 'production',
    port,
    host: env.HOST ?? '0.0.0.0',
    model: env.OPENAI_MODEL ?? 'gpt-5.6-terra',
    apiKey: env.OPENAI_API_KEY,
    generationTimeoutMs: 120000,
    flushIntervalMs: 1000,
    maxOutputTokens: 4096,
  };
}
