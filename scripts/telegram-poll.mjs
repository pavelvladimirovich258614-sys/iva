#!/usr/bin/env node
// Telegram long-polling bridge → local eve webhook route.
//
//   node --env-file=.env scripts/telegram-poll.mjs
//
// The eve Telegram channel works ONLY via webhook (POST /eve/v1/telegram, validating
// the X-Telegram-Bot-Api-Secret-Token header). On a bare VPS there is no public HTTPS,
// so we fetch updates from Telegram ourselves (getUpdates, long-poll) and POST them to
// the local eve route with the same secret — Telegram sees an ordinary bot, no proxy needed.
// The channel/agent are unchanged. Webhook and polling are mutually exclusive → deleteWebhook on start.
import { readFile, writeFile, mkdir, rm, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { readEntries, summarize, formatUsageReport, parseWindow } from "./lib/usage.mjs";
import { readEnvFresh, readEnvValues, upsertEnv } from "./lib/env-file.mjs";
import {
  CATALOG,
  EFFORTS,
  fetchModelOptions,
  checkKey,
  providerSupportsReasoning,
} from "./lib/model-catalog.mjs";
import {
  ModelValidationError,
  validateModelSelection,
} from "./lib/model-validation.mjs";
import { getAccessToken, runDeviceCodeLogin } from "./lib/codex-oauth.mjs";
import { compactNumber, modelSummary } from "./lib/model-summary.mjs";
import { acquireUpdateLock, releaseUpdateLock } from "./lib/update-safety.mjs";
import { inspectUpstream, markVersionNotified, updateOffer } from "./lib/update-check.mjs";
// ESC-остановка: канал пишет в data/run-status.d, идёт ли сейчас ход по чату;
// мост по нему буферизует входящие (см. очередь ниже) и обслуживает /stop.
import {
  getChatStatus,
  isRunning,
  listChatStatuses,
  RUN_STALE_MS,
  setChatStatus,
  setChatStatusIf,
} from "./lib/run-status.mjs";
import { classifyDeliverStatus } from "./lib/deliver-policy.mjs";
import { alreadyDelivered, parseOffsetFile, serializeOffsetFile } from "./lib/offset-store.mjs";
import { continuationTokenForControl, requestTelegramReset } from "./lib/telegram-reset.mjs";
import { toChannelLocalToken } from "./lib/telegram-continuation-token.mjs";
import {
  clearTelegramResetIntent,
  loadTelegramResetIntents,
  persistTelegramResetIntent,
} from "./lib/telegram-reset-intent.mjs";
import {
  addTelegramQueueReceipt,
  TELEGRAM_ACCEPTANCE_KIND_HEADER,
  TELEGRAM_ACCEPTANCE_ROUTE,
} from "./lib/telegram-acceptance.mjs";
import {
  acknowledgeQueueHead,
  clearQueueFileKey,
  enqueueQueueFile,
  isReplyToBot,
  loadQueueFile,
  materializeQueueItem,
  migrateQueueFile,
  queueCount,
  queueHead,
  queueKeys,
  shouldQueueBusyUpdate,
  TELEGRAM_QUEUE_FATAL_DURABILITY,
  writeQueueFileAtomic,
} from "./lib/telegram-queue.mjs";
import {
  COLLECT_QUIET_MS,
  collectorOffer,
  collectorPending,
  collectorRestore,
  collectorTakeExpired,
  createCollector,
} from "./lib/telegram-collect.mjs";
// Двуязычие: единый источник языка (getLang) + одна таблица команд (COMMANDS) для /help
// и синего командного меню Telegram. tr(en, ru) — функция (язык не замораживаем в const).
import { getLang, tr, helpText, botCommands } from "./lib/i18n.mjs";
// Session-store out-of-band диалогов: /model, /think и /menu делят ОДИН слот на пользователя.
import { createFlows } from "./lib/tg-flow.mjs";
import { createModelWizard } from "./lib/model-wizard.mjs";
// Движок вложенного inline-меню (/menu) — весь UI настроек в мосте, out-of-band.
import { createMenu } from "./lib/menu/index.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BOT_USER_ID = /^(\d+):/.exec(TOKEN ?? "")?.[1] ?? null;
const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME ?? "my_bot";
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN;
const PORT = process.env.IVA_PORT ?? "8723";
const HOST = (process.env.ASSISTANT_HOST ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const DATA_DIR_RAW = process.env.ASSISTANT_DATA_DIR ?? "data";
const DATA_DIR = DATA_DIR_RAW.startsWith("/") ? DATA_DIR_RAW : join(ROOT, DATA_DIR_RAW);
// Absolute paths for the /model wizard: .env is read fresh (this process's env goes
// stale after the wizard edits the file) and data/ holds codex-auth.json.
const ENV_PATH = join(ROOT, ".env");
const DATA_DIR_ABS = DATA_DIR;
const ROUTE = `${HOST}/eve/v1/telegram`;
const ACCEPTANCE_ROUTE = `${HOST}${TELEGRAM_ACCEPTANCE_ROUTE}`;
const RESET_ROUTE = `${ROUTE}/reset`;
const API = `https://api.telegram.org/bot${TOKEN}`;
const OFFSET_FILE = join(DATA_DIR, "telegram-offset.json");
// Acceptance returns 204 only after the turn starts. Ninety seconds is deliberately
// generous so no legitimate start should hit the deadline, while a wedged eve cannot
// block the bridge's single polling loop forever.
const configuredDirectAcceptanceTimeoutMs = Number(
  process.env.TELEGRAM_DIRECT_ACCEPTANCE_TIMEOUT_MS,
);
const DIRECT_ACCEPTANCE_TIMEOUT_MS =
  Number.isInteger(configuredDirectAcceptanceTimeoutMs) &&
  configuredDirectAcceptanceTimeoutMs > 0 &&
  configuredDirectAcceptanceTimeoutMs <= 4_294_967_295
    ? configuredDirectAcceptanceTimeoutMs
    : 90_000;
// Pause between updates of the SAME chat: we give eve time to park the turn and register
// the continuation hook, otherwise a burst starts a second run on the same token → HookConflictError.
const SETTLE_MS = Number(process.env.TELEGRAM_POLL_SETTLE_MS ?? 1500);
const rawCollectQuietMs = Number(
  process.env.TELEGRAM_COLLECT_QUIET_MS ?? COLLECT_QUIET_MS,
);
const configuredCollectQuietMs =
  Number.isFinite(rawCollectQuietMs) && rawCollectQuietMs >= 0
    ? rawCollectQuietMs
    : COLLECT_QUIET_MS;
const messageCollector = createCollector({ quietMs: configuredCollectQuietMs });
const UPDATE_JOB_TTL_MS = 6 * 60 * 60 * 1000;

// Trusted IDs — only they are allowed control commands (/restart etc.).
const ALLOWED = new Set(
  (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean),
);

// LANG/t/HELP убраны: язык теперь динамический (getLang из i18n.mjs, реагирует на
// data/settings.json без рестарта), /help генерится helpText() из общей таблицы COMMANDS.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

// offset: null ⇒ no file (first run) — distinguish from a genuine offset 0.
// delivered: update_id последнего доставленного в eve апдейта (см. offset-store.mjs).
async function loadOffset() {
  try {
    return parseOffsetFile(await readFile(OFFSET_FILE, "utf8"));
  } catch {
    return { offset: null, delivered: null };
  }
}

// First run: jump to the tail of the queue (last update_id + 1) to avoid replaying the
// install backlog. drop_pending already clears Telegram's queue — this is a belt over suspenders.
async function fastForwardOffset() {
  try {
    const data = await tg("getUpdates", { offset: -1, timeout: 0 });
    const list = data.ok ? data.result || [] : [];
    return list.length ? list[list.length - 1].update_id + 1 : 0;
  } catch (e) {
    log("fast-forward offset failed:", e.message);
    return 0;
  }
}

// Serialization key = eve continuation hook (telegram:<chatId>:<threadId>:):
// one chat (+ forum topic) — one session, deliver into it one at a time with a pause.
function chatKey(update) {
  const msg = update.message ?? update.callback_query?.message;
  const chatId = msg?.chat?.id;
  if (chatId === undefined) return null;
  const threadId = msg?.message_thread_id;
  return `${chatId}:${threadId ?? ""}`;
}
async function saveOffset(offset, delivered = null) {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(OFFSET_FILE, serializeOffsetFile(offset, delivered), "utf8");
  } catch (e) {
    log("offset save failed:", e.message);
  }
}

// Every Bot API call carries a deadline — a hung response must never stall the single polling loop.
// The default suits normal calls; getUpdates overrides it to sit above its own long-poll window.
async function tg(method, body, { timeoutMs = 30_000 } = {}) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res.json();
}

// Read a web ReadableStream as UTF-8 text with a HARD cap: it stops and cancels the stream the moment
// the running total exceeds maxBytes, so an oversized (or size-unknown) body is never fully buffered.
// The caller passes an already time-bounded body (see downloadTelegramFile) so a hung socket mid-read
// aborts the read too. Returns null on over-size or a read error. Pure — unit-tested off the network.
export async function readCappedStream(body, maxBytes) {
  if (!body || typeof body.getReader !== "function") return null;
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Download a Telegram file's bytes as UTF-8 text (getFile → file download), hard-capped at maxBytes and
// deadline-bounded at every step (getFile call, the download connection, and the streamed read — a size
// cap alone doesn't save the loop from a stalled socket). Returns null on any failure or over-size.
async function downloadTelegramFile(fileId, maxBytes) {
  try {
    const info = await tg("getFile", { file_id: fileId }, { timeoutMs: 10_000 });
    const filePath = info?.result?.file_path;
    if (!filePath) return null;
    const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${filePath}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    // Cheap early reject when the server declares an over-size body; the stream reader below is the
    // hard cap regardless (a missing or lying Content-Length can't get past it).
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) return null;
    return await readCappedStream(res.body, maxBytes);
  } catch {
    return null;
  }
}

// Deliver one update to the local eve (we mimic a webhook). Three failure classes (see
// deliver-policy.mjs): retry — network/5xx/408/425/429, fast backoff, forever; config —
// 401/403/404 mean the secret/route is broken, messages must NOT be thrown away, so
// retry forever with a LONG backoff + alert the owner; drop-class (other 4xx) — eve
// не даёт надёжного признака «апдейт битый навсегда» (тот же 409 может быть временным
// конфликтом хука), поэтому и эти статусы ретраятся, но ОГРАНИЧЕННО: DROP_ATTEMPTS
// попыток (~5 минут), затем апдейт выбрасывается, чтобы не заморозить все чаты.
// Direct delivery keeps that policy. Durable queue replay opts into one bounded attempt
// per drain pass: its on-disk head is the retry mechanism, so one bad chat cannot starve
// other queues or Telegram polling.
// Returns true when eve accepted the update, false when it was dropped or retained.
const CONFIG_RETRY_MS = 60_000;
const DROP_ATTEMPTS = 30;
async function deliver(
  update,
  {
    route: requestedRoute,
    acceptedStatus,
    queueReceipt: requestedQueueReceipt,
    retry = true,
    retryAcceptanceTimeout = retry,
    timeoutMs,
    onAcceptanceFailure,
  } = {},
) {
  // The authored acceptance wrapper observes onMessage/send(), but not
  // onCallbackQuery. Message updates therefore use the stronger route by default,
  // while genuine and synthetic callbacks keep the original webhook path.
  const route =
    requestedRoute ??
    (update?.message && !update?.callback_query ? ACCEPTANCE_ROUTE : ROUTE);
  const expectsAcceptance =
    acceptedStatus !== undefined || route === ACCEPTANCE_ROUTE;
  const expectedStatus =
    acceptedStatus ?? (expectsAcceptance ? 204 : undefined);
  const queueReceipt =
    requestedQueueReceipt ?? (expectsAcceptance && Boolean(update?.message));
  const outgoing = queueReceipt ? addTelegramQueueReceipt(update) : update;
  const reportAcceptanceFailure = async (details) => {
    if (!onAcceptanceFailure) return;
    try {
      await onAcceptanceFailure(details);
    } catch (error) {
      log("deliver: direct acceptance failure cleanup failed:", error.message);
    }
  };
  for (let attempt = 1; ; attempt++) {
    let wait = Math.min(15000, 1000 * attempt);
    try {
      const res = await fetch(route, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": SECRET,
        },
        body: JSON.stringify(outgoing),
        ...(timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(timeoutMs) }),
      });
      const acceptanceKind = expectsAcceptance
        ? res.headers.get(TELEGRAM_ACCEPTANCE_KIND_HEADER)
        : null;
      if (
        res.ok &&
        (expectedStatus === undefined || res.status === expectedStatus) &&
        (
          !expectsAcceptance ||
          acceptanceKind === "turn" ||
          acceptanceKind === "handled"
        )
      ) {
        return acceptanceKind === "handled" ? "handled" : true;
      }
      if (res.ok) {
        if (expectsAcceptance) {
          await reportAcceptanceFailure({
            attempt,
            kind: "protocol",
            status: res.status,
          });
        }
        if (!retry) {
          log(
            `deliver: acceptance route replied ${res.status} without a valid acceptance receipt; queue head retained`,
          );
          return false;
        }
      }
      if (expectsAcceptance && res.status === 503) {
        await reportAcceptanceFailure({
          attempt,
          kind: "dispatch",
          status: res.status,
        });
      }
      const cls = classifyDeliverStatus(res.status, {
        acceptance: expectsAcceptance,
      });
      if (!retry) {
        log(`deliver: eve replied ${res.status}; queue head retained for a later pass`);
        return false;
      }
      if (cls === "drop") {
        if (attempt < DROP_ATTEMPTS) {
          log(
            `deliver: eve replied ${res.status} (attempt ${attempt}/${DROP_ATTEMPTS}) — retrying (may be transient)`,
          );
          await sleep(wait);
          continue;
        }
        log(`deliver: eve replied ${res.status} ${DROP_ATTEMPTS} times — DROPPING update ${update.update_id}`);
        await notifyDeliverProblem("drop", res.status);
        return false;
      }
      if (cls === "config") {
        // Не дропаем: это конфигурация сломана, а не апдейт. Длинный бэкофф, чтобы не
        // молотить, и алерт владельцу — чинить надо руками (secret/route).
        wait = CONFIG_RETRY_MS;
        await notifyDeliverProblem("config", res.status);
        log(`deliver: eve replied ${res.status} (config error, attempt ${attempt}) — retrying in ${wait / 1000}s`);
      } else {
        log(`deliver: eve replied ${res.status} (attempt ${attempt}) — retrying`);
      }
    } catch (e) {
      const acceptanceTimeout =
        expectsAcceptance &&
        (e?.name === "TimeoutError" || e?.name === "AbortError");
      if (acceptanceTimeout) {
        await reportAcceptanceFailure({
          attempt,
          kind: "timeout",
          status: "timeout",
        });
      }
      if (!retry) {
        log(`deliver: eve unavailable (${e.message}); queue head retained for a later pass`);
        return false;
      }
      if (acceptanceTimeout && !retryAcceptanceTimeout) {
        // A timed-out POST may still start later. Re-posting it could duplicate the
        // turn, so direct acceptance timeouts are definitive and never retried.
        log(
          `deliver: direct acceptance timed out after ${timeoutMs}ms; rejecting update ${update.update_id} without retry`,
        );
        return false;
      }
      if (acceptanceTimeout) {
        if (attempt < DROP_ATTEMPTS) {
          log(
            `deliver: acceptance timed out (attempt ${attempt}/${DROP_ATTEMPTS}) — retrying`,
          );
          await sleep(wait);
          continue;
        }
        log(
          `deliver: acceptance timed out ${DROP_ATTEMPTS} times — DROPPING update ${update.update_id}`,
        );
        await notifyDeliverProblem("drop", "timeout");
        return false;
      }
      log(`deliver: eve unavailable (${e.message}, attempt ${attempt}) — waiting for server`);
    }
    await sleep(wait);
  }
}

// Владелец должен узнать и о выброшенном апдейте, и о конфиг-ошибке (secret/route).
// Один раз на процесс и класс — чтобы серия ошибок не превратилась в спам. Класс
// помечается «уведомлённым» только ПОСЛЕ успешной отправки: упавший sendMessage не
// должен навсегда лишать владельца алерта.
const deliverNotified = new Set();
async function notifyDeliverProblem(kind, status) {
  if (deliverNotified.has(kind)) return;
  const target = process.env.TELEGRAM_DIGEST_CHAT_ID || [...ALLOWED][0];
  if (!target) return;
  const text =
    kind === "config"
      ? tr(
          `⚠️ Iva bridge can't deliver to eve: HTTP ${status} — the webhook secret or route looks broken. Messages are queued (retrying every 60s). Check: journalctl --user -u iva-telegram-poll`,
          `⚠️ Мост Iva не может доставить в eve: HTTP ${status} — похоже, разъехались webhook-секрет или маршрут. Сообщения не теряются (ретрай раз в 60с). Проверь: journalctl --user -u iva-telegram-poll`,
        )
      : tr(
          `⚠️ Iva bridge dropped a Telegram update: eve replied ${status} (permanent). Check the logs: journalctl --user -u iva-telegram-poll`,
          `⚠️ Мост Iva выбросил Telegram-апдейт: eve ответила ${status} (постоянная ошибка). Проверь логи: journalctl --user -u iva-telegram-poll`,
        );
  try {
    const res = await tg("sendMessage", { chat_id: target, text });
    if (res?.ok) deliverNotified.add(kind);
  } catch (e) {
    log("deliver notification failed:", e.message);
  }
}

// Время последней доставки по chat key — для паузы SETTLE_MS между апдейтами одного чата.
// МОДУЛЬ-уровень (не локальная в main): её обязан обновлять и синтетический deliver меню
// (дистилляция интервью), иначе реальное сообщение сразу после него ушло бы без паузы —
// в окно, пока eve ещё не записала run-status и не зарегистрировала continuation-hook →
// второй ран на том же токене → HookConflictError.
const lastDeliverAt = new Map();

// Доставка с пейсингом: выдержать SETTLE_MS с последней доставки в этот чат, доставить,
// отметить время. ЕДИНЫЙ путь для главного цикла и для меню (deps.deliver) — оба делят
// lastDeliverAt, поэтому доставка из меню сдвигает паузу для следующего реального сообщения.
async function pacedDeliver(update, options) {
  const deadline =
    options?.timeoutMs === undefined ? null : Date.now() + Math.max(0, options.timeoutMs);
  const key = chatKey(update);
  if (key !== null && SETTLE_MS > 0) {
    const prev = lastDeliverAt.get(key);
    if (prev !== undefined) {
      const wait = SETTLE_MS - (Date.now() - prev);
      if (wait > 0) {
        if (deadline !== null && wait >= deadline - Date.now()) return false;
        await sleep(wait);
      }
    }
  }
  const deliverOptions =
    deadline === null
      ? options
      : { ...options, timeoutMs: Math.max(1, Math.floor(deadline - Date.now())) };
  const accepted = await deliver(update, deliverOptions); // wait for delivery — ordered and lossless
  if (key !== null) lastDeliverAt.set(key, Date.now());
  return accepted; // false = апдейт выброшен как битый, eve его НЕ получила
}

async function reply(chatId, text) {
  try {
    const data = await tg("sendMessage", { chat_id: chatId, text });
    if (!data.ok) throw new Error(data.description || "sendMessage failed");
    return data.result;
  } catch (e) {
    log("reply failed:", e.message);
    return null;
  }
}

async function edit(chatId, messageId, text, replyMarkup) {
  try {
    const body = { chat_id: chatId, message_id: messageId, text };
    if (replyMarkup !== undefined) body.reply_markup = replyMarkup;
    const data = await tg("editMessageText", body);
    if (!data.ok) throw new Error(data.description || "editMessageText failed");
    return data.result;
  } catch (e) {
    if (!/message is not modified/i.test(e.message)) log("edit failed:", e.message);
    return null;
  }
}

const sc = (...args) =>
  new Promise((resolve) => execFile("systemctl", ["--user", ...args], (err) => resolve(!err)));

// ── Durable busy-time FIFO ──────────────────────────────────────────────────
// Each accepted Telegram update is written as a versioned item (including update_id and
// the untouched raw update) before its Telegram offset advances. The bridge then replays
// one head per idle chat/topic. It removes that head only after Eve accepts the webhook:
// a crash can duplicate the head, but cannot lose it or reorder later items around it.
const QUEUE_FILE = join(DATA_DIR, "telegram-queue.json");
const RESET_INTENT_DIR = join(DATA_DIR, "telegram-reset-intents");
const queueSettleUntil = new Map();
const queueInFlight = new Map();
const queueDrainRotation = { afterKey: null };
const undrainableLegacyLogged = new Set();
const QUEUE_DELIVERY_TIMEOUT_MS = 5_000;
const QUEUE_DRAIN_BUDGET_MS = 5_000;

function statusGeneration(status) {
  return Number.isSafeInteger(status?.generation) && status.generation >= 0
    ? status.generation
    : 0;
}

export async function loadQueue({ strict = false } = {}) {
  const loaded = await loadQueueFile(QUEUE_FILE, { strict });
  if (loaded.quarantined) {
    log(`damaged Telegram queue moved to ${loaded.quarantined}:`, loaded.error.message);
  }
  return loaded.document;
}

export async function writeQueueAtomic(queue, options = {}) {
  await writeQueueFileAtomic(QUEUE_FILE, queue, options);
}

// A scoped reset intentionally discards only messages queued for this chat/topic.
// Other conversations keep both their queues and their Eve histories.
async function clearChatQueue(chatKey) {
  // Reset cleanup must fail loudly: completeScopedResetState keeps the old
  // running status until this atomic rewrite succeeds.
  await clearQueueFileKey(QUEUE_FILE, chatKey);
}

export async function completeScopedResetState(
  chatKey,
  rawContinuationToken,
  {
    clearQueue = false,
    clearQueueImpl = clearChatQueue,
    setStatusImpl = setChatStatus,
  } = {},
) {
  // For private chats the queue belongs to the reset session, so clear it
  // before exposing an idle tombstone. A failed cleanup leaves the old running
  // status in place and lets a repeated /new retry safely.
  if (clearQueue) await clearQueueImpl(chatKey);

  // Надгробие переживает рестарты и потом уходит в reset как есть — только channel-local.
  const continuationToken = toChannelLocalToken(rawContinuationToken);

  // Keep an idle token tombstone: Telegram updates are at-least-once. If the
  // same group /new is replayed after a crash, the second reset remains an
  // idempotent no_active_session instead of losing the group anchor.
  setStatusImpl(chatKey, {
    status: "idle",
    continuationToken,
    sessionId: null,
    turnId: null,
    statusMessageId: null,
    ingressId: null,
    ingressAt: null,
    statusAt: null,
    turnAt: null,
    firstOutputAt: null,
    latencyLogged: null,
    wasCancelled: null,
    resetAt: Date.now(),
  });
}

export async function persistPrivateResetIntent(chatKey, continuationToken) {
  return persistTelegramResetIntent(RESET_INTENT_DIR, chatKey, continuationToken);
}

export async function loadPrivateResetIntents() {
  return loadTelegramResetIntents(RESET_INTENT_DIR);
}

export async function clearPrivateResetIntent(chatKey) {
  return clearTelegramResetIntent(RESET_INTENT_DIR, chatKey);
}

const requestResetFromIntent = ({ continuationToken }) =>
  requestTelegramReset({
    url: RESET_ROUTE,
    secret: SECRET,
    continuationToken,
  });

export async function releaseScopedContinuation(
  chatKey,
  continuationToken,
  { requestResetImpl = requestResetFromIntent, logImpl = log } = {},
) {
  // Наружу уходит только channel-local токен: reset-роут клеит имя канала сам (#110).
  const token = toChannelLocalToken(continuationToken);
  let result;
  try {
    result = await requestResetImpl({ chatKey, continuationToken: token });
  } catch (error) {
    error.resetPhase = "remote";
    throw error;
  }
  // Ответ no_active_session идемпотентен и для реплея апдейта нормален, но именно он
  // маскировал #110: сброс «удавался», ничего не сбрасывая. В журнале исход виден.
  logResetOutcome(logImpl, chatKey, token, result);
  return result;
}

function logResetOutcome(logImpl, chatKey, continuationToken, result) {
  try {
    // chatKey сам оканчивается двоеточием (chat:topic) — отделяем явным словом, иначе
    // строка читается как «reset 7091451031:: …» и ключ путается с токеном.
    logImpl(
      `reset for chat ${chatKey} -> ${result?.status ?? "unknown"} (token ${continuationToken})`,
    );
  } catch {
    // Журналирование не должно ронять сброс.
  }
}

export async function performScopedReset(
  chatKey,
  continuationToken,
  {
    clearQueue = false,
    persistIntentImpl = persistPrivateResetIntent,
    requestResetImpl = requestResetFromIntent,
    completeStateImpl = completeScopedResetState,
    clearIntentImpl = clearPrivateResetIntent,
    logImpl = log,
  } = {},
) {
  const intent = { chatKey, continuationToken };
  if (clearQueue) {
    try {
      await persistIntentImpl(chatKey, continuationToken);
    } catch (error) {
      error.resetPhase = "intent";
      throw error;
    }
  }
  try {
    await releaseScopedContinuation(chatKey, continuationToken, { requestResetImpl, logImpl });
  } catch (error) {
    throw error;
  }
  try {
    await completeStateImpl(chatKey, continuationToken, { clearQueue });
  } catch (error) {
    error.resetPhase = "cleanup";
    throw error;
  }
  if (clearQueue) {
    try {
      await clearIntentImpl(chatKey);
    } catch (error) {
      error.resetPhase = "intent-cleanup";
      throw error;
    }
  }
}

export async function reconcileScopedResetIntents({
  loadIntentsImpl = loadPrivateResetIntents,
  requestResetImpl = requestResetFromIntent,
  completeStateImpl = completeScopedResetState,
  clearIntentImpl = clearPrivateResetIntent,
  logImpl = log,
} = {}) {
  const intents = await loadIntentsImpl();
  for (const intent of intents) {
    // Интент мог быть записан версией до фикса #110 — с именем канала в токене.
    const continuationToken = toChannelLocalToken(intent.continuationToken);
    const result = await requestResetImpl({ ...intent, continuationToken });
    logResetOutcome(logImpl, intent.chatKey, continuationToken, result);
    await completeStateImpl(intent.chatKey, continuationToken, { clearQueue: true });
    await clearIntentImpl(intent.chatKey);
  }
  return intents.length;
}

function telegramTargetOf(chatKey) {
  const separator = chatKey.indexOf(":");
  if (separator <= 0) return null;
  const chatId = chatKey.slice(0, separator);
  if (!/^-?\d+$/.test(chatId)) return null;
  const thread = chatKey.slice(separator + 1);
  if (thread === "") return { chat_id: chatId };
  if (!/^\d+$/.test(thread)) return null;
  const messageThreadId = Number(thread);
  if (!Number.isSafeInteger(messageThreadId) || messageThreadId <= 0) return null;
  return { chat_id: chatId, message_thread_id: messageThreadId };
}

async function sendStaleRunNotice(chatKey, text) {
  const target = telegramTargetOf(chatKey);
  if (!target) throw new Error(`invalid Telegram chat key: ${chatKey}`);
  const data = await tg("sendMessage", { ...target, text });
  if (!data?.ok) throw new Error(data?.description || "sendMessage failed");
}

async function deleteStaleWorkingMessage(chatKey, messageId) {
  const target = telegramTargetOf(chatKey);
  if (!target) return;
  await tg("deleteMessage", {
    chat_id: target.chat_id,
    message_id: messageId,
  });
}

async function clearFailedDirectIngress(
  chatKey,
  {
    baselineGeneration,
    startedAt,
    statusImpl = getChatStatus,
    setStatusIfImpl = setChatStatusIf,
    deleteMessageImpl = deleteStaleWorkingMessage,
    now = Date.now,
  },
) {
  const current = statusImpl(chatKey);
  const observedAt = now();
  if (
    current?.status !== "running" ||
    current.sessionId !== undefined ||
    typeof current.ingressId !== "string" ||
    !Number.isFinite(current.ingressAt) ||
    current.ingressAt < startedAt ||
    current.ingressAt > observedAt ||
    statusGeneration(current) <= baselineGeneration
  ) {
    return false;
  }

  const cleared = setStatusIfImpl(
    chatKey,
    {
      status: "running",
      generation: current.generation,
      updatedAt: current.updatedAt,
      ingressId: current.ingressId,
      sessionId: undefined,
    },
    {
      status: "idle",
      sessionId: null,
      turnId: null,
      statusMessageId: null,
      ingressId: null,
      ingressAt: null,
      statusAt: null,
      turnAt: null,
      firstOutputAt: null,
      latencyLogged: null,
      wasCancelled: null,
      resetAt: observedAt,
    },
  );
  if (!cleared) return false;

  if (current.statusMessageId !== undefined && current.statusMessageId !== null) {
    try {
      await deleteMessageImpl(chatKey, current.statusMessageId);
    } catch {
      // Failed-attempt working messages are removed best-effort, like stale ones.
    }
  }
  return true;
}

export async function reapStaleRuns({
  listStatusesImpl = listChatStatuses,
  setStatusIfImpl = setChatStatusIf,
  resetImpl = releaseScopedContinuation,
  sendImpl = sendStaleRunNotice,
  deleteMessageImpl = deleteStaleWorkingMessage,
  now = Date.now,
  inFlight = queueInFlight,
  staleMs = RUN_STALE_MS,
  trImpl = tr,
  logImpl = log,
} = {}) {
  const safeLog = (...args) => {
    try {
      logImpl(...args);
    } catch {
      // Обслуживание протухших ходов не должно останавливать polling loop.
    }
  };

  let records;
  try {
    records = await listStatusesImpl();
  } catch (error) {
    safeLog("stale run scan failed:", error.message);
    return 0;
  }

  let reaped = 0;
  for (const record of records) {
    const key = record?.chatKey;
    const status = record?.status;
    if (
      typeof key !== "string" ||
      status?.status !== "running" ||
      now() - (status.updatedAt ?? 0) <= staleMs ||
      inFlight.has(key)
    ) {
      continue;
    }

    let flipped;
    const reapedAt = now();
    try {
      flipped = setStatusIfImpl(
        key,
        {
          status: "running",
          generation: status.generation,
          updatedAt: status.updatedAt,
        },
        {
          status: "idle",
          sessionId: null,
          turnId: null,
          statusMessageId: null,
          ingressId: null,
          ingressAt: null,
          statusAt: null,
          turnAt: null,
          firstOutputAt: null,
          latencyLogged: null,
          wasCancelled: null,
          resetAt: reapedAt,
        },
      );
    } catch (error) {
      safeLog(`stale run CAS failed for ${key}:`, error.message);
      continue;
    }
    if (!flipped) continue;
    reaped++;

    if (
      typeof status.continuationToken === "string" &&
      status.continuationToken.length > 0
    ) {
      try {
        // Статусы, записанные до фикса #110, хранят токен с именем канала впереди.
        await resetImpl(key, toChannelLocalToken(status.continuationToken));
      } catch (error) {
        safeLog(`stale run reset failed for ${key}:`, error.message);
      }
    } else {
      safeLog(`stale run ${key} has no continuation token`);
    }

    try {
      await sendImpl(
        key,
        trImpl(
          "The previous turn was interrupted - repeat your request or use /new",
          "Предыдущий ход оборвался - повтори запрос или /new",
        ),
      );
    } catch (error) {
      safeLog(`stale run notification failed for ${key}:`, error.message);
    }

    if (status.statusMessageId !== undefined && status.statusMessageId !== null) {
      try {
        await deleteMessageImpl(key, status.statusMessageId);
      } catch {
        // Старое статус-сообщение удаляется best-effort.
      }
    }
  }
  return reaped;
}

async function acknowledgeQueued(update, count) {
  const message = update.message;
  await tg("setMessageReaction", {
    chat_id: message.chat.id,
    message_id: message.message_id,
    reaction: [{ type: "emoji", emoji: "👀" }],
  }).catch((error) => log("reaction failed:", error.message));
  await tg("sendMessage", {
    chat_id: message.chat.id,
    text: tr(
      `Queued (${count}). I'll start it automatically when the current task finishes.`,
      `В очереди: ${count}. Начну автоматически, когда текущая задача завершится.`,
    ),
    ...(message.message_thread_id === undefined
      ? {}
      : { message_thread_id: message.message_thread_id }),
  }).catch((error) => log("queue status failed:", error.message));
}

async function deliverDirectUpdate(
  update,
  {
    key = chatKey(update),
    deliverImpl = pacedDeliver,
    statusImpl = getChatStatus,
    setStatusIfImpl = setChatStatusIf,
    sendFailureImpl = sendStaleRunNotice,
    deleteMessageImpl = deleteStaleWorkingMessage,
    now = Date.now,
    trImpl = tr,
    logImpl = log,
  } = {},
) {
  // The acceptance wrapper does not cover callback_query dispatch. Keeping this
  // call option-free also preserves the old webhook path for real callbacks and
  // the synthetic /stop callback.
  if (!update.message || key === null) {
    const accepted = await deliverImpl(update);
    return accepted ? "delivered" : "rejected";
  }

  const startedAt = now();
  const baselineGeneration = statusGeneration(statusImpl(key));
  let acceptanceFailureReported = false;
  let failureNotified = false;
  const onAcceptanceFailure = async () => {
    acceptanceFailureReported = true;
    try {
      await clearFailedDirectIngress(key, {
        baselineGeneration,
        startedAt,
        statusImpl,
        setStatusIfImpl,
        deleteMessageImpl,
        now,
      });
    } catch (error) {
      logImpl(`direct delivery status cleanup failed for ${key}:`, error.message);
    }

    if (failureNotified) return;
    failureNotified = true;
    try {
      await sendFailureImpl(
        key,
        trImpl(
          "Couldn't process the message - repeat it or use /new",
          "Не получилось обработать сообщение - повтори или /new",
        ),
      );
    } catch (error) {
      logImpl(`direct delivery notification failed for ${key}:`, error.message);
    }
  };

  const accepted = await deliverImpl(update, {
    onAcceptanceFailure,
    timeoutMs: DIRECT_ACCEPTANCE_TIMEOUT_MS,
    retryAcceptanceTimeout: false,
  });
  // Defensive fallback for injected/custom deliverers and for a pacing deadline
  // that expires before fetch starts.
  if (!accepted && !acceptanceFailureReported) await onAcceptanceFailure();
  return accepted ? "delivered" : "rejected";
}

export async function routeMessageUpdate(
  update,
  {
    chatKeyImpl = chatKey,
    loadQueueImpl = loadQueue,
    runningImpl = isRunning,
    inFlight = queueInFlight,
    queueCountImpl = queueCount,
    replyToBotImpl = isReplyToBot,
    shouldQueueImpl = shouldQueueBusyUpdate,
    enqueueImpl = (key, candidate) => enqueueQueueFile(QUEUE_FILE, key, candidate),
    acknowledgeImpl = acknowledgeQueued,
    deliverImpl = pacedDeliver,
    statusImpl = getChatStatus,
    setStatusIfImpl = setChatStatusIf,
    sendFailureImpl = sendStaleRunNotice,
    deleteMessageImpl = deleteStaleWorkingMessage,
    now = Date.now,
    trImpl = tr,
    allowedUserIds = ALLOWED,
    botUsername = BOT_USERNAME,
    logImpl = log,
  } = {},
) {
  const key = chatKeyImpl(update);
  if (update.message && key !== null && !replyToBotImpl(update.message)) {
    const queue = await loadQueueImpl();
    const mustQueue =
      runningImpl(key) || inFlight.has(key) || queueCountImpl(queue, key) > 0;
    if (mustQueue) {
      if (!shouldQueueImpl(update, { allowedUserIds, botUsername })) return "dropped";
      let queued;
      try {
        queued = await enqueueImpl(key, update);
      } catch (error) {
        logImpl(`queue enqueue failed for update ${update.update_id}:`, error.message);
        return "enqueue-failed";
      }
      await acknowledgeImpl(update, queued.count);
      return "queued";
    }
  }

  return deliverDirectUpdate(update, {
    key,
    deliverImpl,
    statusImpl,
    setStatusIfImpl,
    sendFailureImpl,
    deleteMessageImpl,
    now,
    trImpl,
    logImpl,
  });
}

export async function drainReadyQueueHeads({
  loadImpl = loadQueue,
  runningImpl = isRunning,
  statusImpl = getChatStatus,
  deliverImpl = (update, { timeoutMs }) =>
    pacedDeliver(update, {
      route: ACCEPTANCE_ROUTE,
      acceptedStatus: 204,
      queueReceipt: true,
      retry: false,
      timeoutMs,
    }),
  acknowledgeImpl = (key, updateId) => acknowledgeQueueHead(QUEUE_FILE, key, updateId),
  legacyAllowedUserIds = ALLOWED,
  now = Date.now,
  settleUntil = queueSettleUntil,
  inFlight = queueInFlight,
  rotationState = queueDrainRotation,
  passBudgetMs = QUEUE_DRAIN_BUDGET_MS,
  deliveryTimeoutMs = QUEUE_DELIVERY_TIMEOUT_MS,
  gateWaitMs = RUN_STALE_MS,
} = {}) {
  const snapshot = await loadImpl();
  const keys = [...new Set([...queueKeys(snapshot), ...inFlight.keys()])];
  const previousIndex = keys.indexOf(rotationState.afterKey);
  const orderedKeys =
    previousIndex < 0
      ? keys
      : [...keys.slice(previousIndex + 1), ...keys.slice(0, previousIndex + 1)];
  const deadline = now() + passBudgetMs;
  let exhausted = false;
  let lastAttempted = null;

  for (const key of orderedKeys) {
    if (now() >= deadline) {
      exhausted = true;
      break;
    }
    const currentStatus = statusImpl(key);
    const currentGeneration = statusGeneration(currentStatus);
    const running = runningImpl(key);
    const phase = inFlight.get(key);
    if (phase?.state === "delivering") continue;
    if (phase?.state === "awaiting-running") {
      if (running) {
        inFlight.set(key, { ...phase, state: "running", generation: currentGeneration });
        continue;
      }
      const generationAdvanced = currentGeneration > phase.baselineGeneration;
      const waitExpired = now() - phase.acceptedAt >= gateWaitMs;
      if (!generationAdvanced && !waitExpired) continue;
      inFlight.delete(key);
    }
    if (phase?.state === "running") {
      if (running) continue;
      inFlight.delete(key);
    }
    const item = queueHead(snapshot, key);
    if (!item) continue;
    if (running || (settleUntil.get(key) ?? 0) > now()) continue;
    const update = materializeQueueItem(key, item, { legacyAllowedUserIds });
    if (!update) {
      if (!undrainableLegacyLogged.has(key)) {
        log(`queued legacy messages for ${key} cannot be replayed because their author is not verifiable`);
        undrainableLegacyLogged.add(key);
      }
      continue;
    }
    const timeoutMs = Math.max(1, Math.min(deliveryTimeoutMs, deadline - now()));
    lastAttempted = key;
    const baselineGeneration = currentGeneration;
    inFlight.set(key, { state: "delivering", baselineGeneration });
    let accepted = false;
    try {
      accepted = await deliverImpl(update, { timeoutMs });
    } catch (error) {
      log(`queued update ${item.updateId} delivery failed:`, error.message);
    }
    if (!accepted) {
      inFlight.delete(key);
      continue;
    }
    if (accepted === "handled") {
      inFlight.delete(key);
    } else {
      const acceptedStatus = statusImpl(key);
      const acceptedGeneration = statusGeneration(acceptedStatus);
      if (runningImpl(key)) {
        inFlight.set(key, {
          state: "running",
          baselineGeneration,
          generation: acceptedGeneration,
        });
      } else if (acceptedGeneration > baselineGeneration) {
        // A complete running -> idle cycle happened while acceptance was pending.
        inFlight.delete(key);
      } else {
        inFlight.set(key, {
          state: "awaiting-running",
          baselineGeneration,
          acceptedAt: now(),
        });
      }
    }
    // Keep a just-accepted head until its removal is itself durable. If this write
    // fails, the next pass deliberately replays the same head (at-least-once).
    try {
      await acknowledgeImpl(key, item.updateId);
      settleUntil.set(key, now() + Math.max(SETTLE_MS, 0));
    } catch (error) {
      if (error?.code === TELEGRAM_QUEUE_FATAL_DURABILITY) {
        inFlight.delete(key);
        rotationState.afterKey = null;
        throw error;
      }
      log(`queued update ${item.updateId} ack failed; head retained or restored:`, error.message);
    }
  }
  rotationState.afterKey = exhausted ? lastAttempted : null;
  return queueCount(await loadImpl());
}

// ── self-update (/update) ──────────────────────────────────────────────────
// Run `iva update` in its OWN transient systemd scope, so it survives the restart of
// THIS bridge (restartServices restarts iva-telegram-poll too — a plain child would be
// killed with us). --collect GC's the unit after exit. The updater reads a 0600 job
// file and posts each phase directly through Bot API, so no bridge process survives.
function launchSelfUpdate(jobId) {
  const args = [
    "--user", "--collect", `--unit=iva-self-update-${Date.now()}`,
    `--working-directory=${ROOT}`,
    `--setenv=PATH=${process.env.PATH || ""}`,
    NODE, join(ROOT, "bin/iva.mjs"), "update", "--telegram-job", jobId,
  ];
  return new Promise((resolve) =>
    execFile("systemd-run", args, (err, out, e) => resolve({ ok: !err, msg: (e || out || "").toString().trim() })),
  );
}

export async function handleUpdateCheck(
  chatId,
  { inspectImpl = inspectUpstream, markNotifiedImpl = markVersionNotified, envImpl = () => readEnvFresh(ENV_PATH) } = {},
) {
  const status = await reply(chatId, tr("◇ Checking for updates", "◇ Проверяю обновления"));
  if (!status) return;
  let info;
  try {
    info = await inspectImpl({ root: ROOT });
  } catch (e) {
    await edit(chatId, status.message_id, tr("⚠️ Couldn't check for updates", "⚠️ Не удалось проверить обновления"));
    return;
  }
  if (!info.hasCommitUpdate) {
    // Not modelSummary(process.env): the /model wizard edits .env at runtime and restarts
    // only the agent — this bridge keeps running, so its env snapshot may hold the old model.
    const model = modelSummary(await envImpl());
    await edit(chatId, status.message_id, tr(
      `✅ You're up to date\n\nIva v${info.localVersion ?? "?"}\nModel: ${model.line}`,
      `✅ У вас актуальная версия\n\nIva v${info.localVersion ?? "?"}\nМодель: ${model.line}`,
    ));
    return;
  }
  const bump =
    info.remoteVersion && info.remoteVersion !== info.localVersion
      ? `v${info.localVersion ?? "?"} → v${info.remoteVersion}`
      : tr(`v${info.localVersion ?? "?"} → newer build`, `v${info.localVersion ?? "?"} → новая сборка`);
  const offered = await edit(chatId, status.message_id, tr(
    `⬆️ Update available\n\n${bump}\nSettings and local changes will be preserved.`,
    `⬆️ Доступно обновление\n\n${bump}\nНастройки и локальные изменения будут сохранены.`,
  ), updateOffer(info.localVersion, info.remoteVersion, getLang()).replyMarkup);
  if (offered && info.hasVersionUpdate) {
    await markNotifiedImpl(DATA_DIR, info.remoteVersion).catch((error) => log("update notification state failed:", error.message));
  }
}

async function removeStaleUpdateJobs() {
  const jobs = join(DATA_DIR, "update-jobs");
  let names;
  try { names = await readdir(jobs); } catch { return; }
  await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
    const path = join(jobs, name);
    try {
      if (Date.now() - (await stat(path)).mtimeMs > UPDATE_JOB_TTL_MS) await rm(path, { force: true });
    } catch {}
  }));
}

// Inline-button taps for the /update flow. Handled by the bridge; never delivered to eve.
export async function handleUpdateCallback(cq) {
  const from = String(cq.from?.id ?? "");
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  await tg("answerCallbackQuery", { callback_query_id: cq.id }); // clear the button spinner
  if (ALLOWED.size === 0 || !ALLOWED.has(from)) return true; // swallow untrusted taps
  const action = cq.data.slice("iva_update:".length);
  if (action === "skip") {
    await edit(chatId, messageId, tr("– Update postponed", "– Обновление отложено"), { inline_keyboard: [] });
    return true;
  }

  const jobId = randomBytes(8).toString("hex");
  const lock = acquireUpdateLock(DATA_DIR, jobId);
  if (!lock.ok) {
    await edit(chatId, messageId, tr("⚠️ An update is already running", "⚠️ Обновление уже идёт"), { inline_keyboard: [] });
    return true;
  }
  const jobs = join(DATA_DIR, "update-jobs");
  await mkdir(jobs, { recursive: true });
  await writeFile(join(jobs, `${jobId}.json`), JSON.stringify({ chatId, messageId, locale: getLang(), startedAt: new Date().toISOString() }), { mode: 0o600 });
  await edit(chatId, messageId, tr("◇ Saving your changes", "◇ Сохраняю ваши изменения"), { inline_keyboard: [] });
  const r = await launchSelfUpdate(jobId);
  if (!r.ok) {
    releaseUpdateLock(lock);
    await rm(join(jobs, `${jobId}.json`), { force: true });
    await edit(chatId, messageId, tr("⚠️ Couldn't start the update", "⚠️ Не удалось запустить обновление"));
  }
  return true;
}

// ── /model & /think wizard (out-of-band, inline keyboards) ─────────────────
// Логика мастера живёт в scripts/lib/model-wizard.mjs (общая с MAX-мостом); здесь — привязка к
// Telegram-транспорту. Состояние: общий session-store flows (/model, /think и /menu делят слот).
const flows = createFlows({ tg, log });
const wizard = createModelWizard({
  tg,
  log,
  flows,
  envPath: ENV_PATH,
  dataDir: DATA_DIR_ABS,
  allowed: ALLOWED,
  sc,
  reply,
});
export const {
  runWizardRequest,
  isStaleWizard,
  wizardActionAllowed,
  selectWizardModel,
  selectWizardEffort,
  selectableWizardOptions,
  resolveThinkCatalogLoad,
  validateAndSaveWizard,
} = wizard;
const { getWizard, endWizard, handleModelCmd, handleThinkCmd, handleKeyMessage, handleWizardCallback } = wizard;

export function resetMessageCopy(cmd, env = process.env, locale = getLang()) {
  const pick = (en, ru) => (locale === "ru" ? ru : en);
  const model = modelSummary(env);
  const context = compactNumber(model.contextWindow);
  return cmd === "/restart"
    ? {
        pending: pick("◇ Restarting Iva", "◇ Перезапускаю Iva"),
        complete: pick(`♻️ Iva restarted\n\nModel: ${model.line}\nUnfinished turn cleared`, `♻️ Iva перезапущена\n\nМодель: ${model.line}\nНезавершённый ход очищен`),
      }
    : {
        pending: pick("◇ Starting a new conversation", "◇ Начинаю новый диалог"),
        complete: pick(`✨ New conversation ready\n\nModel: ${model.line}\nContext cleared · window ${context}`, `✨ Новый диалог готов\n\nМодель: ${model.line}\nКонтекст очищен · окно ${context}`),
      };
}

// Движок /menu: делит session-store (flows) с визардами /model//think. deps — мост отдаёт
// экранам всё нужное (пути, systemctl, доставку в eve, allowlist, хендофф в визарды).
const menu = createMenu({
  flows,
  tg,
  deps: {
    envPath: ENV_PATH,
    dataDir: DATA_DIR,
    root: ROOT,
    sc,
    reply,
    // Синтетическая дистилляция делит acceptance, пейсинг и уборку failed-ingress
    // с обычной прямой доставкой, но намеренно не проходит busy-time FIFO.
    deliver: (update) => deliverDirectUpdate(update).then((result) => result === "delivered"),
    log,
    allowed: ALLOWED,
    handleModelCmd,
    handleThinkCmd,
    handleUpdateCheck,
  },
});

// setMyCommands: синее командное меню Telegram из общей таблицы COMMANDS (default=en +
// language_code:"ru"). Идемпотентно, зовётся на каждом старте моста; ошибки нефатальны.
async function registerBotCommands() {
  try {
    await tg("setMyCommands", { commands: botCommands("en") });
    await tg("setMyCommands", { commands: botCommands("ru"), language_code: "ru" });
  } catch (e) {
    log("setMyCommands failed:", e.message);
  }
}

// Delete a message carrying a secret, warning the user if Telegram won't let us — a rejected secret
// must never silently linger in the chat (mirrors the delete-first path in menu.onText).
async function deleteSecretMessage(chatId, messageId) {
  const del = await tg("deleteMessage", { chat_id: chatId, message_id: messageId }).catch(() => ({ ok: false }));
  if (!del?.ok) {
    await reply(chatId, tr("Couldn't delete your message — please delete it manually.", "Не смог удалить сообщение — удали его вручную.")).catch(() => {});
  }
  return del?.ok === true;
}

// Default I/O for handleAwaitNonText — injectable so the delete→download ordering and the
// "never reaches eve" contract can be unit-tested with mocks.
const nonTextIo = {
  deleteSecret: (chatId, id) => deleteSecretMessage(chatId, id),
  reply: (chatId, text) => reply(chatId, text),
  download: (fileId, max) => downloadTelegramFile(fileId, max),
  // Run the screen's own text handler on downloaded content WITHOUT re-deleting (already deleted).
  deliver: (text, msg, st) => menu.onText({ ...msg, text }, st, { skipDelete: true }),
};

// A non-text message arrived while a menu/wizard awaits a SECRET (the caller gates this to
// secret/file-capable states — a non-secret interview attachment falls through to eve untouched).
// It must never reach eve. For a file-capable prompt (gws client_secret) a document is captured;
// crucially the message is DELETED FIRST, before the download, so the secret doesn't linger in the
// chat for the download's duration. Anything else is deleted with a clear ack telling the user how
// to send it. Always returns true (the update is consumed, not delivered).
export async function handleAwaitNonText(msg, pending, io = nonTextIo) {
  const chatId = msg.chat?.id;
  const a = pending.awaitText;
  const MAX_BYTES = 256 * 1024;
  if (a?.file && msg.document && pending.flow === "menu") {
    if ((msg.document.file_size ?? 0) > MAX_BYTES) {
      await io.deleteSecret(chatId, msg.message_id);
      await io.reply(chatId, tr("That file is too large — paste the contents as text instead.", "Файл слишком большой — вставь содержимое текстом."));
      return true;
    }
    // Delete FIRST, and only proceed once the secret has actually left the chat. If Telegram
    // refused the deletion, deleteSecret already told the user to remove it manually — we must NOT
    // download or deliver a secret that is still visible in the conversation. Consume it either way
    // so it never reaches eve.
    const deleted = await io.deleteSecret(chatId, msg.message_id);
    if (!deleted) return true;
    const content = await io.download(msg.document.file_id, MAX_BYTES);
    if (content == null) {
      await io.reply(chatId, tr("Couldn't read that file — paste the contents as text instead.", "Не смог прочитать файл — вставь содержимое текстом."));
      return true;
    }
    await io.deliver(content, msg, pending); // skipDelete is safe now — the message is confirmed gone
    return true;
  }
  // Secret prompt, but not a capturable file (a photo, or a text-only secret) — delete it so it can't
  // reach eve, and tell the user how to send it instead of dropping it silently.
  await io.deleteSecret(chatId, msg.message_id);
  await io.reply(chatId, a?.file
    ? tr("Send client_secret.json as text or attach the .json file — not a photo.", "Пришли client_secret.json текстом или прикрепи .json-файл — не фото.")
    : tr("Send it as text, please.", "Пришли это, пожалуйста, текстом."));
  return true;
}

// Control commands are handled by the BRIDGE (out-of-band) — they work even if the agent is stuck.
// Trusted IDs only. Returns true if the command was handled (we do NOT deliver it to eve).
async function handleControl(update) {
  // Bridge-owned inline-button taps (/update, /model, /think) — not eve HITL callbacks.
  const cq = update.callback_query;
  if (cq && typeof cq.data === "string") {
    if (cq.data.startsWith("iva_update:")) return handleUpdateCallback(cq);
    // Wizard errors must not escape: an uncaught throw would crash the bridge and
    // re-poll the update after restart. Consume the tap either way.
    if (cq.data.startsWith("iva_model:") || cq.data.startsWith("iva_think:")) {
      return handleWizardCallback(cq).catch((e) => {
        log("wizard callback error:", e.message);
        return true;
      });
    }
    // /menu: тот же принцип consume-on-error — тап меню всегда проглатывается (в eve не уходит).
    if (cq.data.startsWith("iva_menu:")) {
      return menu.onCallback(cq).catch((e) => {
        log("menu callback error:", e.message);
        return true;
      });
    }
  }
  const msg = update.message;
  const text = (msg?.text || "").trim();
  // A pending flow (menu screen or /model wizard) awaiting input claims this user's next message
  // (a key must never reach eve); a command aborts the wait — a silently still-visible prompt would
  // invite pasting the key later, when nothing intercepts it. This runs BEFORE the busy-buffer gate
  // (below), so a capture works even mid-turn. Non-text is intercepted only while awaiting a SECRET
  // (or a file-capable secret): a document/photo could be the secret itself and must not reach eve.
  // A non-secret await (e.g. the memory interview) lets a non-text message fall through unchanged.
  if (msg?.from) {
    const pending = getWizard(msg.chat?.id, String(msg.from.id));
    const a = pending?.awaitText;
    if (a) {
      if (text.startsWith("/")) {
        await endWizard(pending, tr("Cancelled — no longer waiting for input.", "Отменено — ожидание ввода снято.")).catch(() => {});
      } else if (text) {
        if (pending.flow === "menu") {
          // Menu screens own their capture (interview / key intake / gws JSON / ubcred).
          return menu.onText(msg, pending).catch((e) => {
            log("menu capture error:", e.message); // e.message never contains a secret value
            return true;
          });
        }
        // /model wizard key intake — consume the update even on failure (the key must never
        // be re-polled into eve). handleKeyMessage stays the wizard's own handler.
        return handleKeyMessage(msg, pending).catch((e) => {
          log("wizard key error:", e.message); // e.message never contains the key value
          return true;
        });
      } else if (a.secret || a.file) {
        // Non-text while awaiting a secret — never let it reach eve (delete-first inside).
        return handleAwaitNonText(msg, pending).catch((e) => {
          log("menu attachment capture error:", e.message); // never contains the secret value
          return true;
        });
      }
      // else: non-secret await + non-text → fall through so eve handles it normally.
    }
  }
  if (!text.startsWith("/")) return false;
  const cmd = text.split(/\s+/)[0].replace(/@\w+$/, "").toLowerCase();
  if (!["/menu", "/help", "/stop", "/usage", "/restart", "/new", "/update", "/model", "/think"].includes(cmd)) return false;
  const from = String(msg?.from?.id ?? "");
  if (ALLOWED.size === 0 || !ALLOWED.has(from)) return false; // untrusted — let eve drop it
  const chatId = msg?.chat?.id;
  // /menu — open the nested settings menu (out-of-band; errors consumed, never reach eve).
  if (cmd === "/menu") {
    await menu.open(chatId, from).catch((e) => log("menu error:", e.message));
    return true;
  }
  if (cmd === "/help") {
    await reply(chatId, helpText());
    return true;
  }
  // /stop — interrupt the current turn. Same path as the ⏹ Stop button: we synthesize a
  // callback_query with data "iva_cancel"; the channel resolves sessionId from run-status
  // and resumes eve's cancel hook. Out-of-band so it reaches a busy agent (an ordinary
  // message would be queued by the gate below and never processed).
  if (cmd === "/stop") {
    const key = chatKey(update);
    if (!key || !isRunning(key)) {
      await reply(chatId, tr("Nothing is running right now.", "Сейчас ничего не выполняется."));
      return true;
    }
    await deliver({
      update_id: 0,
      callback_query: {
        id: `ivastop-${Date.now()}`, // synthetic: answerCallbackQuery on it fails, channel tolerates
        from: msg.from,
        message: msg, // carries chat/thread — the channel derives chatKey from here
        data: "iva_cancel",
      },
    });
    return true;
  }
  // /usage — token spend from data/usage.jsonl. Out-of-band and FREE (we don't call the model).
  if (cmd === "/usage") {
    const arg = text.split(/\s+/).slice(1).join(" ");
    try {
      const agg = summarize(readEntries(), { window: parseWindow(arg), now: Date.now(), tz: process.env.ASSISTANT_TIMEZONE });
      await reply(chatId, formatUsageReport(agg));
    } catch (e) {
      await reply(chatId, "Couldn't read the usage log: " + e.message);
    }
    return true;
  }
  // /update — check upstream; if newer, offer inline Update/Skip buttons. Out-of-band.
  if (cmd === "/update") {
    await handleUpdateCheck(chatId);
    return true;
  }
  // /model, /think — provider/model/effort wizard (writes .env; applied on restart).
  if (cmd === "/model") {
    await handleModelCmd(chatId, from).catch((e) => log("wizard /model error:", e.message));
    return true;
  }
  if (cmd === "/think") {
    await handleThinkCmd(chatId, from).catch((e) => log("wizard /think error:", e.message));
    return true;
  }
  // /new retires only this exact Telegram session. /restart does the same first,
  // then restarts the agent process; histories and queues of other chats survive.
  const key = chatKey(update);
  const continuationToken = key
    ? continuationTokenForControl(update, getChatStatus(key), BOT_USER_ID)
    : null;
  const resetCopy = resetMessageCopy(cmd, await readEnvFresh(ENV_PATH));
  const status = await reply(chatId, resetCopy.pending);
  if (!continuationToken || !key) {
    if (status) {
      await edit(
        chatId,
        status.message_id,
        tr(
          "⚠️ I couldn't identify this conversation. In a group, reply /new to Iva's latest message.",
          "⚠️ Не удалось определить этот диалог. В группе ответьте /new на последнее сообщение Iva.",
        ),
      );
    }
    return true;
  }

  const clearsPrivateQueue = msg?.chat?.type === "private";
  try {
    await performScopedReset(key, continuationToken, {
      // Group/forum queues are keyed only by chat/topic while Eve sessions also
      // include conversationId. Clearing the shared queue here would lose
      // messages belonging to other group conversation anchors.
      clearQueue: clearsPrivateQueue,
    });
  } catch (e) {
    log(`scoped reset ${e.resetPhase ?? "unknown"} failed for ${key}:`, e.message);
    if (status) {
      await edit(
        chatId,
        status.message_id,
        e.resetPhase === "remote"
          ? tr(
              "⚠️ Couldn't confirm this conversation reset. Recovery will retry automatically.",
              "⚠️ Не удалось подтвердить сброс диалога. Восстановление повторит его автоматически.",
            )
          : tr(
              "⚠️ Conversation reset recovery is incomplete. Iva will retry it before accepting queued work.",
              "⚠️ Восстановление после сброса не завершено. Iva повторит его до приёма задач из очереди.",
            ),
      );
    }
    // A private reset request is ambiguous after any I/O failure: Eve may have
    // committed it even when the response was lost. Stop this polling process so
    // startup reconciliation consumes the durable intent before any old head.
    if (clearsPrivateQueue) throw e;
    return true;
  }

  if (cmd === "/restart" && !(await sc("restart", "iva.service"))) {
    if (status) {
      await edit(
        chatId,
        status.message_id,
        tr(
          "⚠️ Conversation reset, but Iva couldn't restart.",
          "⚠️ Диалог сброшен, но перезапустить Iva не удалось.",
        ),
      );
    }
    return true;
  }
  if (status) await edit(chatId, status.message_id, resetCopy.complete);
  return true;
}

async function main() {
  if (!TOKEN) throw new Error("no TELEGRAM_BOT_TOKEN in .env — nothing to poll");
  if (!SECRET) throw new Error("no TELEGRAM_WEBHOOK_SECRET_TOKEN — the channel won't accept updates");
  log(`telegram-poll start → messages ${ACCEPTANCE_ROUTE}; callbacks ${ROUTE}`);
  await removeStaleUpdateJobs();
  // Upgrade the old {chatKey: string[]} queue atomically before polling. A failed
  // migration stops the bridge, so Telegram retains new updates until the old bytes
  // are safely represented as versioned FIFO items.
  await migrateQueueFile(QUEUE_FILE, {
    onLegacyQuarantine: (path) =>
      log(`legacy Telegram group messages moved to ${path}; sender identity was unavailable`),
  });
  const reconciledResets = await reconcileScopedResetIntents();
  if (reconciledResets > 0) {
    log(`reconciled ${reconciledResets} durable private Telegram reset intent(s)`);
  }
  // First run (no offset file) — drop the accumulated install backlog (drop_pending=true),
  // so old messages don't replay in a batch → parallel sessions on one chat (HookConflict).
  // On subsequent starts we do NOT drop the backlog (don't lose messages that arrived while the bridge was down).
  const firstRun = !existsSync(OFFSET_FILE);
  const dw = await tg("deleteWebhook", { drop_pending_updates: firstRun });
  log("deleteWebhook:", dw.ok ? `ok (drop_pending=${firstRun})` : dw.description);
  await registerBotCommands();

  let { offset, delivered } = await loadOffset();
  if (offset === null) {
    offset = await fastForwardOffset();
    log("first run — offset past the tail of the queue:", offset);
    await saveOffset(offset);
  } else {
    log("starting offset:", offset);
  }

  for (;;) {
    // One head per idle chat/topic per pass. While any queue remains, use a short
    // Telegram long-poll so terminal/stale run-status changes trigger drain quickly.
    try {
      await reapStaleRuns();
    } catch (e) {
      log("stale run reaper failed:", e.message);
    }
    let pendingQueueCount = await drainReadyQueueHeads();
    let collectorWriteFailed = false;
    for (const update of collectorTakeExpired(messageCollector, Date.now())) {
      const routed = await routeMessageUpdate(update);
      if (routed === "delivered") {
        delivered =
          delivered === null ? update.update_id : Math.max(delivered, update.update_id);
        await saveOffset(offset, delivered);
      } else if (routed === "queued") {
        pendingQueueCount = Math.max(1, pendingQueueCount);
      } else if (routed === "enqueue-failed") {
        collectorRestore(messageCollector, update);
        collectorWriteFailed = true;
      }
    }
    if (collectorWriteFailed) {
      await sleep(3000);
      continue;
    }
    const pollSeconds =
      pendingQueueCount > 0 || collectorPending(messageCollector) > 0 ? 1 : 30;
    let data;
    try {
      data = await tg("getUpdates", {
        offset,
        timeout: pollSeconds,
        allowed_updates: ["message", "callback_query"],
      }, { timeoutMs: pollSeconds > 1 ? 40_000 : 10_000 });
    } catch (e) {
      log("getUpdates network:", e.message);
      await sleep(3000);
      continue;
    }
    if (!data.ok) {
      log("getUpdates:", data.description);
      // 409/conflict — a webhook is left somewhere; remove it and try again.
      if (/409|conflict|webhook/i.test(data.description || "")) {
        await tg("deleteWebhook", { drop_pending_updates: false });
      }
      await sleep(3000);
      continue;
    }
    let queueWriteFailed = false;
    for (const update of data.result || []) {
      // Переигровка после краша (Telegram = at-least-once): этот апдейт уже уходил в eve
      // в прошлой жизни процесса — второй раз не доставляем, только двигаем offset.
      if (alreadyDelivered(update.update_id, delivered)) {
        log(`skip update ${update.update_id} — already delivered before restart`);
        offset = update.update_id + 1;
        await saveOffset(offset, delivered);
        continue;
      }
      // Control commands (/restart, /help, /new) — the bridge handles them itself, doesn't send to eve.
      if (await handleControl(update)) {
        offset = update.update_id + 1;
        await saveOffset(offset, delivered);
        continue;
      }
      let candidate = update;
      let collected = false;
      if (update.message && !isReplyToBot(update.message)) {
        const offered = collectorOffer(messageCollector, update, Date.now());
        if (offered.status === "buffered") {
          // The quiet-window buffer is intentionally in-memory. Advancing now avoids
          // replaying every part, but a process crash can lose this one pending burst.
          offset = update.update_id + 1;
          await saveOffset(offset, delivered);
          continue;
        }
        if (offered.status === "ready") {
          candidate = offered.update;
          collected = true;
          offset = update.update_id + 1;
          await saveOffset(offset, delivered);
        }
      }

      const routed = await routeMessageUpdate(candidate);
      if (routed === "enqueue-failed") {
        if (collected) collectorRestore(messageCollector, candidate);
        // Passthrough retains the old durable retry point. Collected parts already
        // advanced offset when buffered and retry from the restored in-memory burst.
        queueWriteFailed = true;
        break;
      }
      if (!collected) offset = update.update_id + 1;
      if (routed === "delivered") {
        delivered =
          delivered === null ? candidate.update_id : Math.max(delivered, candidate.update_id);
      }
      await saveOffset(offset, delivered);
    }
    if (queueWriteFailed) await sleep(3000);
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error("telegram-poll fatal:", e);
    process.exit(1);
  });
}
