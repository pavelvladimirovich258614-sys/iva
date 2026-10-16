// Канал MAX (https://dev.max.ru): личные текстовые сообщения → тот же агент Iva, что и у Telegram.
// Выключен по умолчанию: без MAX_BOT_TOKEN и MAX_WEBHOOK_SECRET роут отвечает 404.
// Доступ: MAX_ALLOWED_USER_IDS (пусто = никому). Сессии изолированы от Telegram (namespace «max:»).
// Состояние (дедуп входящих, очередь исходящих) — data/max/, вне git. Подробности: docs/max.md.
import { defineChannel, GET, POST } from "eve/channels";
import { humanizeProviderError } from "../lib/error-humanizer.js";
import { createMaxClient, resolveMaxBaseUrl } from "../lib/max-api.js";
import { createMaxOutbox } from "../lib/max-outbox.js";
import { createMaxStore, maxDataDir } from "../lib/max-store.js";
import { MAX_SECRET_HEADER, loadMaxConfig, verifyMaxSecret } from "../lib/max-updates.js";
import { handleMaxWebhook, type MaxChannelState } from "../lib/max-webhook.js";
import { scanOutbound } from "../lib/security-gate.js";
import { tr } from "../../scripts/lib/i18n.mjs";

const config = loadMaxConfig();

const numEnv = (name: string) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

// Всё тяжёлое (файлы, клиент, таймеры) создаётся только при включённом MAX.
const runtime = config
  ? (() => {
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
      outbox.start(); // возобновляет недоставленное с прошлого запуска
      return { store, outbox };
    })()
  : null;

const GREETING = () =>
  tr(
    "Hi! I'm Iva. Just write to me. /new starts a fresh conversation.",
    "Привет! Я Ива. Просто напиши мне. /new — начать новый диалог.",
  );

/** Ответ агента → durable outbox. Сбой постановки громко логируется: пользователь ответа не получит. */
function reply(state: MaxChannelState, text: string) {
  if (!runtime || !text.trim()) return;
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
    POST<MaxChannelState>("/eve/v1/max", async (request, { send, reset }) => {
      if (!config || !runtime) return new Response("not found", { status: 404 }); // MAX выключен
      return handleMaxWebhook(request, {
        config,
        store: runtime.store,
        reply: (userId, text) => void runtime.outbox.enqueue(userId, text),
        send: (message, options) => send(message, options),
        reset: (options) => reset(options),
        greeting: GREETING(),
        newConversation: tr("Started a new conversation.", "Начала новый диалог."),
      });
    }),
    // Диагностика очереди: тот же секрет, что и у webhook; без текстов сообщений.
    GET<MaxChannelState>("/eve/v1/max/status", async (request) => {
      if (!config || !runtime) return new Response("not found", { status: 404 });
      if (!verifyMaxSecret(request.headers.get(MAX_SECRET_HEADER), config.webhookSecret)) {
        return new Response("unauthorized", { status: 401 });
      }
      const s = runtime.store.stats();
      return Response.json({
        acceptedEvents: s.accepted,
        queued: s.queued,
        dead: s.dead,
        oldestQueuedAt: s.oldestQueuedAt,
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
