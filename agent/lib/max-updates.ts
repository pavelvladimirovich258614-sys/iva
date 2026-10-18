// Разбор и проверка входящих событий MAX. Идентификаторы MAX — int64: JSON.parse теряет точность
// выше 2^53, поэтому большие числа в *_id полях квотируются ДО парсинга и живут как строки.

import { createHash, timingSafeEqual } from "node:crypto";

export const MAX_SECRET_HEADER = "x-max-bot-api-secret";
export const MAX_BODY_LIMIT = 256 * 1024;
export const MAX_BODY_TIMEOUT_MS = 10_000;

export interface MaxConfig {
  token: string;
  webhookSecret: string;
  allowedUserIds: ReadonlySet<string>;
}

/** MAX включён только при заданных токене и webhook-секрете. */
export function loadMaxConfig(env: Record<string, string | undefined> = process.env): MaxConfig | null {
  const token = env.MAX_BOT_TOKEN?.trim();
  const webhookSecret = env.MAX_WEBHOOK_SECRET?.trim();
  if (!token || !webhookSecret) return null;
  const allowedUserIds = new Set(
    (env.MAX_ALLOWED_USER_IDS ?? "")
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s)),
  );
  return { token, webhookSecret, allowedUserIds };
}

const digest = (v: string) => createHash("sha256").update(v).digest();

export function verifyMaxSecret(received: string | null, expected: string): boolean {
  if (!received || !expected) return false;
  return timingSafeEqual(digest(received), digest(expected));
}

const BIG_ID_RE = /("(?:user_id|chat_id|id|seq|marker|photo_id)"\s*:\s*)(-?\d{16,})(?=\s*[,}\]])/g;

export function parseMaxJson(raw: string): unknown {
  return JSON.parse(raw.replace(BIG_ID_RE, '$1"$2"'));
}

/** Вложение входящего сообщения в нормализованном виде (поля — из официальной схемы MAX). */
export interface MaxInboundAttachment {
  /** Тип по схеме: image | video | audio | file | sticker | contact | location | share | inline_keyboard | unknown. */
  type: string;
  /** Прямая ссылка payload.url (у video — не для скачивания: нужен GET /videos/{token}). */
  url: string | null;
  /** payload.token — идентификатор вложения (повторное использование / video details). */
  token: string | null;
  fileName: string | null;
  size: number | null;
  /** Для audio: расшифровка, если MAX её приложил (nullable по схеме). */
  transcription: string | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  photoId: string | null;
}

/** Ответ на сообщение / пересланное сообщение (Message.link). */
export interface MaxLinkedContent {
  type: string; // reply | forward
  senderId: string | null;
  text: string;
  attachments: MaxInboundAttachment[];
}

export type MaxEvent =
  | {
      kind: "message";
      dedupKey: string;
      userId: string;
      chatId: string | null;
      text: string;
      /** mid входящего сообщения (для связывания вложений с сообщением). */
      mid: string | null;
      attachments: MaxInboundAttachment[];
      linked: MaxLinkedContent | null;
    }
  | { kind: "bot_started"; dedupKey: string; userId: string; chatId: string }
  | { kind: "ignore"; reason: string };

const id = (v: unknown): string | null => {
  if (typeof v === "string" && /^-?\d+$/.test(v)) return v;
  if (typeof v === "number" && Number.isSafeInteger(v)) return String(v);
  return null;
};
const obj = (v: unknown): Record<string, any> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : null;

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
export const MAX_ATTACHMENTS_PER_MESSAGE = 20;

/** Разбор MessageBody.attachments: все необязательные поля могут отсутствовать или быть null. */
export function normalizeAttachments(input: unknown): MaxInboundAttachment[] {
  if (!Array.isArray(input)) return [];
  const out: MaxInboundAttachment[] = [];
  for (const raw of input.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)) {
    const a = obj(raw);
    if (!a) continue;
    const type = str(a.type) ?? "unknown";
    const payload = obj(a.payload);
    const thumbnail = obj(a.thumbnail);
    out.push({
      type,
      url: str(payload?.url),
      token: str(payload?.token),
      fileName: str(a.filename),
      size: num(a.size),
      transcription: str(a.transcription),
      duration: num(a.duration),
      width: num(a.width),
      height: num(a.height),
      photoId: id(payload?.photo_id),
    });
    void thumbnail;
  }
  return out;
}

/**
 * Нормализует Update по официальной схеме (api-schema schema.yaml).
 * message_created: Message.sender nullable (пост от имени канала), Recipient.chat_id/user_id
 * nullable, chat_type обязателен (dialog|chat|channel), MessageBody.text nullable.
 * Обрабатываем только dialog + человек + (текст | вложения | ответ/пересылка); chat_id необязателен — без него
 * ответ адресуется по user_id отправителя.
 */
export function normalizeMaxUpdate(input: unknown): MaxEvent {
  const u = obj(input);
  if (!u) return { kind: "ignore", reason: "not-object" };
  const ts = id(u.timestamp) ?? "0";

  if (u.update_type === "bot_started") {
    const user = obj(u.user);
    const userId = id(user?.user_id);
    const chatId = id(u.chat_id);
    if (!userId || !chatId) return { kind: "ignore", reason: "malformed" };
    if (user?.is_bot === true) return { kind: "ignore", reason: "bot" };
    return { kind: "bot_started", dedupKey: `started:${chatId}:${userId}:${ts}`, userId, chatId };
  }

  if (u.update_type === "message_created") {
    const m = obj(u.message);
    const sender = obj(m?.sender); // null для постов от имени канала
    const recipient = obj(m?.recipient);
    const body = obj(m?.body);
    if (!m || !recipient || !body) return { kind: "ignore", reason: "malformed" };
    if (recipient.chat_type !== "dialog") {
      // chat/channel — вне MVP; отсутствие/неизвестное значение — тоже fail-closed.
      return { kind: "ignore", reason: "not-private" };
    }
    const userId = id(sender?.user_id);
    if (!userId) return { kind: "ignore", reason: "no-sender" };
    if (sender?.is_bot === true) return { kind: "ignore", reason: "bot" };
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const attachments = normalizeAttachments(body.attachments).filter((a) => a.type !== "inline_keyboard");
    const link = obj(m.link);
    const linkBody = obj(link?.message);
    const linked: MaxLinkedContent | null = linkBody
      ? {
          type: str(link?.type) ?? "link",
          senderId: id(obj(link?.sender)?.user_id),
          text: typeof linkBody.text === "string" ? linkBody.text.trim() : "",
          attachments: normalizeAttachments(linkBody.attachments).filter((a) => a.type !== "inline_keyboard"),
        }
      : null;
    const hasLinked = !!linked && (linked.text.length > 0 || linked.attachments.length > 0);
    if (!text && attachments.length === 0 && !hasLinked) return { kind: "ignore", reason: "no-content" };
    const chatId = id(recipient.chat_id); // nullable по схеме
    const mid = typeof body.mid === "string" && body.mid ? body.mid : null;
    const dedupKey = mid ? `msg:${mid}` : `msg:${userId}:${ts}:${id(body.seq) ?? ""}`;
    return { kind: "message", dedupKey, userId, chatId, text, mid, attachments, linked: hasLinked ? linked : null };
  }
  return { kind: "ignore", reason: `type:${String(u.update_type)}` };
}
