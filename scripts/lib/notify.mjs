// Единая доставка уведомлений владельцу (ежедневный дайджест, отчёты памяти, doctor, предложение
// обновления) для cron-скриптов и CLI. Канал выбирается конфигом, а не зашит:
//   NOTIFY_CHANNEL = auto (по умолчанию) | max | telegram | none
//   auto: MAX, если заданы MAX_BOT_TOKEN и получатель; иначе Telegram, если есть токен и чат;
//         иначе «не настроено» — это НЕ ошибка: задачи и память работают, просто без доставки.
// Получатель MAX: MAX_NOTIFY_USER_ID, иначе первый из MAX_ALLOWED_USER_IDS (адресация по user_id).
// Пустые/отсутствующие TELEGRAM_* ничего не ломают. Функции не бросают: возвращают {ok,error}.
import { createMaxClient, MaxApiError, resolveMaxBaseUrl, splitMaxText } from "../../agent/lib/max-api.ts";
import { scanOutbound } from "../../agent/lib/security-gate.ts";
import { notificationChat } from "./notification-chat.mjs";
import { sendTelegramHtml } from "./telegram-send.mjs";

const firstId = (v) => String(v ?? "").split(/[,\s]+/).map((s) => s.trim()).find((s) => /^\d+$/.test(s)) ?? "";

export function maxRecipient(env = process.env) {
  const explicit = String(env.MAX_NOTIFY_USER_ID ?? "").trim();
  return /^\d+$/.test(explicit) ? explicit : firstId(env.MAX_ALLOWED_USER_IDS);
}

/** { channel: "max"|"telegram"|null, ... } — какой канал сейчас доставит уведомление. */
export function notifyTarget(env = process.env) {
  const pref = String(env.NOTIFY_CHANNEL ?? "auto").trim().toLowerCase();
  const maxToken = String(env.MAX_BOT_TOKEN ?? "").trim();
  const maxUser = maxRecipient(env);
  const tgToken = String(env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const tgChat = notificationChat(env);
  const max = maxToken && maxUser ? { channel: "max", token: maxToken, userId: maxUser } : null;
  const tg = tgToken && tgChat ? { channel: "telegram", token: tgToken, chatId: tgChat } : null;
  if (pref === "none") return { channel: null };
  if (pref === "max") return max ?? { channel: null };
  if (pref === "telegram") return tg ?? { channel: null };
  return max ?? tg ?? { channel: null };
}

export const notifyConfigured = (env = process.env) => notifyTarget(env).channel !== null;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendMaxChunk(client, target, text, { format, keyboard }, sleep) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await client.sendOnce(target, text, { format, keyboard });
    } catch (err) {
      lastErr = err;
      if (!(err instanceof MaxApiError) || !err.retryable || attempt === 4) throw err;
      await sleep(err.retryAfterMs ?? 1000 * 2 ** (attempt - 1));
    }
  }
  throw lastErr;
}

/**
 * Отправляет markdown-отчёт. Возвращает { ok, fellBack, error, channel, configured }.
 * fellBack=true — форматирование не принялось и ушёл плоский текст (агенту стоит упростить разметку).
 */
export async function sendReport(md, { env = process.env, fetchImpl, sleep = defaultSleep, caption = false, plain = false } = {}) {
  const t = notifyTarget(env);
  if (!t.channel) return { ok: false, fellBack: false, error: "not-configured", channel: null, configured: false };
  const guard = scanOutbound(md);
  if (!guard.clean) console.error("[security] outbound report leak redacted:", guard.findings.map((f) => `${f.type}:${f.name}`).join(", "));
  md = guard.text;

  if (t.channel === "telegram") {
    const r = await sendTelegramHtml(t.token, t.chatId, md, { caption });
    return { ...r, channel: "telegram", configured: true };
  }

  const client = createMaxClient({
    token: t.token,
    baseUrl: resolveMaxBaseUrl(env.MAX_API_BASE_URL),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  let fellBack = false;
  try {
    const chunks = splitMaxText(md);
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await sleep(550); // ≤2 сообщения/с на диалог
      const target = { chatId: null, userId: t.userId };
      if (plain) {
        await sendMaxChunk(client, target, chunks[i], {}, sleep);
        continue;
      }
      try {
        await sendMaxChunk(client, target, chunks[i], { format: "markdown" }, sleep);
      } catch (err) {
        // 400 — разметка не принята: один раз повторяем плоским текстом.
        if (!(err instanceof MaxApiError) || err.status !== 400) throw err;
        fellBack = true;
        await sendMaxChunk(client, target, chunks[i], {}, sleep);
      }
    }
    return { ok: true, fellBack, error: "", channel: "max", configured: true };
  } catch (err) {
    return { ok: false, fellBack, error: err instanceof MaxApiError ? `${err.message}${err.code ? ` (${err.code})` : ""}` : String(err?.message ?? err), channel: "max", configured: true };
  }
}

/** Короткое служебное сообщение (doctor и т.п.) — без markdown. */
export const sendNotice = (text, opts = {}) => sendReport(text, { ...opts, plain: true });

/**
 * Предложение обновления с кнопками «Обновить/Позже». MAX: inline-клавиатура с callback-payload
 * `iva_update:do|skip` (тот же словарь, что в Telegram). Бросает при ошибке — как sendUpdateOffer.
 */
export async function sendUpdateOfferVia({ env = process.env, offer, fetchImpl } = {}) {
  const t = notifyTarget(env);
  if (!t.channel) throw new Error("notifications are not configured");
  if (t.channel === "telegram") {
    const { sendUpdateOffer } = await import("./update-check.mjs");
    return sendUpdateOffer({ token: t.token, chatId: t.chatId, offer, ...(fetchImpl ? { fetchImpl } : {}) });
  }
  const client = createMaxClient({
    token: t.token,
    baseUrl: resolveMaxBaseUrl(env.MAX_API_BASE_URL),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const keyboard = [offer.replyMarkup.inline_keyboard[0].map((b) => ({ type: "callback", text: b.text, payload: b.callback_data }))];
  return client.sendOnce({ chatId: null, userId: t.userId }, offer.text, { keyboard });
}
