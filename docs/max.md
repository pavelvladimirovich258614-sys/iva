# Iva over MAX (MAX-only setup)

MAX is a first-class channel of the **same** Iva agent (same model, memory, skills, MCP tools,
tasks). Telegram is optional and off by default: `npm run setup` offers *MAX*, *Telegram* or *both*,
and a MAX-only install never starts `telegram-poll`, the Telegram userbot, or asks for any
`TELEGRAM_*` value (empty ones are fine).

## Quick start (MAX only)

1. Create a bot on the MAX platform (<https://business.max.ru>, docs: <https://dev.max.ru>) and copy
   its access token.
2. Run the installer (`install.sh`) or `npm run setup` / `iva config` and choose **1) MAX**. The
   wizard validates the token (`GET /me`), generates the internal secret, and finds your user id:
   press *Start* in the bot and send any message, then pick your id from the list.
3. The installer builds Iva and starts two services: `iva` (the agent) and `iva-max-bridge`
   (polling bridge). Open the bot in MAX and write to it. `iva max check` verifies everything.

Nothing else is needed: no public domain, no HTTPS, no Telegram.

### Ingest modes

| `MAX_INGEST` | How events arrive | Needs | Control commands |
|---|---|---|---|
| `poll` (default) | the bridge long-polls `GET /updates` | nothing public | all |
| `webhook` | MAX calls `POST /eve/v1/max` | public HTTPS on 443 + `POST /subscriptions` | `/new /stop /help /usage` only (the rest need the bridge) |

MAX documents long polling as unsuitable for high-load production; for a personal single-user agent
it is the simplest reliable setup. Webhook and polling are mutually exclusive — `iva max check`
warns if a subscription exists while `MAX_INGEST=poll`.

## Commands (all work from MAX)

| Command | Served by | What it does |
|---|---|---|
| plain text, `/task <text>`, `/tasks`, `/digest` | agent | tasks/digest go through the normal agent tools |
| `/new` `/stop` | channel | reset this MAX conversation / cancel the running turn |
| `/help` `/usage [window]` | channel | command list / token spend (no model call) |
| `/menu` | bridge | settings menu with inline buttons (model, thinking, search, language, character, memory, Google, timers, skills, status, maintenance) |
| `/model` `/think` | bridge | provider / model / reasoning wizard (writes `.env`, restart to apply) |
| `/restart` `/update` | bridge | restart the agent / check and install a new version with progress in the same message |

Buttons use MAX inline keyboards (`callback` buttons, payload ≤ 1024); the existing menu engine
runs unchanged through a small Bot-API adapter (`scripts/lib/max-tg.mjs`). API keys typed into the
wizard are captured by the bridge and never reach the agent; MAX may refuse to delete the user's
message — the wizard then asks you to delete it manually.

## Notifications, digests and background jobs

Daily digest, memory reports (daily/weekly), the vault doctor, the nightly update check and the
installer confirmation all use `scripts/lib/notify.mjs`. `NOTIFY_CHANNEL=auto` sends to MAX when
`MAX_BOT_TOKEN` and a recipient (`MAX_NOTIFY_USER_ID`, default: first `MAX_ALLOWED_USER_IDS`) exist,
otherwise to Telegram if configured. If no channel is configured the jobs still run — memory and
tasks never depend on delivery.

## How the channel works

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


## Operations

```sh
iva max check     # token, bot identity, allowlist, webhook subscription, services
iva max status    # outbound queue of the running agent (dead = undelivered replies)
iva max whoami    # user ids that recently wrote to the bot
iva logs bridge   # journal of iva-max-bridge     (iva logs → agent)
iva restart       # agent + bridge
```

Switching channels later: edit `IVA_CHANNELS` (or rerun `iva config`) and `iva restart`; a bridge of
a channel that is no longer enabled is stopped and disabled automatically. Existing Telegram
installs keep working unchanged (channels are inferred from tokens when `IVA_CHANNELS` is absent).

## Security model

- Fail-closed allowlist (`MAX_ALLOWED_USER_IDS`): empty means nobody; strangers get no reply and
  never reach the agent, the menu or the wizards (checked in the bridge *and* in the channel).
- The channel verifies `X-Max-Bot-Api-Secret` in constant time before reading the body; the bridge
  uses the same secret on its loopback hop to `127.0.0.1`. Do not expose the Eve HTTP API: publish
  at most `/eve/v1/max` through a reverse proxy.
- Tokens live only in `.env` (git-ignored), are sent only in the `Authorization` header and are
  never logged or printed. State is under `data/` (untracked, `0600`).
- Inbound text goes through `sanitizeInbound`, outbound through `scanOutbound`.

## Webhook mode (optional)

```sh
curl -X POST https://platform-api2.max.ru/subscriptions \
  -H "Authorization: $MAX_BOT_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"url\":\"https://YOUR_HOST/eve/v1/max\",\"update_types\":[\"message_created\",\"message_callback\",\"bot_started\"],\"secret\":\"$MAX_WEBHOOK_SECRET\"}"
```

Set `MAX_INGEST=webhook`, `iva restart`. **This makes the bot live on that URL — do it
deliberately.** Port 443 and a valid TLS chain are required by MAX.

## Known limits

- Text only: photos, documents, voice and group chats are not handled yet (ignored).
- Replies are plain text (agent markdown is not converted for regular replies; reports use MAX
  `markdown` with a plain fallback).
- `/stop` cancels the active turn; a message sent while the agent is busy is queued by Eve and
  answered after the current turn.
- Field names follow the official schema (`max-messenger/api-schema`, v0.0.33). No live test with a
  real bot was possible in CI — run the checklist below once.

## Live smoke checklist (separate test bot)

1. `iva max check` — token valid, allowlist as expected, no unexpected webhook.
2. Write "hi" → answer arrives once. Send `/help`, `/usage`, `/tasks`.
3. `/menu` → open *Status*, press *‹ Menu*, *✖ Close*; `/model` → *Cancel*.
4. Stranger account writes → no answer, nothing in `iva logs`.
5. `iva restart` while chatting → bridge and agent come back, no duplicate answers.
6. `iva max status` → `dead: 0`.

## Testing

- Unit: `node --test agent/lib/max-*.test.mjs scripts/lib/max-*.test.mjs scripts/lib/notify.test.mjs`.
- End-to-end on the built Eve server with mock model and mock MAX API (bridge, buttons, restart,
  agent downtime): `npm run test:max-e2e` (Node 24).
- Test-only env: `MAX_API_BASE_URL` (https, or http on loopback), `MAX_OUTBOX_BACKOFF_MS`,
  `MAX_MIN_SEND_INTERVAL_MS`.
