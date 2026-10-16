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

export interface MaxClient {
  sendOnce(target: MaxTarget, text: string): Promise<void>;
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

export function createMaxClient(opts: MaxClientOptions): MaxClient {
  const base = (opts.baseUrl ?? MAX_API_BASE).replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  return {
    async sendOnce(target, text) {
      const query = target.chatId
        ? `chat_id=${encodeURIComponent(target.chatId)}`
        : `user_id=${encodeURIComponent(target.userId)}`;
      let res: Response;
      try {
        res = await doFetch(`${base}/messages?${query}`, {
          method: "POST",
          headers: { authorization: opts.token, "content-type": "application/json" },
          body: JSON.stringify({ text }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        // Имя ошибки (TimeoutError/TypeError) без сообщения: оно может содержать URL/детали.
        throw new MaxApiError(`MAX network error: ${(err as Error).name}`, null, true);
      }
      if (res.ok) {
        await res.body?.cancel().catch(() => {});
        return;
      }
      let code: string | undefined;
      try {
        const body = JSON.parse((await res.text()).slice(0, 4096));
        if (typeof body?.code === "string") code = body.code.slice(0, 64);
      } catch {
        /* тело не JSON — не важно */
      }
      const retryAfter = Number(res.headers.get("retry-after"));
      throw new MaxApiError(`MAX API HTTP ${res.status}`, res.status, res.status === 429 || res.status >= 500, {
        code,
        retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 120) * 1000 : undefined,
      });
    },
  };
}
