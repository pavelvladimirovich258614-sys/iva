// Канал MAX (https://dev.max.ru): личные текстовые сообщения → тот же агент Iva, что и у Telegram.
// Выключен по умолчанию: без MAX_BOT_TOKEN и MAX_WEBHOOK_SECRET роут отвечает 404.
// Доступ: MAX_ALLOWED_USER_IDS (пусто = никому). Сессии изолированы от Telegram (namespace «max:»).
// Состояние (дедуп входящих, очередь исходящих) — data/max/, вне git. Подробности: docs/max.md.
import { defineChannel, GET, POST } from "eve/channels";
import { appendDaily } from "../lib/daily-log.js";
import { humanizeProviderError } from "../lib/error-humanizer.js";
import { createMaxClient, resolveMaxBaseUrl } from "../lib/max-api.js";
import { createMediaJobs } from "../lib/max-media-jobs.js";
import { cleanStaleTmp, createMediaProcessor, loadMediaConfig } from "../lib/max-media.js";
import { createMediaRunner } from "../lib/max-media-runner.js";
import { checkSendableFile } from "../lib/max-send-policy.js";
import { sttConfigured, transcribeFile } from "../lib/stt.js";
import { describeImage, visionAvailable } from "../vision.js";
import { createMaxOutbox } from "../lib/max-outbox.js";
import { createMaxStore, maxDataDir } from "../lib/max-store.js";
import { readBodyLimited } from "../lib/max-body.js";
import { MAX_SECRET_HEADER, loadMaxConfig, parseMaxJson, verifyMaxSecret } from "../lib/max-updates.js";
import { handleMaxWebhook, maxContinuationToken, type MaxChannelState } from "../lib/max-webhook.js";
import { scanOutbound } from "../lib/security-gate.js";
import { helpText, tr } from "../../scripts/lib/i18n.mjs";
import { formatUsageReport, parseWindow, readEntries, summarize } from "../../scripts/lib/usage.mjs";

const config = loadMaxConfig();

const numEnv = (name: string) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

// Всё тяжёлое (файлы, клиент, таймеры) создаётся только при включённом MAX и лениво: если хранилище
// нельзя открыть (нет прав на data/max, нечитаемый файл), приложение Eve в целом остаётся живым,
// а MAX-роуты отвечают 503 и логируют причину — вместо ложного 404/200. Повторная попытка — на
// следующем запросе.
type Runtime = {
  store: ReturnType<typeof createMaxStore>;
  outbox: ReturnType<typeof createMaxOutbox>;
  jobs: ReturnType<typeof createMediaJobs>;
  runner: ReturnType<typeof createMediaRunner>;
};
let runtimeCache: Runtime | null = null;
function getRuntime(): Runtime | null {
  if (!config) return null;
  if (runtimeCache) return runtimeCache;
  const store = createMaxStore({ dir: maxDataDir() });
  const client = createMaxClient({
    token: config.token,
    baseUrl: resolveMaxBaseUrl(process.env.MAX_API_BASE_URL),
  });
  const outbox = createMaxOutbox({
    store,
    client,
    backoffBaseMs: numEnv("MAX_OUTBOX_BACKOFF_MS"),
    minIntervalMs: numEnv("MAX_MIN_SEND_INTERVAL_MS"),
  });
  const dir = maxDataDir();
  const apiBase = resolveMaxBaseUrl(process.env.MAX_API_BASE_URL);
  const loopbackApi = ["127.0.0.1", "localhost", "[::1]"].includes(new URL(apiBase).hostname);
  const mediaCfg = loadMediaConfig(process.env, { dataDir: dir, loopbackApi });
  cleanStaleTmp(mediaCfg.tmpDir);
  const jobs = createMediaJobs({ dir });
  const processor = createMediaProcessor(mediaCfg, {
    client,
    describeImage,
    transcribe: (path, mimeType) => transcribeFile(path, { mimeType }),
    sttConfigured: () => sttConfigured(),
    visionConfigured: () => visionAvailable(),
    appendDaily: (type, content) => appendDaily(type, content),
    log: (m) => console.error(`[max] media: ${m}`),
  });
  const runner = createMediaRunner({
    jobs,
    processor,
    reply: (userId, text) => void outbox.enqueue(userId, text),
    logInbound: (text) => void appendDaily("[text]", text),
    sendTimeoutMs: numEnv("MAX_AGENT_SEND_TIMEOUT_MS"),
    unknownGraceMs: numEnv("MAX_SEND_UNKNOWN_GRACE_MS"),
    flushMs: numEnv("MAX_MEDIA_FLUSH_MS"),
  });
  // Задания, оставшиеся от прошлого процесса, молча не повторяем: сообщаем пользователю об обрыве.
  const interrupted = runner.recover();
  if (interrupted) console.error(`[max] ${interrupted} attachment job(s) were interrupted by a restart; users were notified`);
  runner.start(); // повторная доставка уведомлений, которые не удалось поставить в очередь
  outbox.start(); // возобновляет недоставленное с прошлого запуска
  runtimeCache = { store, outbox, jobs, runner };
  return runtimeCache;
}
function tryRuntime(): Runtime | null | "unavailable" {
  try {
    return getRuntime();
  } catch (err) {
    console.error("[max] storage unavailable:", (err as Error).message);
    return "unavailable";
  }
}
// Поднимаем сразу, чтобы недоставленные ответы прошлого запуска ушли без ожидания первого запроса.
tryRuntime();

/** Тексты служебных команд; функции — язык берётся в момент вызова (tr), не при импорте. */
const commands = () => ({
  greeting: tr(
    "Hi! I'm Iva. Just write to me. /help lists the commands, /new starts a fresh conversation.",
    "Привет! Я Ива. Просто напиши мне. /help — список команд, /new — начать новый диалог.",
  ),
  newConversation: tr("Started a new conversation.", "Начала новый диалог."),
  help: () => helpText(),
  usage: (arg: string) => {
    try {
      return formatUsageReport(
        summarize(readEntries(), { window: parseWindow(arg), now: Date.now(), tz: process.env.ASSISTANT_TIMEZONE }),
      );
    } catch (e) {
      return `Couldn't read the usage log: ${(e as Error).message}`;
    }
  },
  stopped: tr("Stopping…", "Останавливаю…"),
  nothingRunning: tr("Nothing is running right now.", "Сейчас ничего не выполняется."),
  sendFailed: tr("I could not hand your message to the agent. Please send it again.", "Не удалось передать твоё сообщение агенту. Пришли его ещё раз."),
  mediaUnsupported: tr("Attachments are not enabled in this installation.", "Вложения в этой установке не включены."),
  needsBridge: tr(
    "This command needs the MAX bridge (service iva-max-bridge) — it is not running. Check: iva status",
    "Эта команда работает через MAX-мост (сервис iva-max-bridge), а он не запущен. Проверь: iva status",
  ),
});

/** Ответ агента → durable outbox. Сбой постановки громко логируется: пользователь ответа не получит. */
function reply(state: MaxChannelState, text: string) {
  const runtime = tryRuntime();
  if (!runtime || runtime === "unavailable" || !text.trim()) return;
  try {
    runtime.outbox.enqueue(state.userId, text);
  } catch (err) {
    console.error("[max] REPLY LOST: cannot persist outbound message:", (err as Error).message);
  }
}

function failureText(data: { message: string; details?: unknown }) {
  const text = humanizeProviderError(data);
  return tr(text.en, text.ru);
}

export default defineChannel<MaxChannelState, { state: MaxChannelState }>({
  state: { userId: "" },
  context: (state) => ({ state }),
  routes: [
    POST<MaxChannelState>("/eve/v1/max", async (request, { send, reset, cancel, waitUntil }) => {
      if (!config) return new Response("not found", { status: 404 }); // MAX выключен
      const runtime = tryRuntime();
      if (runtime === "unavailable" || !runtime) return new Response("storage unavailable", { status: 503 });
      return handleMaxWebhook(request, {
        config,
        store: runtime.store,
        reply: (userId, text) => void runtime.outbox.enqueue(userId, text),
        send: (message, options) => send(message, options),
        reset: (options) => reset(options),
        cancel: (options) => cancel(options),
        commands: commands(),
        media: {
          accept: (job) => runtime.jobs.accept(job),
          start: (job, sendMessage) => {
            const p = runtime.runner.run(job, sendMessage);
            try {
              waitUntil(p);
            } catch {
              /* окружение без waitUntil: промис всё равно выполняется */
            }
          },
        },
        logInbound: (text) => void appendDaily("[text]", text),
      });
    }),
    // Сброс сессии MAX-диалога для моста (/restart): тот же секрет, что и у webhook.
    POST<MaxChannelState>("/eve/v1/max/reset", async (request, { reset }) => {
      if (!config) return new Response("not found", { status: 404 });
      if (!verifyMaxSecret(request.headers.get(MAX_SECRET_HEADER), config.webhookSecret)) {
        return new Response("unauthorized", { status: 401 });
      }
      const runtime = tryRuntime();
      if (runtime === "unavailable" || !runtime) return new Response("storage unavailable", { status: 503 });
      const body = await readBodyLimited(request, { maxBytes: 4096, timeoutMs: 5000 });
      let userId = "";
      try {
        userId = body.ok ? String((parseMaxJson(body.text) as { userId?: unknown })?.userId ?? "") : "";
      } catch {
        /* invalid JSON → empty */
      }
      if (!config.allowedUserIds.has(userId)) return new Response("forbidden", { status: 403 });
      const result = await reset({ continuationToken: maxContinuationToken(userId), reason: "MAX bridge restart" });
      return Response.json({ ok: true, result });
    }),
    // Отправка файла пользователю (вызывает инструмент max_send_file): тот же секрет, что и у webhook.
    POST<MaxChannelState>("/eve/v1/max/send-file", async (request) => {
      if (!config) return new Response("not found", { status: 404 });
      if (!verifyMaxSecret(request.headers.get(MAX_SECRET_HEADER), config.webhookSecret)) {
        return new Response("unauthorized", { status: 401 });
      }
      const runtime = tryRuntime();
      if (runtime === "unavailable" || !runtime) return new Response("storage unavailable", { status: 503 });
      const body = await readBodyLimited(request, { maxBytes: 16 * 1024, timeoutMs: 5000 });
      if (!body.ok) return Response.json({ ok: false, error: body.reason }, { status: body.status });
      let input: { userId?: unknown; path?: unknown; caption?: unknown; name?: unknown } = {};
      try {
        input = parseMaxJson(body.text) as typeof input;
      } catch {
        return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 });
      }
      // Адресат — только пользователь из allowlist; без явного адресата — единственный владелец.
      let userId = typeof input.userId === "string" ? input.userId : "";
      if (!userId && config.allowedUserIds.size === 1) userId = [...config.allowedUserIds][0]!;
      if (!config.allowedUserIds.has(userId)) return Response.json({ ok: false, error: "recipient is not allowed" }, { status: 403 });
      if (typeof input.path !== "string" || !input.path) return Response.json({ ok: false, error: "path is required" }, { status: 400 });
      const checked = checkSendableFile(input.path, { displayName: typeof input.name === "string" ? input.name : undefined });
      if (!checked.ok) return Response.json({ ok: false, code: checked.code, error: checked.reason }, { status: 422 });
      try {
        const caption = typeof input.caption === "string" ? scanOutbound(input.caption).text : "";
        const item = runtime.outbox.enqueueFile(
          userId,
          { path: checked.realPath, fileName: checked.fileName, uploadType: checked.uploadType, mimeType: checked.mimeType, size: checked.size },
          caption,
        );
        return Response.json({ ok: true, queued: true, id: item.id, fileName: checked.fileName, uploadType: checked.uploadType, size: checked.size });
      } catch (err) {
        console.error("[max] FILE NOT QUEUED:", (err as Error).message);
        return Response.json({ ok: false, error: "could not persist the delivery queue" }, { status: 503 });
      }
    }),
    // Диагностика очереди: тот же секрет, что и у webhook; без текстов сообщений.
    GET<MaxChannelState>("/eve/v1/max/status", async (request) => {
      if (!config) return new Response("not found", { status: 404 });
      if (!verifyMaxSecret(request.headers.get(MAX_SECRET_HEADER), config.webhookSecret)) {
        return new Response("unauthorized", { status: 401 });
      }
      const runtime = tryRuntime();
      if (runtime === "unavailable" || !runtime) return new Response("storage unavailable", { status: 503 });
      const s = runtime.store.stats();
      return Response.json({
        acceptedEvents: s.accepted,
        queued: s.queued,
        dead: s.dead,
        oldestQueuedAt: s.oldestQueuedAt,
        health: { ...s.health, mediaJobs: runtime.jobs.health() },
        deadItems: s.deadItems.map(({ id, userId, attempts, textLength, lastError, createdAt }) => ({
          id,
          userId,
          attempts,
          textLength,
          lastError,
          createdAt,
        })),
      });
    }),
  ],
  events: {
    "message.completed"(data, channel) {
      if (data.finishReason === "tool-calls" || !data.message) return;
      const guard = scanOutbound(data.message);
      if (!guard.clean) {
        console.error(
          "[security] outbound leak redacted:",
          guard.findings.map((f) => `${f.type}:${f.name}`).join(", "),
        );
      }
      reply(channel.state, guard.text);
    },
    "turn.failed"(data, channel) {
      reply(channel.state, failureText(data));
    },
  },
});
