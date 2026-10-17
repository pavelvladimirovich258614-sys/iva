# Iva over MAX (MAX-only setup)

MAX is a first-class channel of the **same** Iva agent (same model, memory, skills, MCP tools,
tasks). Telegram is optional and off by default: `npm run setup` offers *MAX*, *Telegram* or *both*,
and a MAX-only install never starts `telegram-poll`, the Telegram userbot, or asks for any
`TELEGRAM_*` value (empty ones are fine).

## Topology

```
                        ┌─────────── iva-max-bridge (user systemd unit) ───────────┐
 MAX ── webhook ──▶ reverse proxy ──▶ 127.0.0.1:8725/max/webhook ─┐                │
 MAX ◀─ long polling GET /updates ────────────────────────────────┤  process(update)│
                                                                   ▼                │
                       local control (menu, /model, /think, /restart, /update,     │
                       buttons)  ──  systemctl --user / systemd-run --user / .env   │
                                                                   │ everything else│
                                                                   ▼                │
                                   POST 127.0.0.1:IVA_PORT/eve/v1/max (secret) ─────┘
                                   iva.service (Eve) → agent → durable outbox → MAX Bot API
```

Exactly one transport receives events (`MAX_INGEST`), both feed the **same** `process(update)`, so
every command behaves identically over webhook and polling. Eve listens on `127.0.0.1` only and is
never published; the reverse proxy exposes **one path**: `/max/webhook`
(`deploy/nginx-max-webhook.conf.example`).

## Quick start (MAX only)

1. Create a bot on the MAX platform (<https://business.max.ru>, docs: <https://dev.max.ru>) and copy
   its access token.
2. Run the installer (`install.sh`) or `npm run setup` / `iva config` and choose **1) MAX**. The
   wizard validates the token (`GET /me`), generates the internal secret, finds your user id (press
   *Start* in the bot and send a message) and asks how MAX should deliver events.
3. The installer builds Iva and starts two services: `iva` (the agent) and `iva-max-bridge`.
   `iva max check` verifies everything.

### Ingest modes

| `MAX_INGEST` | How events arrive | Needs | Parity |
|---|---|---|---|
| `webhook` | MAX calls your HTTPS URL → proxy → bridge listener | domain, TLS on 443, `iva max webhook set <url>` | full |
| `poll` (default for a fresh install) | the bridge long-polls `GET /updates` | nothing public | full |

MAX's own documentation recommends **webhook for production** and limits long polling (speed,
retention) to development and testing — use webhook for permanent operation and polling to get
started without a domain. Parity is verified by an end-to-end test that runs the same scenarios
over both transports.

### Switching polling ↔ webhook (never two transports at once)

```sh
iva max webhook set https://iva.example.com/max/webhook   # polling → webhook
iva max webhook off                                       # webhook → polling
iva max webhook status
```

Each switch is ordered: **stop the bridge → change the subscription at MAX → update `.env` → start
the bridge**. Safeguards against double reception: a host-wide transport lock
(`data/max/transport.lock`); a polling bridge refuses to start while a webhook subscription exists
(exit code 78, not restarted by systemd); an event that arrives through the other transport during
a switch is deduplicated (chat events by message id in the channel, commands by id in the ledger).
`webhook set` publishes the bot on that URL — it asks for confirmation (`--yes` to skip); the
wizard itself never registers anything.

## Commands (identical in both modes)

| Command | Served by | Needs system rights? | What it does |
|---|---|---|---|
| plain text, `/task <text>`, `/tasks`, `/digest` | agent (channel) | no | tasks/digest go through the normal agent tools |
| `/new` `/stop` | channel | no | reset this MAX conversation / cancel the running turn |
| `/help` `/usage [window]` | channel | no (reads `data/usage.jsonl`) | command list / token spend, no model call |
| `/menu` + buttons | bridge | partly: Maintenance screens | settings menu (model, thinking, search, language, character, memory, Google, timers, skills, status) |
| `/model` `/think` | bridge | writes `.env` | provider / model / reasoning wizard (restart to apply) |
| `/restart` | bridge | `systemctl --user restart iva.service` | restart the agent (also resets the MAX session) |
| `/update` | bridge | `systemd-run --user` (runs `iva update`) | check and install a new version, progress in one message |

Nothing needs root: the bridge and the agent run as your unprivileged user, and the bridge only
touches the user's systemd instance and `.env`. The Eve control routes (`/eve/v1/session…`,
`/eve/v1/max/reset`, `/eve/v1/max/status`) stay on loopback.

## Secrets and keys

MAX is not asked to carry secrets by default. API keys of models/search, the MAX token, and Google
`client_secret`/login codes are entered **locally on the server**:

```sh
iva secret set OLLAMA_API_KEY       # hidden input (or: printf %s "$KEY" | iva secret set NAME)
iva secret set MAX_BOT_TOKEN        # verified with GET /me before it is saved
```

The `/model` wizard and menu screens answer with this command instead of asking you to type a key
into the chat, because deletion of a user's message by the bot is not proven for MAX. The opt-in
`MAX_SECRETS_IN_CHAT=1` re-enables chat entry (the bridge logs a warning) — use it only if you have
verified deletion yourself. `iva secret set` writes `.env` with mode `0600`; values never appear in
terminal output or logs.

## Control layer: statuses and redelivery

`process(update)` returns an explicit status:

| Status | Meaning | Webhook response | Polling |
|---|---|---|---|
| `ok` | handled (or safely ignored / already done) | `200` | marker advances |
| `error` | the command failed, **the user was told why**; not retried | `200` | marker advances |
| `retry` | temporary failure (agent down, journal unwritable, user could not be notified) | `503` | same update repeated with backoff, marker stays |

Errors from menus, wizards, update and restart are never swallowed: the user gets
`⚠️ <command>: <reason>` (secrets redacted). Redelivery is safe because every control command and
button has a key (`mid` / `callback_id`) in `data/max/control.json`:

- navigation/cancel/wizard steps are idempotent and simply run again;
- `/restart`, `/update`, "Update", "Restart now" and every state-changing menu action write
  `started` to disk **before** running. If that write fails the command is **not** started (`503`).
  A redelivery after completion is acknowledged without running anything; a redelivery after a
  crash in the middle answers *"outcome unknown, not re-run"* — you decide whether to repeat it.

## Notifications, digests and background jobs

Daily digest, memory reports (daily/weekly), the vault doctor, the nightly update check and the
installer confirmation all use `scripts/lib/notify.mjs`, independent of the ingest mode.
`NOTIFY_CHANNEL=auto` sends to MAX when `MAX_BOT_TOKEN` and a recipient (`MAX_NOTIFY_USER_ID`,
default: first `MAX_ALLOWED_USER_IDS`) exist, otherwise to Telegram if configured. If no channel is
configured the jobs still run — memory and tasks never depend on delivery.

## How the channel works

The agent-side channel (`POST /eve/v1/max` on loopback, custom eve channel `agent/channels/max.ts`) is what the bridge forwards chat to:

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
   acknowledgement was written to `data/max/state.json` (atomic write + `fsync`). Failure before
   that → `5xx`, MAX redelivers. If the action ran but the acknowledgement cannot be written (disk
   full, permissions) the channel answers `5xx` too — it never claims a durable ack it does not
   have — and keeps the event marked in memory, so redeliveries in the same process neither run a
   second turn nor get a false `200` until the file is written. Saving the Eve run and writing the
   dedup record are two separate operations without a shared transaction, so **exactly-once is not
   provided**: a crash between them replays the turn.
7. Text passes `sanitizeInbound`; the reply passes `scanOutbound`.

### Delivery guarantees (honest version)

- **Inbound chat: at-least-once.** If the process dies after `send()` succeeded but before the
  acknowledgement is on disk, MAX's redelivery runs the turn again. Accepted events survive restarts
  (7-day TTL). Exactly-once is not provided and not claimed.
- **Inbound control commands: at-most-once for dangerous ones.** See *Control layer* below.
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
iva max status    # delivery queue + storage health of the running agent (dead = undelivered replies)
iva max whoami    # user ids that recently wrote to the bot
iva max webhook status   # ingest mode, subscriptions at MAX, local listener
iva logs bridge   # journal of iva-max-bridge     (iva logs → agent)
iva restart       # agent + bridge
```

Switching channels later: edit `IVA_CHANNELS` (or rerun `iva config`) and `iva restart`; a bridge of
a channel that is no longer enabled is stopped and disabled automatically. Existing Telegram
installs keep working unchanged (channels are inferred from tokens when `IVA_CHANNELS` is absent).

## Security model

- Fail-closed allowlist (`MAX_ALLOWED_USER_IDS`): empty means nobody; strangers get no reply and
  never reach the agent, the menu, the wizards or the system commands (checked in the bridge *and*
  again in the channel).
- Webhook: the bridge verifies `X-Max-Bot-Api-Secret` in constant time **before** reading the body,
  reads it as a bounded stream (256 KB / 10 s), accepts only `POST /max/webhook` and answers
  `/healthz`; every other path is `404`. The bridge → Eve hop uses the same secret on `127.0.0.1`.
- Only `/max/webhook` is published; Eve stays on loopback. The listener binds `127.0.0.1` unless
  `MAX_BRIDGE_HOST` says otherwise (a warning is logged).
- Tokens live only in `.env` (git-ignored, `0600`), are sent only in the `Authorization` header and
  are never logged or printed. State is under `data/max/` (untracked, `0600`).
- Inbound text goes through `sanitizeInbound`, outbound through `scanOutbound`; error texts shown in
  chat pass the same redaction.

## Webhook setup (recommended for permanent use)

1. A domain with a valid TLS certificate; reverse proxy from `deploy/nginx-max-webhook.conf.example`
   (publishes only `/max/webhook` → `127.0.0.1:8725`).
2. `iva max webhook set https://YOUR_DOMAIN/max/webhook` — registers the subscription with
   `update_types` `message_created`, `message_callback`, `bot_started` and your `MAX_WEBHOOK_SECRET`
   (MAX echoes it in `X-Max-Bot-Api-Secret`), writes `MAX_INGEST=webhook`, restarts the bridge.
3. `iva max check` — the listener answers, the subscription is registered.

MAX requires port 443 and a complete certificate chain, and expects `200` within 30 seconds; the
bridge answers `503` when the agent is unavailable so MAX redelivers.

## Known limits

- Text only: photos, documents, voice and group chats are not handled yet (ignored).
- Replies are plain text (agent markdown is not converted for regular replies; reports use MAX
  `markdown` with a plain fallback).
- `/stop` cancels the active turn; a message sent while the agent is busy is queued by Eve and
  answered after the current turn.
- Google account linking from MAX is done on the server (`gws auth login`), not through chat.
- Field names follow the official schema (`max-messenger/api-schema`, v0.0.33). No live test with a
  real bot was possible in CI — run the checklist below once.

## Live smoke checklist (separate test bot, before relying on it)

Polling and webhook, one after the other:

1. `iva max check` — token valid, allowlist as expected, subscription state matches `MAX_INGEST`.
2. Write "hi" → answer arrives once. `/help`, `/usage`, `/tasks`, `/task buy milk`, `/digest`.
3. `/menu` → *Status* → *‹ Menu* → *✖ Close*; `/model` → change model → *Restart now* → the agent
   comes back with the new model; `/think`.
4. `/update` (up to date / update offered); on a throw-away install press *Update*.
5. Stranger account writes and presses an old button → nothing happens, nothing in `iva logs`.
6. `iva restart` while chatting; `kill -9` the bridge during `/restart` and watch MAX redeliver →
   *"outcome unknown"*, no second restart.
7. `iva max webhook set …` / `off` round trip; verify no message is processed twice.
8. `iva max status` → `dead: 0`, no storage warnings.

## Testing

- Unit: `node --test agent/lib/max-*.test.mjs scripts/lib/max-*.test.mjs scripts/lib/notify.test.mjs`.
- End-to-end on the built Eve server with mock model and mock MAX API (Node 24):
  `npm run test:max-e2e` (channel + polling bridge) and `npm run test:max-webhook-e2e` (production
  topology: webhook listener → access control → commands/buttons/model change → MAX replies;
  redelivery, process crash, agent downtime, unwritable journal, polling ↔ webhook switch).
- CI: `.github/workflows/max-channel.yml` runs all of the above on every push to `feat/max-channel`.
- Test-only env: `MAX_API_BASE_URL`, `IVA_CATALOG_BASE_URL_<PROVIDER>` (https, or http on loopback),
  `MAX_OUTBOX_BACKOFF_MS`, `MAX_MIN_SEND_INTERVAL_MS`.
