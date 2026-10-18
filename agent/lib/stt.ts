// Распознавание речи (STT) для голосовых и аудио из любого мессенджера. Не зависит от Telegram.
// Провайдер: Deepgram (тот же ключ DEEPGRAM_API_KEY, что и у Telegram-канала Ивы). Настройки:
//   DEEPGRAM_API_KEY        — ключ (без него STT не настроен, и это сообщается явно, без выдуманной расшифровки);
//   DEEPGRAM_LANGUAGE       — язык ("multi" по умолчанию, для русской речи надёжнее "ru");
//   DEEPGRAM_BASE_URL       — переопределение адреса API (https; http только loopback — тесты);
//   MAX_STT_MAX_BYTES       — предел размера аудио для отправки на распознавание (по умолчанию 25 МиБ).
// Ключ уходит только в заголовок Authorization и никогда не попадает в тексты ошибок.

import { readFileSync, statSync } from "node:fs";

export type SttErrorCode = "not-configured" | "too-large" | "http" | "network" | "invalid-response";

export class SttError extends Error {
  code: SttErrorCode;
  status: number | null;
  constructor(code: SttErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "SttError";
    this.code = code;
    this.status = status;
  }
}

export interface Transcript {
  text: string;
  /** Речи в записи нет (тишина/шум): text пустой, это НЕ ошибка провайдера. */
  noSpeech: boolean;
  provider: string;
}

export function sttConfigured(env: Record<string, string | undefined> = process.env) {
  return Boolean(env.DEEPGRAM_API_KEY?.trim());
}

function baseUrl(env: Record<string, string | undefined>) {
  const raw = env.DEEPGRAM_BASE_URL?.trim();
  if (!raw) return "https://api.deepgram.com";
  const u = new URL(raw);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) throw new SttError("not-configured", "DEEPGRAM_BASE_URL must be https (http only for loopback)");
  return u.toString().replace(/\/+$/, "");
}

export async function transcribeFile(
  path: string,
  { mimeType, env = process.env, fetchImpl = fetch, timeoutMs = 90_000 }: { mimeType?: string; env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<Transcript> {
  const key = env.DEEPGRAM_API_KEY?.trim();
  if (!key) throw new SttError("not-configured", "speech recognition is not configured (set DEEPGRAM_API_KEY)");
  const limit = Number(env.MAX_STT_MAX_BYTES) > 0 ? Number(env.MAX_STT_MAX_BYTES) : 25 * 1024 * 1024;
  if (statSync(path).size > limit) throw new SttError("too-large", `the audio is larger than the speech-recognition limit (${limit} bytes)`);
  const language = env.DEEPGRAM_LANGUAGE?.trim() || "multi";
  const url = `${baseUrl(env)}/v1/listen?model=nova-3&language=${encodeURIComponent(language)}&punctuate=true&smart_format=true`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Token ${key}`, "Content-Type": mimeType || "application/octet-stream" },
      body: readFileSync(path),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new SttError("network", `speech recognition request failed (${(err as Error).name})`);
  }
  if (!res.ok) {
    await res.text().catch(() => "");
    throw new SttError("http", `speech recognition failed: HTTP ${res.status}`, res.status);
  }
  let json: any;
  try {
    json = await res.json();
  } catch {
    throw new SttError("invalid-response", "speech recognition returned an unreadable response");
  }
  const alt = json?.results?.channels?.[0]?.alternatives?.[0];
  if (!alt || typeof alt.transcript !== "string") throw new SttError("invalid-response", "speech recognition response has no transcript field");
  const text = alt.transcript.trim();
  return { text, noSpeech: text.length === 0, provider: "deepgram" };
}
