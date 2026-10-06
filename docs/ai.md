# AI-интеграция

Серверный адаптер `OpenAIProvider` использует официальный SDK `openai` 6 и Responses API. Модель по умолчанию — `gpt-5.6-terra`; при необходимости задаётся OPENAI_MODEL на сервере. Ключ только в OPENAI_API_KEY на сервере: не возвращается клиенту, не попадает в public build и логи.

Официальные ссылки для оператора:

- https://developers.openai.com/api/docs/models/gpt-5.6-terra
- https://developers.openai.com/api/docs/guides/streaming-responses

## Stateless-контекст

Каждый Responses-запрос передаёт input явно: максимум 10 последних complete-сообщений в хронологическом порядке, включая только что сохранённый user-запрос. generating/error/interrupted и просроченные сообщения не включаются. Лимит — число сообщений, не число пар. Поэтому контекст может начинаться с assistant; передаются самостоятельные текстовые записи с явной ролью. previous_response_id, Conversations API и скрытая история провайдера не используются. `store:false`, `stream:true`, `max_output_tokens:4096`, SDK maxRetries:0.

Получаем response.output_text.delta; завершение подтверждается response.completed. response.failed, response.incomplete, error, refusal или EOF без completed считаются ошибкой, не успешным пустым ответом.

## Жизненный цикл

1. Авторизация/Origin/ввод и DB-защита идемпотентности.
2. Короткая транзакция: user complete, assistant generating, контекст; COMMIT до SDK.
3. start → delta; PassThrough поддерживает backpressure.
4. Накопленный текст и heartbeat сохраняются примерно раз в секунду; не один UPDATE на токен.
5. Финальный complete сохраняется до done. Поздний disconnect не может превратить уже complete в interrupted.

Таймаут 120 секунд: upstream AbortSignal, partial interrupted, GENERATION_TIMEOUT для подключённого клиента. Disconnect и shutdown тоже прерывают upstream, сохраняют partial interrupted. Ошибка провайдера сохраняет partial error. Дополнительный предел накопленного текста — 200000 символов. Уже авторизованный поток может завершиться после истечения часовой сессии в пределах своего таймаута; новые запросы после истечения запрещены.

При проблеме БД финализация делает best effort, не выдаёт несохранённый partial за подтверждённый. PERSISTENCE_ERROR просит перечитать историю; последняя сохранённая запись восстанавливается maintenance после устаревания heartbeat.

Без ключа session/history/health работают, но генерация завершается реальной AI_NOT_CONFIGURED с русским сообщением о настройке OPENAI_API_KEY администратором. Нет fallback с фиктивным ответом.

## Проверка и границы

Автоматические тесты используют явно переданный test-only AIProvider и настоящий PostgreSQL. Отдельный тест проверяет настоящий официальный SDK через локальный тестовый HTTP/SSE transport: store:false, input, модель, лимит токенов и streaming. Это не подтверждает доступ конкретного OpenAI проекта к модели. Реальный live-запрос требует настроенного ключа и отдельно проверяется оператором; без него нельзя заявлять, что внешняя генерация подтверждена.
