# HTTP API

Один origin; общий runtime-контракт — `@gate/contracts`. Cookie отправляется браузером, sessionId из query/body не используется для авторизации. На любом POST обязателен `Origin: <APP_ORIGIN>`; отсутствие/несовпадение — 403 INVALID_ORIGIN. Ответы API — Cache-Control: no-store.

## POST /api/session

Без тела. Возвращает Session `{id, expiresAt, serverTime}` с UUID и ISO-временем. Действующая cookie сохраняется без продления TTL. При отсутствующей/просроченной cookie создаётся новая сессия и HttpOnly cookie gate_session. Старая история по новой cookie недоступна.

## GET /api/messages?cursor=<sequence>&limit=<1..100>

Cookie обязательна. Без limit используется 30, без cursor — последние сообщения. Возвращает History `{session,messages,nextCursor}`. Каждая страница хронологическая; nextCursor (строка sequence первого сообщения страницы) запрашивает более старые записи; null означает конец. Просроченные сообщения не выдаются. История показывает также generating/error/interrupted, но AI-контекст их исключает.

Message: `{id,sessionId,sequence,role,content,status,createdAt,expiresAt}`. Нет доступа по публичному UUID сессии без правильной cookie.

## POST /api/messages/stream

Content-Type: application/json. Cookie и Origin обязательны.

```json
{ "content": "Вопрос", "requestId": "2bac9d20-0c1b-48e4-9ce5-1381ac36559e" }
```

content обрезается trim, затем проверяется длина 1..16000; requestId — UUID, новый для каждого нового запроса, тот же для повтора после сетевой ошибки. Один одновременный ответ на сессию. Пользовательская запись сохраняется до вызова ИИ; отдельного user-события нет, UI может отображать оптимистическую запись и сверить историю после окончания.

Успешный HTTP ответ: `application/x-ndjson; charset=utf-8`, одно JSON-событие на строку (не SSE). Прокси не должен буферизовать этот маршрут: сервер ставит X-Accel-Buffering: no.

- `start`: `{type:'start',message:Message}` — сохранённая assistant-запись.
- `delta`: `{type:'delta',messageId,text}` — новый фрагмент, дописывается к тому же сообщению.
- `done`: `{type:'done',message:Message}` — сохранённая complete-запись.
- `error`: `{type:'error',code,message,partial?:Message}` — безопасная ошибка; partial есть только при подтверждённом сохранении.

После начала потока ошибки идут как NDJSON error при уже установленном HTTP 200. Коды: PROVIDER_ERROR, AI_NOT_CONFIGURED, GENERATION_TIMEOUT, GENERATION_INTERRUPTED (повтор прерванного запроса), PERSISTENCE_ERROR. UI должен обрабатывать terminal event и EOF без terminal event (disconnect), затем перечитывать серверную историю.

Повтор уже complete-запроса: start + done сохранённого сообщения, без новых записей/SDK-вызова. Повтор error/interrupted: start + error с сохранённым partial; для новой попытки нужен новый requestId. Уже генерируемый дубль: HTTP 409 GENERATION_IN_PROGRESS. Тот же requestId с другим content: HTTP 409 IDEMPOTENCY_CONFLICT.

## GET /api/health

Проверяет SELECT 1 через pool: 200 `{"status":"ok"}` либо 503 DATABASE_UNAVAILABLE. Доступность ключа/модели не считается готовностью БД и проверяется отдельно.

## Ошибки до начала потока

```json
{ "error": { "code": "SESSION_EXPIRED", "message": "Сессия истекла. Начните новый диалог." } }
```

- 400 INVALID_REQUEST — неправильные данные/пагинация/JSON.
- 401 SESSION_EXPIRED — cookie отсутствует, невалидна, неизвестна или сессия истекла; начать новую через POST session.
- 403 INVALID_ORIGIN — запрещённый Origin.
- 409 GENERATION_IN_PROGRESS / IDEMPOTENCY_CONFLICT.
- 413 INVALID_REQUEST — превышен лимит тела 100000 байт.
- 415 INVALID_REQUEST — неподдерживаемый Content-Type.
- 429 RATE_LIMITED — частота; учитывать Retry-After.
- 404 NOT_FOUND, 500 INTERNAL_ERROR, 503 DATABASE_UNAVAILABLE.

Лимиты по IP одного экземпляра: 120 запросов/мин общий, 30 создания сессий/мин, 20 генераций/мин. Не отправлять токен cookie через localStorage, URL или вручную отображаемые sessionId.
