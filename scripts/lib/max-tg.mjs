// Адаптер «Bot API Telegram → MAX» для переиспользования меню (/menu) и мастеров (/model, /think).
// Они общаются с мессенджером через tg(method, params) в формате Bot API Telegram и строят
// inline_keyboard из {text, callback_data}. Здесь те же вызовы переводятся в Bot API MAX:
//   sendMessage / editMessageText / editMessageReplyMarkup / deleteMessage / answerCallbackQuery.
// Идентификатор «чата» для движков — user_id владельца (положительный int64 строкой): так
// проверка «личный чат» (Number(chatId) > 0) остаётся верной, а ключ состояния не зависит от
// nullable Recipient.chat_id. Реальный chat_id диалога подставляется, если мост его знает.
import { MaxApiError } from "../../agent/lib/max-api.ts";

/** Telegram-style inline_keyboard -> MAX keyboard (ряды callback/link-кнопок). */
export function toMaxKeyboard(replyMarkup) {
  const rows = replyMarkup?.inline_keyboard;
  if (!Array.isArray(rows)) return undefined;
  return rows
    .map((row) =>
      row
        .map((b) => {
          const text = String(b.text ?? "").slice(0, 128) || "·";
          if (typeof b.url === "string") return { type: "link", text, url: b.url };
          if (typeof b.callback_data === "string") return { type: "callback", text, payload: b.callback_data.slice(0, 1024) };
          return null;
        })
        .filter(Boolean),
    )
    .filter((row) => row.length > 0);
}

const fail = (err) => ({
  ok: false,
  description: err instanceof MaxApiError ? `${err.message}${err.code ? ` (${err.code})` : ""}` : String(err?.message ?? err),
});

/**
 * @param client  MaxClient (agent/lib/max-api.ts)
 * @param opts.dialogChatId  (userId) => chat_id диалога или null (адресация по user_id)
 */
export function createMaxTg(client, { dialogChatId = () => null, log = () => {} } = {}) {
  const target = (chatId) => ({ chatId: dialogChatId(String(chatId)) ?? null, userId: String(chatId) });

  return async function tg(method, params = {}) {
    try {
      switch (method) {
        case "sendMessage": {
          const keyboard = toMaxKeyboard(params.reply_markup);
          const { mid } = await client.sendOnce(target(params.chat_id), String(params.text ?? ""), keyboard ? { keyboard } : {});
          return { ok: true, result: { message_id: mid, chat: { id: String(params.chat_id) } } };
        }
        case "editMessageText": {
          // Telegram: правка без reply_markup снимает клавиатуру — в MAX это пустой список вложений.
          const keyboard = toMaxKeyboard(params.reply_markup) ?? [];
          await client.editMessage(String(params.message_id), String(params.text ?? ""), { keyboard });
          return { ok: true, result: { message_id: params.message_id } };
        }
        case "editMessageReplyMarkup": {
          await client.editMessage(String(params.message_id), undefined, { keyboard: toMaxKeyboard(params.reply_markup) ?? [] });
          return { ok: true, result: true };
        }
        case "deleteMessage":
          await client.deleteMessage(String(params.message_id));
          return { ok: true, result: true };
        case "answerCallbackQuery": {
          // Синтетические id (например ivastop-…) у MAX не существуют — не дёргаем API.
          if (!params.callback_query_id || String(params.callback_query_id).startsWith("iva")) return { ok: true, result: true };
          await client.answerCallback(String(params.callback_query_id), params.text ? { notification: String(params.text) } : {});
          return { ok: true, result: true };
        }
        default:
          log(`max-tg: method not supported: ${method}`);
          return { ok: false, description: `unsupported method ${method}` };
      }
    } catch (err) {
      return fail(err);
    }
  };
}
