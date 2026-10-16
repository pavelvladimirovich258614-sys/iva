# MAX channel (MVP, opt-in)

A second channel to the **same** Iva agent (same model, tools, skills, vault). Telegram is unaffected:
without `MAX_BOT_TOKEN` + `MAX_WEBHOOK_SECRET` the route answers `404` and nothing starts.

Scope of the MVP: private text messages, `/start`, `/new`, `bot_started`. Not yet: media, voice,
buttons, groups/channels (ignored), task/digest delivery.

## How it works

`POST /eve/v1/max` (custom eve channel, `agent/channels/max.ts`):

1. `X-Max-Bot-Api-Secret` is compared in constant time **before** anything else → `401`.
2. The body is read as a stream with a hard byte limit (256 KB) and a 10 s time limit, checked
   while reading — a missing/lying `Content-Length` or a never-ending stream cannot exhaust memory
   (`413` / `408`).
3. Only private-dialog (`recipient.chat_type == "dialog"`) text from humans is processed;
   everything else gets `200` and is dropped. Schema nullables (`sender`, `recipient.chat_id`,
   `body.text`) are handled; int64 ids stay strings (no precision loss).
4. Sender must be in `MAX_ALLOWED_USER_IDS` (empty = nobody). Others are silently ignored.
5. Events of one user are processed one at a time. A duplicate that arrives while the first copy is
   running waits for it: if the first succeeded → `200` without a second turn; if it failed → the
   duplicate is processed itself. A stale in-flight claim answers `503`, never a false `200`.
6. **ACK contract.** `200` is returned only after the event was durably accepted: eve `send()`
   returned (it persists a workflow run / resume hook and does *not* wait for the model) and the
   event id was written to `data/max/state.json`. Failure before that → `5xx`, MAX redelivers.
7. Text passes `sanitizeInbound`; the reply passes `scanOutbound`.

### Delivery guarantees (honest version)

- **Inbound: at-least-once.** If the process dies after `send()` succeeded but before the event id
  is written, MAX's redelivery runs the turn again. Accepted events survive restarts (7-day TTL).
  Exactly-once is not provided and not claimed.
- **Outbound: durable outbox, at-least-once.** Replies are chunked (≤4000 chars) and stored in
  `data/max/outbox.json` *before* sending; one worker per dialog sends strictly in order, ≥550 ms
  apart (MAX limit: 2 msg/s per dialog). `429`/`5xx`/network errors retry with exponential backoff
  (honours `Retry-After`, 8 attempts); other `4xx` fail immediately. Undelivered replies survive a
  restart. The MAX schema has no idempotency key for `POST /messages`, so a retry after a lost
  response can post a duplicate.
- **Diagnostics.** Failed items stay in `outbox.json` as `dead` (metadata only, no text) and are
  logged as `DELIVERY FAILED permanently`. `GET /eve/v1/max/status` (same secret header) shows
  counts and dead items.
- **eve 0.27.13 caveat.** The replica smoke documents a known eve issue: resuming a *parked*
  session after a server restart can silently drop the message. It affects every channel.

Identity: continuation token `max:dialog:<userId>`, principal `max:<userId>` — never equal to a
Telegram id. Replies go to the last seen `chat_id` of the dialog, or to `user_id` when MAX did not
supply one.

State lives in `data/max/` (untracked, files `0600`). Run a single Iva instance per data dir.

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

- Field names follow the official schema (`max-messenger/api-schema`, `schema.yaml`, v0.0.33).
  No live smoke test with a real bot has been done yet; `429` is handled although the schema only
  lists `401/403/500` for `POST /messages`.
- Replies are plain text (no MAX markdown formatting yet).

## Testing

- Unit: `node --test agent/lib/max-*.test.mjs`.
- End-to-end on the built eve server with mock model and mock MAX API: `npm run test:max-e2e`
  (needs Node 24; covers auth, allowlist, body limit, round trip, dedup, `/new`, outbox retry,
  restart durability).
- Optional env for tests/diagnostics: `MAX_API_BASE_URL` (https, or http on loopback only),
  `MAX_OUTBOX_BACKOFF_MS`, `MAX_MIN_SEND_INTERVAL_MS`.
