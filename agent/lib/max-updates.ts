// Разбор и проверка входящих событий MAX. Идентификаторы MAX — int64: JSON.parse теряет точность
// выше 2^53, поэтому большие числа в *_id полях квотируются ДО парсинга и живут как строки.

import { createHash, timingSafeEqual } from "node:crypto";

export const MAX_SECRET_HEADER = "x-max-bot-api-secret";
export const MAX_BODY_LIMIT = 256 * 1024;

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

const BIG_ID_RE = /("(?:user_id|chat_id|id|chat)"\s*:\s*)(-?\d{16,})(?=\s*[,}\]])/g;

export function parseMaxJson(raw: string): unknown {
  return JSON.parse(raw.replace(BIG_ID_RE, '$1"$2"'));
}

export type MaxEvent =
  | { kind: "message"; dedupKey: string; userId: string; chatId: string; text: string }
  | { kind: "bot_started"; dedupKey: string; userId: string; chatId: string }
  | { kind: "ignore"; reason: string };

const id = (v: unknown): string | null => {
  if (typeof v === "string" && /^-?\d+$/.test(v)) return v;
  if (typeof v === "number" && Number.isSafeInteger(v)) return String(v);
  return null;
};
const obj = (v: unknown): Record<string, any> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : null;

/** Нормализует Update. Только личные текстовые сообщения от людей и bot_started. */
export function normalizeMaxUpdate(input: unknown): MaxEvent {
  const u = obj(input);
  if (!u) return { kind: "ignore", reason: "not-object" };
  const ts = id(u.timestamp) ?? "0";

  if (u.update_type === "bot_started") {
    const userId = id(obj(u.user)?.user_id);
    const chatId = id(u.chat_id);
    if (!userId || !chatId) return { kind: "ignore", reason: "malformed" };
    if (obj(u.user)?.is_bot === true) return { kind: "ignore", reason: "bot" };
    return { kind: "bot_started", dedupKey: `started:${chatId}:${userId}:${ts}`, userId, chatId };
  }

  if (u.update_type === "message_created") {
    const m = obj(u.message);
    const sender = obj(m?.sender);
    const recipient = obj(m?.recipient);
    const userId = id(sender?.user_id);
    const chatId = id(recipient?.chat_id);
    if (!m || !userId || !chatId) return { kind: "ignore", reason: "malformed" };
    if (sender?.is_bot === true) return { kind: "ignore", reason: "bot" };
    if (recipient?.chat_type !== undefined && recipient.chat_type !== "dialog") {
      return { kind: "ignore", reason: "not-private" };
    }
    // chat_type отсутствует → fail-closed: не считаем диалог личным.
    if (recipient?.chat_type === undefined) return { kind: "ignore", reason: "not-private" };
    const text = typeof obj(m.body)?.text === "string" ? (m.body.text as string).trim() : "";
    if (!text) return { kind: "ignore", reason: "no-text" };
    const mid = typeof obj(m.body)?.mid === "string" ? m.body.mid : `${chatId}:${userId}:${ts}`;
    return { kind: "message", dedupKey: `msg:${mid}`, userId, chatId, text };
  }
  return { kind: "ignore", reason: `type:${String(u.update_type)}` };
}

/** Ограниченный по размеру и TTL журнал уже принятых событий (защита от повторной доставки). */
export function createDedup(ttlMs = 60 * 60_000, max = 5000, now: () => number = Date.now) {
  const seen = new Map<string, number>();
  const prune = () => {
    const t = now();
    for (const [k, at] of seen) {
      if (t - at > ttlMs || seen.size > max) seen.delete(k);
      else break; // Map хранит порядок вставки
    }
  };
  return {
    /** true — событие новое и теперь помечено. */
    claim(key: string): boolean {
      prune();
      if (seen.has(key)) return false;
      seen.set(key, now());
      return true;
    },
    release(key: string) {
      seen.delete(key);
    },
  };
}
