// Ядро MAX-моста: маршрутизация одного Update. Транспортно-зависимое (HTTP к MAX, systemctl, файлы)
// приходит зависимостями, поэтому логика проверяется юнит-тестами без сети.
//
// Что делает мост сам (нужны локальные права: .env, systemctl, `iva update`):
//   /menu, /model, /think, /restart, /update, нажатия кнопок (iva_menu:*, iva_model:*, iva_think:*,
//   iva_update:*) и перехват ввода секрета, пока меню/мастер ждёт ключ.
// Всё остальное (текст, /new, /stop, /help, /usage, /task…, bot_started) уходит в канал агента
// (POST /eve/v1/max) — там allowlist, дедуп, sanitize и сам агент; второй пайплайн не создаётся.
import { tr } from "./i18n.mjs";

const idOf = (v) => (v === undefined || v === null ? "" : String(v));

/** Telegram-подобная форма сообщения для движков меню/мастера. chat.id == user_id (см. max-tg.mjs). */
export function toMsg(update) {
  const m = update?.message;
  const userId = idOf(m?.sender?.user_id);
  const rec = m?.recipient;
  if (!userId || rec?.chat_type !== "dialog" || m?.sender?.is_bot === true) return null;
  const text = typeof m?.body?.text === "string" ? m.body.text : "";
  return {
    message_id: idOf(m?.body?.mid),
    chat: { id: userId, type: "private" },
    from: { id: userId },
    text,
    _chatId: rec?.chat_id == null ? null : idOf(rec.chat_id),
  };
}

export function toCallback(update) {
  const cb = update?.callback;
  const userId = idOf(cb?.user?.user_id);
  if (!cb?.callback_id || !userId) return null;
  return {
    id: String(cb.callback_id),
    from: { id: userId },
    data: typeof cb.payload === "string" ? cb.payload : "",
    message: {
      message_id: idOf(update?.message?.body?.mid),
      chat: { id: userId, type: "private" },
    },
    _chatId: update?.message?.recipient?.chat_id == null ? null : idOf(update.message.recipient.chat_id),
  };
}

export const LOCAL_COMMANDS = new Set(["/menu", "/model", "/think", "/restart", "/update"]);

export function createMaxBridge({
  allowed,
  forward, // async (update) => void; бросает при неуспехе (мост повторит)
  tg,
  reply,
  menu,
  wizard,
  flows,
  handleUpdate: onUpdateCallback, // iva_update:* (кнопки обновления)
  handleUpdateCheck,
  restartAgent, // async (userId) => void
  rememberDialog = () => {},
  log = () => {},
}) {
  const isAllowed = (userId) => allowed.size > 0 && allowed.has(userId);

  async function handleCallback(update) {
    const cq = toCallback(update);
    if (!cq) return "ignored";
    if (cq._chatId) rememberDialog(cq.from.id, cq._chatId);
    if (!isAllowed(cq.from.id)) {
      await tg("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});
      return "denied";
    }
    const d = cq.data;
    const swallow = (label) => (e) => {
      log(`${label} error:`, e.message);
      return true;
    };
    if (d.startsWith("iva_update:")) await onUpdateCallback(cq).catch(swallow("update callback"));
    else if (d.startsWith("iva_model:") || d.startsWith("iva_think:")) await wizard.handleWizardCallback(cq).catch(swallow("wizard callback"));
    else if (d.startsWith("iva_menu:")) await menu.onCallback(cq).catch(swallow("menu callback"));
    else await tg("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});
    return "handled";
  }

  async function handleMessage(update) {
    const msg = toMsg(update);
    if (!msg) return "forward"; // не диалог/без отправителя: канал сам решит (и проигнорирует)
    if (!isAllowed(msg.from.id)) return "denied"; // чужим молчим, в агента не пускаем
    if (msg._chatId) rememberDialog(msg.from.id, msg._chatId);
    const text = msg.text.trim();

    // Ждущий ввод мастера/меню (ключ API и т.п.) забирает следующее сообщение пользователя —
    // секрет не должен попасть в агента. Команда снимает ожидание (как в Telegram-мосте).
    const pending = flows.get(msg.chat.id, msg.from.id);
    const a = pending?.awaitText;
    if (a) {
      if (text.startsWith("/")) {
        await flows.end(pending, tr("Cancelled — no longer waiting for input.", "Отменено — ожидание ввода снято.")).catch(() => {});
      } else if (text) {
        if (pending.flow === "menu") {
          await menu.onText(msg, pending).catch((e) => log("menu capture error:", e.message));
        } else {
          await wizard.handleKeyMessage(msg, pending).catch((e) => log("wizard key error:", e.message));
        }
        return "handled";
      } else if (a.secret || a.file) {
        // Вложение вместо секрета: удаляем и просим текстом, в агента не отдаём.
        await tg("deleteMessage", { chat_id: msg.chat.id, message_id: msg.message_id }).catch(() => {});
        await reply(msg.chat.id, tr("Send it as text, please.", "Пришли это, пожалуйста, текстом."));
        return "handled";
      }
    }

    if (!text.startsWith("/")) return "forward";
    const cmd = text.split(/\s+/, 1)[0].toLowerCase();
    if (!LOCAL_COMMANDS.has(cmd)) return "forward";
    const chat = msg.chat.id;
    const user = msg.from.id;
    if (cmd === "/menu") await menu.open(chat, user).catch((e) => log("menu error:", e.message));
    else if (cmd === "/model") await wizard.handleModelCmd(chat, user).catch((e) => log("wizard /model error:", e.message));
    else if (cmd === "/think") await wizard.handleThinkCmd(chat, user).catch((e) => log("wizard /think error:", e.message));
    else if (cmd === "/update") await handleUpdateCheck(chat).catch((e) => log("update check error:", e.message));
    else if (cmd === "/restart") await restartAgent(user).catch((e) => log("restart error:", e.message));
    return "handled";
  }

  /** Возвращает "handled" | "forwarded" | "denied" | "ignored". Бросает, только если forward не удался. */
  async function handleUpdate(update) {
    const type = update?.update_type;
    if (type === "message_callback") return handleCallback(update);
    if (type === "message_created") {
      const r = await handleMessage(update);
      if (r !== "forward") return r;
    } else if (type !== "bot_started") {
      return "ignored";
    }
    await forward(update);
    return "forwarded";
  }

  return { handleUpdate };
}
