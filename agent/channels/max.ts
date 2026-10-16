// Канал MAX (https://dev.max.ru): личные текстовые сообщения → тот же агент Iva, что и у Telegram.
// Выключен по умолчанию: без MAX_BOT_TOKEN и MAX_WEBHOOK_SECRET роут отвечает 404.
// Доступ: MAX_ALLOWED_USER_IDS (пусто = никому). Сессии изолированы от Telegram.
import { defineChannel, POST } from "eve/channels";
import { humanizeProviderError } from "../lib/error-humanizer.js";
import { createMaxClient } from "../lib/max-api.js";
import { createDedup, loadMaxConfig } from "../lib/max-updates.js";
import { handleMaxWebhook, type MaxChannelState } from "../lib/max-webhook.js";
import { scanOutbound } from "../lib/security-gate.js";
import { tr } from "../../scripts/lib/i18n.mjs";

const config = loadMaxConfig();
const client = config ? createMaxClient({ token: config.token }) : null;
const dedup = createDedup();

const GREETING_EN = "Hi! I'm Iva. Just write to me. /new starts a fresh conversation.";
const GREETING_RU = "Привет! Я Ива. Просто напиши мне. /new — начать новый диалог.";

async function reply(state: MaxChannelState, text: string) {
  if (!client || !text.trim()) return;
  try {
    await client.sendText({ chatId: state.chatId }, text);
  } catch (err) {
    console.error("[max] delivery failed:", (err as Error).name, (err as { status?: number }).status ?? "");
  }
}

function failureText(data: { message: string; details?: unknown }) {
  const text = humanizeProviderError(data);
  return tr(text.en, text.ru);
}

export default defineChannel<MaxChannelState, { state: MaxChannelState }>({
  state: { chatId: "", userId: "" },
  context: (state) => ({ state }),
  routes: [
    POST<MaxChannelState>("/eve/v1/max", (request, { send, reset }) =>
      handleMaxWebhook(request, {
        config,
        client: client ?? { sendText: async () => {} },
        dedup,
        send: (message, options) => send(message, options),
        reset: (options) => reset(options),
        greeting: tr(GREETING_EN, GREETING_RU),
      }),
    ),
  ],
  events: {
    async "message.completed"(data, channel) {
      if (data.finishReason === "tool-calls" || !data.message) return;
      const guard = scanOutbound(data.message);
      if (!guard.clean) {
        console.error(
          "[security] outbound leak redacted:",
          guard.findings.map((f) => `${f.type}:${f.name}`).join(", "),
        );
      }
      await reply(channel.state, guard.text);
    },
    async "turn.failed"(data, channel) {
      await reply(channel.state, failureText(data));
    },
  },
});
