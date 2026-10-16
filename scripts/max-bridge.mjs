#!/usr/bin/env node
// MAX bridge — единая точка входа событий MAX и локального управления Ивой.
//
//   node --env-file=.env scripts/max-bridge.mjs
//
// MAX_INGEST=webhook  (рекомендуется для постоянной эксплуатации): мост слушает HTTP на
//                     127.0.0.1:MAX_BRIDGE_PORT, путь /max/webhook; наружу публикуется reverse proxy
//                     (HTTPS:443) ТОЛЬКО на этот путь. Подписку на стороне MAX создаёт
//                     `iva max webhook set <url>`.
// MAX_INGEST=poll     (по умолчанию, для разработки/без домена): long polling GET /updates.
//
// Оба режима используют один и тот же process(update) (scripts/lib/max-bridge-core.mjs): текст и
// /new /stop /help /usage /task /tasks /digest уходят в канал агента (POST /eve/v1/max на loopback),
// /menu /model /think /restart /update и кнопки выполняются здесь — нужны права пользователя
// systemd (`systemctl --user`, `systemd-run --user`) и запись в .env. Роуты Eve наружу не публикуются.
// Одновременно работает один транспорт (блокировка + проверка подписки MAX).
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMaxClient, resolveMaxBaseUrl } from "../agent/lib/max-api.ts";
import { MAX_SECRET_HEADER, loadMaxConfig } from "../agent/lib/max-updates.ts";
import { createLedger } from "../agent/lib/max-ledger.ts";
import { readEnvFresh } from "./lib/env-file.mjs";
import { botCommands, getLang, tr } from "./lib/i18n.mjs";
import { createFlows } from "./lib/tg-flow.mjs";
import { createMenu } from "./lib/menu/index.mjs";
import { createModelWizard } from "./lib/model-wizard.mjs";
import { createMaxTg } from "./lib/max-tg.mjs";
import { createFailureTracker, createMaxBridge } from "./lib/max-bridge-core.mjs";
import {
  EX_CONFIG,
  TransportConflict,
  acquireTransportLock,
  checkSubscriptionForMode,
  createWebhookServer,
  runPolling,
} from "./lib/max-ingest.mjs";
import { modelSummary } from "./lib/model-summary.mjs";
import { acquireUpdateLock, releaseUpdateLock } from "./lib/update-safety.mjs";
import { inspectUpstream, markVersionNotified, updateOffer } from "./lib/update-check.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const UPDATE_TYPES = ["message_created", "message_callback", "bot_started"];

const log = (...a) => console.error(new Date().toISOString(), "[max-bridge]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function bridgePaths(env = process.env, root = ROOT) {
  const raw = env.ASSISTANT_DATA_DIR ?? "data";
  const dataDir = raw.startsWith("/") ? raw : join(root, raw);
  return { dataDir, markerFile: join(dataDir, "max", "bridge.json"), envPath: join(root, ".env") };
}

async function loadMarker(file) {
  try {
    const m = JSON.parse(await readFile(file, "utf8"))?.marker;
    return typeof m === "string" && /^-?\d+$/.test(m) ? m : null;
  } catch {
    return null;
  }
}
async function saveMarker(file, marker) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ marker }), { mode: 0o600 });
  await rename(tmp, file);
}

const sc = (...args) => new Promise((resolve) => execFile("systemctl", ["--user", ...args], (err) => resolve(!err)));

export async function main(env = process.env) {
  const config = loadMaxConfig(env);
  if (!config) {
    log("MAX_BOT_TOKEN and MAX_WEBHOOK_SECRET are required (see docs/max.md)");
    process.exit(1);
  }
  const { dataDir, markerFile, envPath } = bridgePaths(env);
  const PORT = env.IVA_PORT ?? "8723";
  const HOST = (env.ASSISTANT_HOST ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
  const ROUTE = `${HOST}/eve/v1/max`;
  const allowed = config.allowedUserIds;
  const client = createMaxClient({ token: config.token, baseUrl: resolveMaxBaseUrl(env.MAX_API_BASE_URL) });

  const dialogs = new Map(); // user_id → последний известный chat_id диалога
  const tracker = createFailureTracker();
  const tg = tracker.wrap(createMaxTg(client, { dialogChatId: (u) => dialogs.get(u) ?? null, log }));
  const ingest = String(env.MAX_INGEST ?? "poll").trim().toLowerCase() === "webhook" ? "webhook" : "poll";
  const stateDir = join(dataDir, "max");

  async function reply(chatId, text) {
    const r = await tg("sendMessage", { chat_id: chatId, text });
    if (!r.ok) {
      log("reply failed:", r.description);
      return null;
    }
    return r.result;
  }
  async function edit(chatId, messageId, text, replyMarkup) {
    const body = { chat_id: chatId, message_id: messageId, text };
    if (replyMarkup !== undefined) body.reply_markup = replyMarkup;
    const r = await tg("editMessageText", body);
    if (!r.ok) log("edit failed:", r.description);
    return r.ok ? r.result : null;
  }

  // ── пересылка в канал агента ────────────────────────────────────────────
  async function forward(update) {
    let res;
    try {
      res = await fetch(ROUTE, {
        method: "POST",
        headers: { [MAX_SECRET_HEADER]: config.webhookSecret, "content-type": "application/json" },
        body: JSON.stringify(update),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      throw Object.assign(new Error(`agent unreachable (${e.name})`), { retryable: true });
    }
    await res.body?.cancel().catch(() => {});
    if (res.ok) return;
    // 4xx (кроме ошибок конфигурации/перегрузки) — событие заведомо негодное: повтор не поможет, не блокируем очередь.
    const consumed = res.status >= 400 && res.status < 500 && ![401, 404, 408, 429].includes(res.status);
    const hint = res.status === 401 || res.status === 404 ? " — check MAX_WEBHOOK_SECRET / MAX_BOT_TOKEN in .env" : "";
    throw Object.assign(new Error(`agent channel answered HTTP ${res.status}${hint}`), { consumed });
  }
  // Синтетическое сообщение от имени владельца (дистилляция памяти из /menu): тот же канал.
  const deliverSynthetic = async (u) => {
    const text = u?.message?.text;
    const userId = String(u?.message?.from?.id ?? "");
    if (!text || !userId) return false;
    await forward({
      update_type: "message_created",
      timestamp: Date.now(),
      message: {
        sender: { user_id: userId, first_name: "owner", is_bot: false },
        recipient: { chat_type: "dialog", chat_id: dialogs.get(userId) ?? null, user_id: null },
        timestamp: Date.now(),
        body: { mid: `synthetic-${randomBytes(6).toString("hex")}`, seq: 0, text },
      },
    });
    return true;
  };

  // ── /update ─────────────────────────────────────────────────────────────
  function launchSelfUpdate(jobId) {
    const args = [
      "--user", "--collect", `--unit=iva-self-update-${Date.now()}`,
      `--working-directory=${ROOT}`, `--setenv=PATH=${env.PATH || ""}`,
      NODE, join(ROOT, "bin/iva.mjs"), "update", "--job", jobId,
    ];
    return new Promise((resolve) => execFile("systemd-run", args, (err, out, e) => resolve({ ok: !err, msg: (e || out || "").toString().trim() })));
  }
  async function handleUpdateCheck(chatId, { inspectImpl = inspectUpstream } = {}) {
    const status = await reply(chatId, tr("◇ Checking for updates", "◇ Проверяю обновления"));
    if (!status?.message_id) return;
    let info;
    try {
      info = await inspectImpl({ root: ROOT });
    } catch {
      await edit(chatId, status.message_id, tr("⚠️ Couldn't check for updates", "⚠️ Не удалось проверить обновления"));
      return;
    }
    if (!info.hasCommitUpdate) {
      const model = modelSummary(await readEnvFresh(envPath));
      await edit(chatId, status.message_id, tr(
        `✅ You're up to date\n\nIva v${info.localVersion ?? "?"}\nModel: ${model.line}`,
        `✅ У вас актуальная версия\n\nIva v${info.localVersion ?? "?"}\nМодель: ${model.line}`,
      ));
      return;
    }
    const bump = info.remoteVersion && info.remoteVersion !== info.localVersion
      ? `v${info.localVersion ?? "?"} → v${info.remoteVersion}`
      : tr(`v${info.localVersion ?? "?"} → newer build`, `v${info.localVersion ?? "?"} → новая сборка`);
    const offered = await edit(chatId, status.message_id, tr(
      `⬆️ Update available\n\n${bump}\nSettings and local changes will be preserved.`,
      `⬆️ Доступно обновление\n\n${bump}\nНастройки и локальные изменения будут сохранены.`,
    ), updateOffer(info.localVersion, info.remoteVersion, getLang()).replyMarkup);
    if (offered && info.hasVersionUpdate) await markVersionNotified(dataDir, info.remoteVersion).catch((e) => log("update notification state failed:", e.message));
  }
  async function handleUpdateCallback(cq) {
    await tg("answerCallbackQuery", { callback_query_id: cq.id });
    const userId = String(cq.from.id);
    const messageId = cq.message.message_id;
    const action = cq.data.slice("iva_update:".length);
    if (action === "skip") {
      await edit(userId, messageId, tr("– Update postponed", "– Обновление отложено"), { inline_keyboard: [] });
      return true;
    }
    const jobId = randomBytes(8).toString("hex");
    const lock = acquireUpdateLock(dataDir, jobId);
    if (!lock.ok) {
      await edit(userId, messageId, tr("⚠️ An update is already running", "⚠️ Обновление уже идёт"), { inline_keyboard: [] });
      return true;
    }
    const jobs = join(dataDir, "update-jobs");
    await mkdir(jobs, { recursive: true });
    await writeFile(join(jobs, `${jobId}.json`), JSON.stringify({
      transport: "max", userId, chatId: dialogs.get(userId) ?? null, messageId,
      locale: getLang(), startedAt: new Date().toISOString(),
    }), { mode: 0o600 });
    await edit(userId, messageId, tr("◇ Saving your changes", "◇ Сохраняю ваши изменения"), { inline_keyboard: [] });
    const r = await launchSelfUpdate(jobId);
    if (!r.ok) {
      releaseUpdateLock(lock);
      await rm(join(jobs, `${jobId}.json`), { force: true });
      await edit(userId, messageId, tr("⚠️ Couldn't start the update", "⚠️ Не удалось запустить обновление"));
    }
    return true;
  }
  // Старые задания обновления (бросили на полпути) не копим.
  (async () => {
    const jobs = join(dataDir, "update-jobs");
    try {
      for (const name of await readdir(jobs)) {
        const p = join(jobs, name);
        if (name.endsWith(".json") && Date.now() - (await stat(p)).mtimeMs > 6 * 3600_000) await rm(p, { force: true });
      }
    } catch {}
  })();

  // ── /restart: сброс сессии MAX + рестарт агента ────────────────────────
  async function restartAgent(userId) {
    const status = await reply(userId, tr("◇ Restarting Iva", "◇ Перезапускаю Iva"));
    try {
      await fetch(`${ROUTE}/reset`, {
        method: "POST",
        headers: { [MAX_SECRET_HEADER]: config.webhookSecret, "content-type": "application/json" },
        body: JSON.stringify({ userId }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      log("session reset before restart failed:", e.name);
    }
    const ok = await sc("restart", "iva.service");
    const done = ok
      ? tr(`♻️ Iva restarted\n\nModel: ${modelSummary(await readEnvFresh(envPath)).line}\nUnfinished turn cleared`,
          `♻️ Iva перезапущена\n\nМодель: ${modelSummary(await readEnvFresh(envPath)).line}\nНезавершённый ход очищен`)
      : tr("⚠️ Couldn't restart (systemctl). Check the service on the server.", "⚠️ Не удалось перезапустить (systemctl). Проверь сервис на сервере.");
    if (status?.message_id) await edit(userId, status.message_id, done);
    else await reply(userId, done);
  }

  // ── движки меню и мастеров ─────────────────────────────────────────────
  const flows = createFlows({ tg, log });
  // Секреты (ключи API, client_secret, одноразовые коды) в чат MAX НЕ принимаются, пока не доказано,
// что MAX позволяет гарантированно удалить сообщение пользователя. Явный opt-in: MAX_SECRETS_IN_CHAT=1.
  const secretsInChat = String(env.MAX_SECRETS_IN_CHAT ?? "") === "1";
  if (secretsInChat) log("WARNING: MAX_SECRETS_IN_CHAT=1 — secrets typed into chat may stay in the dialog history");
  const wizard = createModelWizard({ tg, log, flows, envPath, dataDir, allowed, sc, reply, isPrivate: () => true, secretsInChat });
  const menu = createMenu({
    flows, tg,
    deps: {
      transport: "max", secretsInChat, envPath, dataDir, root: ROOT, sc, reply, deliver: deliverSynthetic, log, allowed,
      handleModelCmd: wizard.handleModelCmd, handleThinkCmd: wizard.handleThinkCmd, handleUpdateCheck,
    },
  });
  const ledger = createLedger({ dir: stateDir, log });
  const bridge = createMaxBridge({
    allowed, forward, tg, reply, menu, wizard, flows, handleUpdate: handleUpdateCallback, handleUpdateCheck,
    restartAgent, ledger, tracker, rememberDialog: (u, c) => dialogs.set(String(u), String(c)), log,
  });

  // ── один транспорт: блокировка и проверка подписки MAX ──────────────────
  let release;
  try {
    release = acquireTransportLock(stateDir, ingest);
    const sub = await checkSubscriptionForMode(client, ingest, { webhookUrl: String(env.MAX_WEBHOOK_URL ?? "").trim() });
    if (sub.warning) log("WARNING:", sub.warning);
  } catch (e) {
    if (e instanceof TransportConflict) {
      log(`FATAL: ${e.message}`);
      release?.();
      process.exit(EX_CONFIG);
    }
    throw e;
  }
  process.on("exit", () => release?.());

  // ── старт: проверка токена, список команд ────────────────────────────────
  try {
    const me = await client.getMe();
    log(`bot ${me.username ? "@" + me.username : "(no username)"} id=${me.userId}; mode=${ingest}; allowed users: ${[...allowed].join(",") || "NONE (bot answers nobody)"}`);
  } catch (e) {
    log("getMe failed — check MAX_BOT_TOKEN:", e.message);
  }
  try {
    await client.setCommands(botCommands(getLang()).map((c) => ({ name: c.command, description: c.description.slice(0, 128) })));
  } catch (e) {
    log("setCommands failed:", e.message);
  }

  const stop = new AbortController();
  let server = null;
  const shutdown = () => {
    stop.abort();
    server?.close();
    release?.();
    setTimeout(() => process.exit(0), 500).unref();
  };
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, shutdown);

  if (ingest === "webhook") {
    const host = String(env.MAX_BRIDGE_HOST ?? "127.0.0.1").trim() || "127.0.0.1";
    const port = Number(env.MAX_BRIDGE_PORT ?? 8725);
    server = createWebhookServer({ secret: config.webhookSecret, process: bridge.process, log: (...a) => log(...a) });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
    if (!["127.0.0.1", "::1", "localhost"].includes(host)) log(`WARNING: webhook listener is bound to ${host}; put it behind TLS and expose only /max/webhook`);
    log(`webhook listener on http://${host}:${port}/max/webhook`);
    await new Promise((resolve) => stop.signal.addEventListener("abort", resolve));
    return;
  }

  await runPolling({
    client, process: bridge.process, signal: stop.signal, log,
    types: UPDATE_TYPES,
    markerStore: { load: () => loadMarker(markerFile), save: (m) => saveMarker(markerFile, m) },
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error("max-bridge fatal:", e);
    process.exit(1);
  });
}
