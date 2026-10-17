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

## Этапы (статус)

1. ✅ Надёжность webhook (inbox/outbox, лимиты, e2e) — `814ad23`.
2. ✅ Единые уведомления `scripts/lib/notify.mjs` (дайджест, отчёты памяти, doctor, update-check) — `348a6fa`.
3. ✅ MAX-мост `scripts/max-bridge.mjs`: polling → единый канал, `/menu` `/model` `/think` `/restart` `/update`, кнопки — `f51396c`.
4. ✅ Установка и эксплуатация: `IVA_CHANNELS`, `setup.mjs`, `install.sh`, `bin/iva.mjs` (сервисы, doctor, `iva max`), юнит `iva-max-bridge`, инструкции агента, документация.
5. ✅ Проверки MAX-only: typecheck, build, replica, e2e без `TELEGRAM_*` (агент, мост, кнопки, рестарт, фоновые задачи), юнит-тесты установки.

## Не проверено вживую

- Реальный MAX API (боевой бот): форматы взяты из `max-messenger/api-schema` (v0.0.33), живого теста не было.
- Интерактивный прогон `install.sh`/мастера целиком и настоящий systemd (в тестах — подменённый `systemctl`).
- Удаляет ли MAX сообщения пользователя с ключом (иначе мастер просит удалить вручную).
- Принимает ли `PUT /messages` правку только клавиатуры без текста (используется для снятия кнопок, ошибка игнорируется).

## Этап 6 — production-ready webhook (статус)

- ✅ Контракт подтверждения: `commit()` бросает при сбое записи; нет ложных 200; битые файлы видны в health.
- ✅ Явные статусы управляющих команд (ok / error / retry), ошибки не поглощаются; журнал защищает `/restart` и `/update` от повторного запуска.
- ✅ Webhook-приёмник в мосте: секрет до тела, лимиты, один путь; polling и webhook делят `process(update)`.
- ✅ Переключение транспортов без одновременного приёма (блокировка, защита по подписке, упорядоченный `iva max webhook set|off`).
- ✅ Секреты не вводятся в чат MAX (`iva secret set`), opt-in `MAX_SECRETS_IN_CHAT=1`.
- ✅ e2e на собранном Eve: `npm run test:max-webhook-e2e`; независимый CI `.github/workflows/max-channel.yml`.
- ⏳ Требует настоящего MAX-бота и настоящего сервера: см. «Live smoke checklist» в docs/max.md.
