// Минимальный клиент MAX Bot API (https://platform-api2.max.ru). Токен — только в заголовке
// Authorization (не в URL, не в логах). Ошибки сети/429/5xx ретраятся с backoff, ответы режутся
// по лимиту длины сообщения.

export const MAX_API_BASE = "https://platform-api2.max.ru";
export const MAX_TEXT_LIMIT = 4000;

export class MaxApiError extends Error {
  status: number | null;
  retryable: boolean;
  retryAfterMs?: number;
  constructor(message: string, status: number | null, retryable: boolean, retryAfterMs?: number) {
    super(message);
    this.name = "MaxApiError";
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface MaxClientOptions {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Мин. пауза между сообщениями в один диалог (лимит MAX — 2 сообщения/сек). */
  minIntervalMs?: number;
}

export interface MaxClient {
  sendText(target: { chatId: string }, text: string): Promise<void>;
}

/** Режет текст на куски ≤limit по границам абзацев/строк/слов (иначе жёстко, по кодпоинтам). */
export function splitMaxText(text: string, limit = MAX_TEXT_LIMIT): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    let cut = limit;
    // не рвать суррогатную пару
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    const window = rest.slice(0, cut);
    const floor = Math.floor(cut / 2);
    const idx = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" "));
    if (idx >= floor) cut = idx;
    const piece = rest.slice(0, cut).trim();
    if (piece) chunks.push(piece);
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createMaxClient(opts: MaxClientOptions): MaxClient {
  const base = (opts.baseUrl ?? MAX_API_BASE).replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxAttempts = opts.maxAttempts ?? 4;
  const minInterval = opts.minIntervalMs ?? 550;
  const lastSent = new Map<string, number>();

  async function postOnce(chatId: string, text: string): Promise<void> {
    const url = `${base}/messages?chat_id=${encodeURIComponent(chatId)}`;
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { authorization: opts.token, "content-type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Текст ошибки сети не содержит токена (он только в заголовке), но на всякий случай глушим.
      throw new MaxApiError(`MAX network error: ${(err as Error).name}`, null, true);
    }
    if (res.ok) return;
    const retryable = res.status === 429 || res.status >= 500;
    const retryAfter = Number(res.headers.get("retry-after"));
    throw new MaxApiError(
      `MAX API HTTP ${res.status}`,
      res.status,
      retryable,
      Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : undefined,
    );
  }

  return {
    async sendText({ chatId }, text) {
      for (const chunk of splitMaxText(text)) {
        const wait = (lastSent.get(chatId) ?? 0) + minInterval - Date.now();
        if (wait > 0) await sleep(wait);
        for (let attempt = 1; ; attempt++) {
          try {
            await postOnce(chatId, chunk);
            break;
          } catch (err) {
            if (!(err instanceof MaxApiError) || !err.retryable || attempt >= maxAttempts) throw err;
            await sleep(err.retryAfterMs ?? Math.min(500 * 2 ** (attempt - 1), 8000));
          }
        }
        lastSent.set(chatId, Date.now());
      }
    },
  };
}
