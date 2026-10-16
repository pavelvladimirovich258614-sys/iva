# IVA × MAX — план нативного канала

Статус: план реализации (код интеграции ещё не написан).
Ветка: `feat/max-channel`. Не меняем `main` до успешных тестов и ревью.

## Цель

Добавить MAX как **равноправный входной/выходной канал** уже существующего агента IVA (eve).
Telegram продолжает работать без изменений. Оба канала используют те же модель,
инструменты, Skills, MCP, индекс и vault памяти. Сессии и идентичности каналов
разделены, а доступ к приватной памяти разрешён только явному allowlist.

## Что подтверждено по коду IVA

- Node.js 24, ESM, TypeScript, `eve@0.27.13`, `npm run build` после правок `agent/*`.
- `agent/agent.ts` — конфигурация модели; **не создавать второго агента**.
- `agent/channels/telegram.ts` — Telegram-specific eve channel, hooks,
  auth, media, reply, outbound/inbound security gates.
- `scripts/telegram-poll.mjs` — Telegram polling → локальный Eve route;
  Telegram queue and settings are tightly coupled to Telegram API.
- `agent/channels/eve.ts` — служебный HTTP-канал с bearer auth.
- `agent/lib/security-gate.ts` — inbound sanitizer + outbound redaction.
- `agent/lib/eve-auth.ts`, `scripts/lib/*auth*` — security boundary.
- `AGENTS.md` и `CLAUDE.md` — обязательные правила ревью.
- `.github/workflows/ci.yml` — Node tests, typecheck, Eve build, replica smoke.

Не копировать 1165 строк `telegram.ts` и 2200 строк `telegram-poll.mjs`.
Проектировать отдельный, небольшой MAX-адаптер с общими защитными функциями.
Проверять *закреплённую* версию eve 0.27.13 (локально `node_modules/eve/docs`);
актуальная документация eve main может описывать другой API.

## Официальные спецификации MAX

- https://dev.max.ru/docs-api
- https://dev.max.ru/docs-api/methods/POST/subscriptions
- https://dev.max.ru/docs-api/objects/Update
- https://dev.max.ru/docs-api/methods/POST/messages
- https://dev.max.ru/docs-api/methods/GET/updates
- https://github.com/max-messenger/max-agents-skill

На дату планирования (2026-10-16):
- API: `https://platform-api2.max.ru`, токен **только** в заголовке
  `Authorization: <token>`, не в URL.
- Для production — webhook, HTTPS 443, валидная полная TLS-цепочка.
- `POST /subscriptions` с `secret`; проверка
  `X-Max-Bot-Api-Secret` (timing-safe compare) **до** обработки.
- Webhook подтверждать HTTP 200 в пределах 30 секунд только после надёжного
  приёма/сохранения события. Повторы MAX не должны дублировать ответы.
- Webhook и Long Polling не могут одновременно получать события.
- `GET /updates` допустим для разработки, но не production.
- `POST /messages`: `?user_id=...` или `?chat_id=...`;
  текст до 4000 символов, не более 2 сообщений в секунду на диалог.
- `GET /chats` после июня 2026 не поддерживается.
- Проверить фактические JSON-поля message/update по OpenAPI, не предполагать
  Telegram-совместимость. ID имеют int64; избегать потери точности JS number.

## Архитектура

```
Telegram bridge / Telegram channel ------+
                                         +--> SAME IVA eve agent
MAX HTTPS webhook -> MAX adapter --------+    -> shared tools, vault, memory
```

Рекомендуемые компоненты (окончательные пути определить после проверки API eve):
- `agent/channels/max.ts` — отдельный пользовательский канал на
  `defineChannel` с маршрутом `POST /eve/v1/max` (сверить API в pinned eve).
- `agent/lib/max-api.ts` либо `scripts/lib/max-api.mjs` — HTTP client для MAX
  с timeout, обработкой 429/5xx, контролем скорости и нарезкой текста.
- `agent/lib/max-updates.ts` либо `scripts/lib/max-updates.mjs` —
  валидатор событий, idempotency key, фильтр типов, извлечение текстов.
- `scripts/max-webhook.mjs` **только если действительно нужен** внешний
  ingress/outbox для durable ACK; иначе внешний nginx -> локальный Eve route.
- `deploy/` — пример reverse proxy для HTTPS; не обнажать весь Eve HTTP API.
- `.env.example`, `docs/configuration.md`, `docs/deploy.md` — опция MAX.

## Первая реализация (MVP)

1. **Private text-only**: `message_created` / `bot_started`, приём /start,
   текст -> существующий агент -> ответ в MAX.
2. Fail-closed `MAX_ALLOWED_USER_IDS`, проверка webhook-secret,
   игнорировать события от ботов, неизвестных и без текста.
3. Пространство сессий `max:<chatId>:<userId>`, отдельное от
   `telegram:...`; principal `max:<userId>`. Никакого доступа
   чужих пользователей к общему vault. Не приравнивать ID разных платформ.
4. Использовать `sanitizeInbound` до передачи пользователем управляемого
   текста в агент и `scanOutbound` до отправки ответов.
5. Идемпотентный приём, bounded queue/ACK, retry с backoff,
   graceful shutdown, отсутствие двух обработок одного события.
6. Ошибки API, timeout, rate limit и разбиение ответов по 4000 символов.
7. Секреты `MAX_BOT_TOKEN`, `MAX_WEBHOOK_SECRET` —
   только untracked env / secrets; пустой allowlist = deny all.
8. MAX выключен по умолчанию, без токена Telegram запускается как раньше.
9. Тесты без реального MAX-токена: mock webhook / mock fetch / fake eve turn.
10. Документация: создать MAX-бота, записать токен, настроить webhook HTTPS,
    `POST /subscriptions`, smoke-check `GET /me`.

## Далее — паритет с Telegram (отдельные PR)

- Фотографии, документы и голосовые через MAX upload/download, Deepgram, vision.
- Кнопки `message_callback`, команда `/new`, отмена хода / очередь.
- Группы/каналы, mention/reply gating и отдельные allowlists/admin policy.
- Уведомления, задачи/digest в MAX, UI настроек с отдельной адаптацией кнопок.
- Проверка сценария общая память + разделённые сессии после явного связывания.

## Проверки и критерии готовности

- `npm ci`
- `node --test agent/lib/*.test.mjs scripts/lib/*.test.mjs scripts/lib/menu/*.test.mjs scripts/*.test.mjs`
- `npm run typecheck`
- `npm run build` (**обязательно** после `agent/*`)
- `npm run replica`
- `git diff --check` и проверка, что секреты/данные не попали в git.
- Позитивные тесты: авторизованный текст -> 1 ответ; идентичности не
  пересекаются; Telegram regression tests проходят.
- Негативные тесты: неверный secret, пустой allowlist, групповые/канальные
  события при private-only MVP, дубликаты, повтор доставки, 429/5xx,
  опасное форматирование, длинные тексты, int64 ID, crash/restart.
- Не объявлять production-ready, пока не проведён smoke test живого webhook
  с отдельным тестовым MAX-ботом.

## Порядок работы облачного кодового агента

Сначала проверь pinned Eve API и разработай минимальный вертикальный срез
«MAX message_created -> eve -> MAX /messages» в этой ветке.
Добавь автоматические тесты и документацию. В конце покажи diff, результаты
команд и проблемы. НЕ коммить токены, НЕ изменяй `main`,
НЕ создавай боевых webhook-подписок без подтверждения владельца.
