# Backend

`apps/api` — Fastify 5 + TypeScript (ESM), PostgreSQL через `pg`, MVC. Представление — JSON и NDJSON, не HTML-шаблоны.

## Модули

- `src/app.ts`: фабрика приложения, cookie, ограничения запросов, Origin, безопасные ошибки, lifecycle и раздача публичной сборки.
- `src/routes/api.ts`: подключение HTTP-маршрутов с ограничениями частоты и доступом к текущей сессии.
- `src/controllers/stream.ts`: валидация unknown-ввода, NDJSON, backpressure, отмена, таймаут, финализация. Завершённая запись не перезаписывается при позднем disconnect.
- `src/services/generation.ts`: подготовка генерации и взаимодействие репозитория с AIProvider.
- `src/services/maintenance.ts`: минутный цикл восстановления и пакетной TTL-очистки, без перекрывающихся запусков.
- `src/models/repository.ts`: параметризованный SQL, хеши токенов, пагинация, транзакционная идемпотентность, контекст и сохранение сообщений.
- `src/integrations/provider.ts`, `openai.ts`: интерфейс провайдера и настоящий адаптер официального SDK OpenAI.
- `src/database/migrate.ts`, `migrate-cli.ts`: версионированные транзакционные миграции и CLI.
- `src/config.ts`: обязательные `DATABASE_URL` и точный `APP_ORIGIN`; `PORT`, `HOST`, `NODE_ENV`, `OPENAI_MODEL`, серверный `OPENAI_API_KEY`.
- `src/server.ts`: конфигурация, собственный pool, миграции до listen, graceful shutdown SIGINT/SIGTERM.

## Тестовые точки входа

```ts
const config = loadConfig({ DATABASE_URL: testUrl, APP_ORIGIN: 'http://gate.test' });
await migrate(pool); // Pool из pg; schema/search_path можно задать при создании pool
const app = await createApp({
  pool,
  config,
  provider: testOnlyProvider, // опционально; без него используется настоящий OpenAI
  now: () => new Date(), // опциональные часы для TTL
  // staticRoot: '/absolute/path/to/public-build',
});
await app.inject({ method: 'POST', url: '/api/session', headers: { origin: config.appOrigin } });
await app.close();
await pool.end(); // createApp не владеет переданным pool
```

`AIProvider.stream(input: AIInput, signal: AbortSignal): AsyncIterable<string>`, где AIInput — readonly-массив `{role:'user'|'assistant',content:string}`. Контролируемые адаптеры существуют только в тестах; в production нет фиктивных ответов.

`startServer({config, provider?, staticRoot?})` возвращает `{app,pool,address}`, применяет миграции и владеет pool: `app.close()` закрывает его. При завершении сначала прерываются и дожидаются сохранения все генерации, затем останавливается maintenance и закрывается pool.

## Проверки

```sh
pnpm --filter @gate/api test
TEST_DATABASE_URL=postgresql://... pnpm --filter @gate/api test:integration
pnpm --filter @gate/api typecheck
pnpm --filter @gate/api build
pnpm exec eslint apps/api
```

Интеграционные тесты требуют реальную отдельную PostgreSQL БД и очищают в ней таблицы `sessions`, `messages`: не использовать production DATABASE_URL. При отсутствии TEST_DATABASE_URL тесты падают, не пропускаются. HTTP listen в тестах использует временный порт и всегда закрывается; постоянный dev server не требуется.

Сборка `tsup` задаёт `noExternal: ['@gate/contracts']` в `tsup.config.ts`: CLI-флаг `--no-external @gate/contracts` не поддерживается этой версией. Собранный entrypoint — `dist/server.js`.

## Безопасность и эксплуатация

Все мутации требуют Origin, равный APP_ORIGIN. Cookie `gate_session`: HttpOnly, SameSite=Lax, Path=/, Max-Age=3600, Secure в production; валидная cookie не перевыпускается и не продлевает срок сессии. В БД только SHA-256 случайного 256-битного токена. Публичный session.id не даёт доступ к истории.

Ввод — не более 16000 символов после trim, UUID requestId; тело HTTP — не более 100000 байт, чтобы допустимый текст помещался даже в escaped JSON. SQL параметризован. API использует no-store; nosniff включён. Ошибки для UI — безопасные русские сообщения без деталей SDK/БД. Request logging отключён: токены, ключи и текст переписки не печатаются.

Ограничения частоты в памяти одного экземпляра по IP: общий 120/мин, POST session 30/мин, POST stream 20/мин. Прокси-заголовкам IP не доверяем автоматически (`trustProxy:false`); production ingress должен обеспечивать дополнительный лимит, особенно при нескольких экземплярах. Защита от параллельной генерации, в отличие от rate-limit, общая для всех экземпляров через PostgreSQL.

В production сервер раздаёт только `apps/web/dist` через patched @fastify/static 10.1.5 (совместим с Fastify 5), не корень репозитория. Неизвестные API-маршруты возвращают JSON 404. Для разработки используйте прокси frontend на API, а не разрешающий все Origins CORS.
