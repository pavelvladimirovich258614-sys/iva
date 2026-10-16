# MAX channel (MVP, opt-in)

A second channel to the **same** Iva agent (same model, tools, skills, vault). Telegram is unaffected:
without `MAX_BOT_TOKEN` + `MAX_WEBHOOK_SECRET` the route answers `404` and nothing starts.

Scope of the MVP: private text messages, `/start`, `/new`, `bot_started`. Not yet: media, voice,
buttons, groups/channels (ignored), task/digest delivery.

## How it works

`POST /eve/v1/max` (custom eve channel, `agent/channels/max.ts`):

1. `X-Max-Bot-Api-Secret` is compared in constant time **before** anything else → `401`.
2. Body is size-capped; int64 ids are kept as strings (no precision loss).
3. Only private-dialog text from humans is processed; everything else gets `200` and is dropped.
4. Sender must be in `MAX_ALLOWED_USER_IDS` (empty = nobody). Others are silently ignored.
5. Redelivered events are deduplicated (in-memory, 1 h TTL). If the agent cannot accept the
   message the route returns `500` so MAX retries, and the dedup mark is released.
6. Text passes `sanitizeInbound`; the agent's reply passes `scanOutbound`, is split into
   ≤4000-character messages and sent via `POST /messages?chat_id=…` with `Authorization: <token>`
   (retries on network errors, `429`, `5xx`; ≥550 ms between messages in one dialog).

Identity: session token `max:<chatId>:<userId>`, principal `max:<userId>` — never equal to a Telegram id.

## Connect

1. Create a bot on MAX (platform docs: https://dev.max.ru) and copy its token.
2. In `.env` (untracked): `MAX_BOT_TOKEN`, `MAX_WEBHOOK_SECRET` (random, A-Z a-z 0-9 _ -),
   `MAX_ALLOWED_USER_IDS` (your MAX user id).
3. `npm run build` and restart Iva (changes under `agent/*` need a rebuild).
4. Expose **only** `/eve/v1/max` over HTTPS (port 443, valid chain) through a reverse proxy; do not
   publish the rest of the Eve HTTP API.
5. Smoke check the token: `curl -H "Authorization: $MAX_BOT_TOKEN" https://platform-api2.max.ru/me`.
6. Subscribe the webhook (**this makes the bot live — do it deliberately**):

   ```sh
   curl -X POST https://platform-api2.max.ru/subscriptions \
     -H "Authorization: $MAX_BOT_TOKEN" -H 'Content-Type: application/json' \
     -d "{\"url\":\"https://YOUR_HOST/eve/v1/max\",\"update_types\":[\"message_created\",\"bot_started\"],\"secret\":\"$MAX_WEBHOOK_SECRET\"}"
   ```

Webhook and long polling cannot be active at the same time.

## Caveats

- Field names and limits follow `docs/max-channel-plan.md`; they were **not** re-verified against
  live dev.max.ru docs when this was written (host unreachable from the build sandbox) and no live
  smoke test with a real bot has been done. Do this before relying on it.
- Dedup is in-memory: a process restart forgets seen events.
- Replies are plain text (no MAX markdown formatting yet).
