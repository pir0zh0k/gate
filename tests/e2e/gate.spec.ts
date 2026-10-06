import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import pg from 'pg';
import { createApp } from '../../apps/api/src/app';
import { loadConfig } from '../../apps/api/src/config';
import { migrate } from '../../apps/api/src/database/migrate';
import type { AIProvider, AIInput } from '../../apps/api/src/integrations/provider';
import { Repository } from '../../apps/api/src/models/repository';

// A controlled provider is confined to tests; this is not a production OpenAI fallback.
class BrowserTestProvider implements AIProvider {
  async *stream(input: AIInput, signal: AbortSignal): AsyncIterable<string> {
    const prompt = input.at(-1)?.content ?? '';
    if (prompt === 'Проверь отмену') {
      yield 'Частичный ответ для проверки отмены.';
      await pause(10_000, undefined, { signal });
      yield ' Этот текст не должен появиться после отмены.';
      return;
    }
    if (prompt === 'Проверь ошибку') {
      yield 'Частичный текст до ошибки.';
      await pause(50, undefined, { signal });
      throw new Error('Controlled test failure');
    }
    yield '**Проверочный ответ**\n\n';
    await pause(80, undefined, { signal });
    yield 'Сообщение сохранено в PostgreSQL.';
  }
}

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl)
  throw new Error('TEST_DATABASE_URL is required. Use an isolated test PostgreSQL.');
const schemaName = `gate_browser_${process.pid}`;
let administrator: pg.Pool;
let pool: pg.Pool;
let app: Awaited<ReturnType<typeof createApp>>;
let origin = '';
let clock = Date.now();

async function ready(page: Page): Promise<void> {
  await page.goto(origin);
  await expect(page.getByRole('textbox', { name: 'Сообщение', exact: true })).toBeEnabled();
}
async function send(page: Page, content: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Сообщение', exact: true }).fill(content);
  await page.getByRole('button', { name: 'Отправить сообщение', exact: true }).click();
}

test.beforeAll(async () => {
  administrator = new pg.Pool({ connectionString: databaseUrl });
  await administrator.query(`CREATE SCHEMA ${schemaName}`);
  pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
  await migrate(pool);
  const config = loadConfig({
    DATABASE_URL: databaseUrl,
    APP_ORIGIN: 'http://127.0.0.1',
    NODE_ENV: 'test',
  });
  app = await createApp({
    pool,
    config,
    now: () => new Date(clock),
    provider: new BrowserTestProvider(),
    staticRoot: resolve('apps/web/dist'),
  });
  // An ephemeral test listener, not a Vite/dev/preview server. Closed in afterAll.
  origin = await app.listen({ host: '127.0.0.1', port: 0 });
  config.appOrigin = origin;
});
test.beforeEach(() => {
  clock = Date.now();
});
test.afterAll(async () => {
  await app?.close();
  await pool?.end();
  if (administrator) {
    await administrator.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await administrator.end();
  }
});

test('real browser streams through the API, persists to PostgreSQL and restores without duplicates', async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  await ready(page);
  await expect(page.getByRole('heading', { name: 'С чего начнём?' })).toBeVisible();
  await page.screenshot({ path: 'test-results/gate-desktop.png', fullPage: true });
  await send(page, 'Привет из браузера');
  await expect(page.getByText('Проверочный ответ', { exact: true })).toBeVisible();
  await expect(page.getByText('Сообщение сохранено в PostgreSQL.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Остановить ответ' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('Привет из браузера', { exact: true })).toHaveCount(1);
  await expect(page.getByText('Проверочный ответ', { exact: true })).toHaveCount(1);
  const result = await pool.query<{ count: string }>(
    'SELECT count(*) FROM messages WHERE content=$1',
    ['Привет из браузера'],
  );
  expect(result.rows[0]?.count).toBe('1');
  expect(consoleErrors).toEqual([]);
  await page.screenshot({ path: 'test-results/gate-conversation.png', fullPage: true });
});

test('session cookie is HttpOnly, history is isolated and cross-origin mutations are rejected', async ({
  page,
  browser,
}) => {
  await ready(page);
  await send(page, 'Изолированное сообщение');
  await expect(page.getByText('Сообщение сохранено в PostgreSQL.', { exact: true })).toBeVisible();
  const cookies = await page.context().cookies();
  expect(cookies.find((cookie) => cookie.name === 'gate_session')?.httpOnly).toBe(true);
  expect(await page.evaluate(() => document.cookie)).not.toContain('gate_session');
  const rejected = await page.request.post(`${origin}/api/session`, {
    headers: { origin: 'https://attacker.invalid' },
  });
  expect(rejected.status()).toBe(403);
  const other = await browser.newContext();
  try {
    const otherPage = await other.newPage();
    await ready(otherPage);
    await expect(otherPage.getByText('Изолированное сообщение', { exact: true })).toHaveCount(0);
    await expect(otherPage.getByRole('heading', { name: 'С чего начнём?' })).toBeVisible();
  } finally {
    await other.close();
  }
});

test('stop aborts generation and retains a persisted interrupted answer', async ({ page }) => {
  await ready(page);
  await send(page, 'Проверь отмену');
  await expect(
    page.getByText('Частичный ответ для проверки отмены.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Остановить ответ' }).click();
  await expect
    .poll(async () => {
      const result = await pool.query<{ status: string }>(
        "SELECT status FROM messages WHERE role='assistant' AND content=$1",
        ['Частичный ответ для проверки отмены.'],
      );
      return result.rows[0]?.status;
    })
    .toBe('interrupted');
  await page.reload();
  await expect(
    page.getByText('Частичный ответ для проверки отмены.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Этот текст не должен появиться после отмены.', { exact: false }),
  ).toHaveCount(0);
});

test('an upstream failure preserves partial output and releases the composer', async ({ page }) => {
  await ready(page);
  await send(page, 'Проверь ошибку');
  await expect(page.getByText('Частичный текст до ошибки.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Остановить ответ' })).toHaveCount(0);
  await expect
    .poll(async () => {
      const result = await pool.query<{ status: string }>(
        "SELECT status FROM messages WHERE role='assistant' AND content=$1",
        ['Частичный текст до ошибки.'],
      );
      return result.rows[0]?.status;
    })
    .toBe('error');
  await page.getByRole('textbox', { name: 'Сообщение', exact: true }).fill('Новый запрос');
  await expect(
    page.getByRole('button', { name: 'Отправить сообщение', exact: true }),
  ).toBeEnabled();
});

test('expired session no longer exposes the old cache, messages remain until six-hour cleanup', async ({
  page,
}) => {
  await ready(page);
  await send(page, 'Сообщение до истечения');
  await expect(page.getByText('Сообщение сохранено в PostgreSQL.', { exact: true })).toBeVisible();
  clock += 60 * 60 * 1000 + 1;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'С чего начнём?' })).toBeVisible();
  await expect(page.getByText('Сообщение до истечения', { exact: true })).toHaveCount(0);
  let stored = await pool.query<{ count: string }>(
    'SELECT count(*) FROM messages WHERE content=$1',
    ['Сообщение до истечения'],
  );
  expect(stored.rows[0]?.count).toBe('1');
  clock += 5 * 60 * 60 * 1000 + 1;
  await new Repository(pool, () => new Date(clock)).cleanup();
  stored = await pool.query<{ count: string }>('SELECT count(*) FROM messages WHERE content=$1', [
    'Сообщение до истечения',
  ]);
  expect(stored.rows[0]?.count).toBe('0');
});

test('mobile layout, theme, suggestions and damaged localStorage remain usable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('gate.history.v1', '{invalid'));
  await ready(page);
  await page.getByRole('button', { name: 'Объяснить сложное' }).click();
  await expect(page.getByRole('textbox', { name: 'Сообщение', exact: true })).not.toHaveValue('');
  await page.getByRole('button', { name: 'Включить тёмную тему' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/gate-mobile.png', fullPage: true });
});
