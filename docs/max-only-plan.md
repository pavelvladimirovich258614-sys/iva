# IVA в режиме MAX-only: аудит зависимостей и план

Цель: поставить IVA, подключить **только** MAX-бота и управлять агентом целиком из MAX.
Telegram — необязательный канал, по умолчанию выключен; исходный код не удаляется.

## Аудит: что сегодня требует Telegram

| Область | Где | Жёсткая зависимость? | Решение |
|---|---|---|---|
| Установка | `scripts/setup.mjs` (шаг 3: BotFather, `getMe`, `getUpdates`, `REQUIRED` содержит `TELEGRAM_*`) | да | выбор канала; MAX-ветка: токен → `GET /me`, user_id определяется по первому сообщению через `GET /updates`; Telegram-ветка не вызывается |
| Установка | `install.sh` (подтверждение через api.telegram.org, `systemctl enable iva-telegram-poll`, итоговые подсказки) | да | канал-зависимые шаги, юнит `iva-max-bridge` |
| CLI/сервисы | `bin/iva.mjs`: `SERVICES=[iva, iva-telegram-poll]`, `restart/reset/logs/update/config`, `createTelegramUpdateReporter` | да | список сервисов выводится из выбранных каналов; userbot остаётся opt-in |
| Ввод сообщений | `scripts/telegram-poll.mjs` (2200 строк: polling, очередь, команды, меню, визарды) | да | новый компактный `scripts/max-bridge.mjs`: long-poll `GET /updates` → тот же `handleMaxWebhook`; команды и меню вынесены в общий слой |
| Канал агента | `agent/channels/telegram.ts` | нет (грузится всегда, но без токена пассивен) | не трогаем; `agent/channels/max.ts` — равноправный канал |
| Уведомления | `scripts/daily-digest.ts`, `scripts/memory/rollup.ts`, `scripts/memory/doctor.ts`, `scripts/check-update.mjs` + `lib/update-check.mjs`, `lib/telegram-send.mjs`, `lib/notification-chat.mjs` | да (выходят с ошибкой/пропускают отчёт без `TELEGRAM_BOT_TOKEN`) | единый `scripts/lib/notify.mjs` с бэкендами MAX/Telegram; задачи и память не зависят от доставки |
| Меню/мастера | `scripts/lib/menu/*`, `lib/tg-flow.mjs`, визарды `/model` `/think` внутри `telegram-poll.mjs` | через `tg(method, params)` | MAX-адаптер с тем же интерфейсом `tg()` (sendMessage/editMessageText/answerCallbackQuery → `POST/PUT /messages`, `POST /answers`); inline-клавиатуры MAX (`callback`-кнопки, payload ≤1024) |
| Команды | `/task`, `/tasks`, `/digest` уходят агенту как текст; `/stop`, `/new` — управление сессией; `/usage`, `/help`, `/restart`, `/update`, `/model`, `/think`, `/menu` — вне модели | частично | в канале (in-process): `/new` `/stop` `/help` `/usage`; в мосте: `/restart` `/update` `/menu` `/model` `/think` |
| Run-status / «Стоп» | `lib/run-status.mjs` + события канала | Telegram-ключи | `/stop` через eve `cancel()` в роуте MAX |
| Userbot | `services/telegram-userbot`, `iva userbot` | opt-in | остаётся opt-in, в MAX-only не ставится и не запускается |
| Прочее | `agent/skills/rich-post` (Telegram rich), `telegram-userbot` skill | skill-специфично | в MAX-only не активируются/помечаются как Telegram-only |

Пустые `TELEGRAM_*` не должны вызывать ошибок нигде: проверяется тестом/e2e без единой Telegram-переменной.

## Решение по приёму событий

Webhook MAX требует публичный HTTPS (443) — для личной self-host установки это лишний барьер.
Схема MAX даёт `GET /updates` (long polling, `marker`, `timeout ≤ 90`), но документация называет
его непригодным для production (ограничения скорости/хранения). Для одного пользователя это
приемлемо, поэтому **по умолчанию** — `iva-max-bridge` (polling), а webhook остаётся
поддерживаемым режимом (`MAX_INGEST=webhook`). Мост и webhook используют один и тот же
обработчик, дедуп и outbox: второй агент и второй пайплайн не создаются.
Webhook-подписка и polling взаимоисключающи; мост предупреждает, если подписка существует.

## Этапы

1. ✅ Надёжность webhook (inbox/outbox, лимиты, e2e) — коммит `814ad23`.
2. Единые уведомления `notify.mjs` (дайджест, отчёты памяти, doctor, update-check) + тесты без `TELEGRAM_*`.
3. MAX-мост (`max-bridge.mjs`): polling → обработчик, команды, меню/мастера, callback-кнопки.
4. Установка и эксплуатация: `setup.mjs`, `install.sh`, `bin/iva.mjs`, systemd-юниты, `.env.example`, документация.
5. Проверки MAX-only: typecheck, build, replica, e2e без `TELEGRAM_*`, рестарт, фоновые задачи.
