import { parseMaxJson } from "./max-updates.ts";

// Клиент MAX Bot API (схема: github.com/max-messenger/api-schema, schema.yaml).
// Токен — только в заголовке Authorization (без Bearer), никогда в URL и логах.
// Здесь одна попытка POST /messages; ретраи, очередь и лимит 2 сообщения/с — в max-outbox.ts.
// В схеме нет ключа идемпотентности для POST /messages, поэтому повтор после потерянного ответа
// (таймаут/обрыв) может создать дубль сообщения: доставка at-least-once, не exactly-once.

export const MAX_API_BASE = "https://platform-api2.max.ru";
export const MAX_TEXT_LIMIT = 4000;

export class MaxApiError extends Error {
  status: number | null;
  retryable: boolean;
  retryAfterMs?: number;
  code?: string;
  constructor(
    message: string,
    status: number | null,
    retryable: boolean,
    extra: { retryAfterMs?: number; code?: string } = {},
  ) {
    super(message);
    this.name = "MaxApiError";
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = extra.retryAfterMs;
    this.code = extra.code;
  }
}

/** Куда слать: chat_id диалога (если известен), иначе user_id (оба — int64 строкой). */
export interface MaxTarget {
  chatId: string | null;
  userId: string;
}

export interface MaxClientOptions {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type MaxFormat = "markdown" | "html";
/** Inline-клавиатура MAX: ряды callback/link-кнопок (payload ≤1024 символов, text ≤128). */
export type MaxButton =
  | { type: "callback"; text: string; payload: string }
  | { type: "link"; text: string; url: string };
export type MaxKeyboard = MaxButton[][];

export interface MaxSendOptions {
  format?: MaxFormat;
  keyboard?: MaxKeyboard;
}

export interface MaxUpdatesPage {
  updates: unknown[];
  marker: string | null;
}

export interface MaxClient {
  /** Одна попытка POST /messages. Возвращает mid созданного сообщения (если MAX его вернул). */
  sendOnce(target: MaxTarget, text: string, opts?: MaxSendOptions): Promise<{ mid: string | null }>;
  /** PUT /messages. keyboard: undefined — не менять, [] — убрать, ряды — заменить. */
  editMessage(mid: string, text: string, opts?: MaxSendOptions & { keyboard?: MaxKeyboard }): Promise<void>;
  deleteMessage(mid: string): Promise<void>;
  /** POST /answers — реакция на нажатие кнопки (всплывающее уведомление и/или правка сообщения). */
  answerCallback(
    callbackId: string,
    answer: { notification?: string; message?: { text: string; format?: MaxFormat; keyboard?: MaxKeyboard } },
  ): Promise<void>;
  /** GET /updates (long polling). marker — int64 строкой. */
  getUpdates(opts: { marker?: string | null; timeoutSec?: number; limit?: number; types?: string[]; signal?: AbortSignal }): Promise<MaxUpdatesPage>;
  getMe(): Promise<{ userId: string | null; username: string | null; isBot: boolean }>;
  /** PATCH /me/commands. */
  setCommands(commands: Array<{ name: string; description: string }>): Promise<void>;
  /** GET /subscriptions → список URL активных webhook-подписок. */
  getSubscriptions(): Promise<string[]>;
}

/** Базовый URL: только https; http допустим лишь для loopback (тестовые mock-серверы). */
export function resolveMaxBaseUrl(raw: string | undefined): string {
  if (!raw?.trim()) return MAX_API_BASE;
  const url = new URL(raw.trim());
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("MAX_API_BASE_URL must be https (http only for loopback)");
  }
  return url.toString().replace(/\/+$/, "");
}

/** Режет текст на куски ≤limit по границам абзацев/строк/слов (иначе жёстко). Пустой → []. */
export function splitMaxText(text: string, limit = MAX_TEXT_LIMIT): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    let cut = limit;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1; // не рвать суррогатную пару
    const window = rest.slice(0, cut);
    const idx = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" "));
    if (idx >= Math.floor(cut / 2)) cut = idx;
    const piece = rest.slice(0, cut).trim();
    if (piece) chunks.push(piece);
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function attachments(keyboard: MaxKeyboard | undefined) {
  if (keyboard === undefined) return undefined; // не менять
  if (keyboard.length === 0) return []; // убрать клавиатуру
  return [{ type: "inline_keyboard", payload: { buttons: keyboard } }];
}

export function createMaxClient(opts: MaxClientOptions): MaxClient {
  const base = (opts.baseUrl ?? MAX_API_BASE).replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  async function call(
    method: string,
    path: string,
    { query, body, timeout = timeoutMs, signal }: { query?: Record<string, string | undefined>; body?: unknown; timeout?: number; signal?: AbortSignal } = {},
  ): Promise<any> {
    const qs = Object.entries(query ?? {})
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
      .join("&");
    const timer = AbortSignal.timeout(timeout);
    let res: Response;
    try {
      res = await doFetch(`${base}${path}${qs ? `?${qs}` : ""}`, {
        method,
        headers: {
          authorization: opts.token,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: signal ? AbortSignal.any([timer, signal]) : timer,
      });
    } catch (err) {
      // Имя ошибки (TimeoutError/TypeError/AbortError) без сообщения: оно может содержать URL/детали.
      throw new MaxApiError(`MAX network error: ${(err as Error).name}`, null, true);
    }
    const text = await res.text().catch(() => "");
    if (res.ok) {
      if (!text) return null;
      try {
        return parseMaxJson(text);
      } catch {
        return null;
      }
    }
    let code: string | undefined;
    try {
      const parsed = JSON.parse(text.slice(0, 4096));
      if (typeof parsed?.code === "string") code = parsed.code.slice(0, 64);
    } catch {
      /* тело не JSON — не важно */
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    throw new MaxApiError(`MAX API HTTP ${res.status}`, res.status, res.status === 429 || res.status >= 500, {
      code,
      retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 120) * 1000 : undefined,
    });
  }

  const messageBody = (text: string, o?: MaxSendOptions) => ({
    text,
    ...(o?.format ? { format: o.format } : {}),
    ...(o?.keyboard !== undefined ? { attachments: attachments(o.keyboard) } : {}),
  });

  return {
    async sendOnce(target, text, o) {
      const query = target.chatId ? { chat_id: target.chatId } : { user_id: target.userId };
      const out = await call("POST", "/messages", { query, body: messageBody(text, o) });
      const mid = out?.message?.body?.mid;
      return { mid: typeof mid === "string" && mid ? mid : null };
    },
    async editMessage(mid, text, o) {
      await call("PUT", "/messages", { query: { message_id: mid }, body: messageBody(text, o) });
    },
    async deleteMessage(mid) {
      await call("DELETE", "/messages", { query: { message_id: mid } });
    },
    async answerCallback(callbackId, answer) {
      const body: Record<string, unknown> = {};
      if (answer.notification) body.notification = answer.notification;
      if (answer.message) body.message = messageBody(answer.message.text, answer.message);
      await call("POST", "/answers", { query: { callback_id: callbackId }, body });
    },
    async getUpdates({ marker, timeoutSec = 30, limit = 100, types, signal }) {
      const out = await call("GET", "/updates", {
        query: {
          limit: String(limit),
          timeout: String(timeoutSec),
          ...(marker ? { marker } : {}),
          ...(types?.length ? { types: types.join(",") } : {}),
        },
        timeout: (timeoutSec + 15) * 1000,
        signal,
      });
      const m = out?.marker;
      return {
        updates: Array.isArray(out?.updates) ? out.updates : [],
        marker: typeof m === "string" || typeof m === "number" ? String(m) : null,
      };
    },
    async getMe() {
      const out = await call("GET", "/me");
      const uid = out?.user_id;
      return {
        userId: typeof uid === "string" || typeof uid === "number" ? String(uid) : null,
        username: typeof out?.username === "string" ? out.username : null,
        isBot: out?.is_bot === true,
      };
    },
    async setCommands(commands) {
      await call("PATCH", "/me/commands", { body: { commands: commands.slice(0, 32) } });
    },
    async getSubscriptions() {
      const out = await call("GET", "/subscriptions");
      return Array.isArray(out?.subscriptions)
        ? out.subscriptions.map((s: any) => String(s?.url ?? "")).filter(Boolean)
        : [];
    },
  };
}
