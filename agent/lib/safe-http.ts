// Защищённый HTTP для вложений MAX: скачивание входящих файлов и загрузка исходящих.
//
// Ссылки на вложения приходят извне (из событий MAX), поэтому они считаются недоверенными:
//   • только https (http — лишь по явному allowHttp, нужно для mock-сервера в тестах);
//   • имя хоста резолвится нашим lookup, и соединение устанавливается ТОЛЬКО с публичным адресом —
//     проверка выполняется в момент подключения, поэтому DNS rebinding между «проверкой» и
//     «запросом» невозможен; IP-литералы в URL проверяются до запроса;
//   • каждый редирект проходит ту же проверку заново (не больше maxRedirects);
//   • необязательный список разрешённых суффиксов хостов (MAX_MEDIA_HOSTS);
//   • тело читается потоком прямо в файл с жёстким лимитом размера и общим таймаутом;
//   • токен бота и заголовок Authorization на медиа-хосты не отправляются никогда.
// Тело ответа не логируется, URL в сообщения об ошибках не попадают (в нём могут быть секреты).

import { createWriteStream, createReadStream, mkdirSync, rmSync, statSync } from "node:fs";
import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

export type MediaFetchErrorCode =
  | "bad-url"
  | "bad-scheme"
  | "host-not-allowed"
  | "ssrf-blocked"
  | "too-many-redirects"
  | "too-large"
  | "timeout"
  | "http-error"
  | "network";

export class MediaFetchError extends Error {
  code: MediaFetchErrorCode;
  status: number | null;
  constructor(code: MediaFetchErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "MediaFetchError";
    this.code = code;
    this.status = status;
  }
  /** Временная ошибка: имеет смысл повторить позже (истёкшая ссылка — 403/404/410 — не такая). */
  get retryable() {
    return this.code === "timeout" || this.code === "network" || (this.code === "http-error" && (this.status === 429 || (this.status ?? 0) >= 500));
  }
}

export interface FetchPolicy {
  /** Разрешить http (только тесты / loopback mock). */
  allowHttp?: boolean;
  /** Разрешить ТОЛЬКО loopback (127.0.0.0/8, ::1): mock-сервер тестов. Остальные приватные сети закрыты всегда. */
  allowLoopback?: boolean;
  /** Если задан — хост обязан оканчиваться на один из суффиксов (".okcdn.ru" или "i.oneme.ru"). */
  allowedHostSuffixes?: readonly string[];
  maxRedirects?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const V4_BLOCKS: Array<[number, number]> = [
  // [сеть как uint32, длина префикса]
  [0x00000000, 8], // 0.0.0.0/8
  [0x0a000000, 8], // 10/8
  [0x64400000, 10], // 100.64/10 CGNAT
  [0x7f000000, 8], // loopback
  [0xa9fe0000, 16], // link-local, в том числе 169.254.169.254 (метаданные облаков)
  [0xac100000, 12], // 172.16/12
  [0xc0000000, 24], // 192.0.0/24
  [0xc0000200, 24], // TEST-NET-1
  [0xc0a80000, 16], // 192.168/16
  [0xc6120000, 15], // 198.18/15 benchmark
  [0xc6336400, 24], // TEST-NET-2
  [0xcb007100, 24], // TEST-NET-3
  [0xe0000000, 4], // multicast
  [0xf0000000, 4], // reserved + broadcast
];

function v4ToInt(ip: string): number | null {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  let n = 0;
  for (const part of p) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** true только для адреса, до которого безопасно ходить по ссылке из недоверенного источника. */
export function isPublicAddress(ip: string): boolean {
  let addr = ip.trim().toLowerCase();
  if (addr.startsWith("[") && addr.endsWith("]")) addr = addr.slice(1, -1);
  const zone = addr.indexOf("%");
  if (zone >= 0) addr = addr.slice(0, zone);
  const kind = isIP(addr);
  if (kind === 4) {
    const n = v4ToInt(addr);
    if (n === null) return false;
    return !V4_BLOCKS.some(([net, len]) => {
      const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
      return ((n & mask) >>> 0) === net;
    });
  }
  if (kind === 6) {
    // IPv4-mapped / IPv4-compatible (::ffff:a.b.c.d, ::a.b.c.d) → проверяем вложенный v4.
    const mapped = /^(?:0{0,4}:){0,5}(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
    if (mapped) return isPublicAddress(mapped[1]!);
    const mappedHex = /^(?:0{0,4}:){0,5}ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(addr);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1]!, 16);
      const lo = parseInt(mappedHex[2]!, 16);
      return isPublicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    if (addr === "::" || addr === "::1") return false;
    const first = parseInt(addr.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return false; // ULA fc00::/7
    if ((first & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
    if ((first & 0xffc0) === 0xfec0) return false; // site-local (устар.)
    if ((first & 0xff00) === 0xff00) return false; // multicast
    if (first === 0x2001 && /^2001:0?db8:/.test(addr)) return false; // документация
    if (first === 0x64 && addr.startsWith("64:ff9b:")) return false; // NAT64 — не доверяем
    return true;
  }
  return false;
}

function isLoopback(ip: string) {
  const a = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return a === "::1" || /^127\.\d+\.\d+\.\d+$/.test(a) || a === "::ffff:127.0.0.1";
}

function addressAllowed(ip: string, policy: FetchPolicy) {
  return isPublicAddress(ip) || (policy.allowLoopback === true && isLoopback(ip));
}

function hostAllowed(host: string, suffixes: readonly string[] | undefined) {
  if (!suffixes || suffixes.length === 0) return true;
  const h = host.toLowerCase().replace(/\.$/, "");
  return suffixes.some((s) => {
    const x = s.toLowerCase().replace(/^\*?\.?/, "");
    return h === x || h.endsWith(`.${x}`);
  });
}

/** Разбор и проверка URL до сетевого вызова. Бросает MediaFetchError без самого URL в тексте. */
export function checkMediaUrl(raw: string, policy: FetchPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MediaFetchError("bad-url", "attachment URL is not a valid URL");
  }
  if (url.username || url.password) throw new MediaFetchError("bad-url", "attachment URL must not contain credentials");
  if (url.protocol !== "https:" && !(policy.allowHttp && url.protocol === "http:")) {
    throw new MediaFetchError("bad-scheme", "attachment URL must use https");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!hostAllowed(host, policy.allowedHostSuffixes)) {
    throw new MediaFetchError("host-not-allowed", "attachment host is not in MAX_MEDIA_HOSTS");
  }
  if (isIP(host) && !addressAllowed(host, policy)) {
    throw new MediaFetchError("ssrf-blocked", "attachment URL points to a non-public address");
  }
  return url;
}

/** lookup, который отказывает, если хоть один из адресов не публичный (проверка в момент соединения). */
function guardedLookup(policy: FetchPolicy) {
  return (hostname: string, options: any, cb: (err: Error | null, address?: any, family?: number) => void) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
      if (err) return cb(err);
      const list = addrs as Array<{ address: string; family: number }>;
      if (list.some((a) => !addressAllowed(a.address, policy))) {
        return cb(new MediaFetchError("ssrf-blocked", "attachment host resolves to a non-public address"));
      }
      const pick = list[0];
      if (!pick) return cb(new Error("no address"));
      if (options?.all) return cb(null, list);
      cb(null, pick.address, pick.family);
    });
  };
}

function requestOnce(
  url: URL,
  init: { method: "GET" | "POST"; headers?: Record<string, string> },
  policy: FetchPolicy,
  timeoutMs: number,
  writeBody?: (req: http.ClientRequest) => Promise<void>,
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    policy.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ac.abort(new MediaFetchError("timeout", "attachment transfer timed out")), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      policy.signal?.removeEventListener("abort", onAbort);
    };
    const req = lib.request(
      url,
      {
        method: init.method,
        headers: init.headers,
        lookup: guardedLookup(policy) as any,
        signal: ac.signal,
        agent: false,
      },
      (res) => {
        res.once("close", cleanup);
        resolve(res);
      },
    );
    req.once("error", (err) => {
      cleanup();
      const reason = (ac.signal.reason ?? null) as unknown;
      if (reason instanceof MediaFetchError) return reject(reason);
      if (err instanceof MediaFetchError) return reject(err);
      if ((err as any)?.cause instanceof MediaFetchError) return reject((err as any).cause);
      if (ac.signal.aborted) return reject(new MediaFetchError("timeout", "attachment transfer was cancelled"));
      reject(new MediaFetchError("network", `attachment transfer failed (${(err as NodeJS.ErrnoException).code ?? (err as Error).name})`));
    });
    if (writeBody) writeBody(req).catch((e) => req.destroy(e));
    else req.end();
  });
}

/**
 * Скачивает URL в файл потоком. Размер ограничен maxBytes (проверка и по Content-Length, и по факту).
 * Возвращает число байт и Content-Type, заявленный сервером (доверять ему нельзя — тип определяется по содержимому).
 */
export async function downloadToFile(
  rawUrl: string,
  dest: string,
  { maxBytes, ...policy }: FetchPolicy & { maxBytes: number },
): Promise<{ bytes: number; contentType: string | null }> {
  const timeoutMs = policy.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  let url = checkMediaUrl(rawUrl, policy);
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  const maxRedirects = policy.maxRedirects ?? 3;
  for (let hop = 0; ; hop++) {
    const res = await requestOnce(url, { method: "GET", headers: { accept: "*/*", "accept-encoding": "identity" } }, policy, Math.max(1000, deadline - Date.now()));
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      if (hop >= maxRedirects) throw new MediaFetchError("too-many-redirects", "attachment URL redirects too many times");
      url = checkMediaUrl(new URL(res.headers.location, url).toString(), policy);
      continue;
    }
    if (status < 200 || status >= 300) {
      res.resume();
      throw new MediaFetchError("http-error", `attachment download failed: HTTP ${status}`, status);
    }
    const declared = Number(res.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      res.destroy();
      throw new MediaFetchError("too-large", `attachment is larger than the limit (${maxBytes} bytes)`);
    }
    let bytes = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        bytes += chunk.length;
        if (bytes > maxBytes) return cb(new MediaFetchError("too-large", `attachment is larger than the limit (${maxBytes} bytes)`));
        cb(null, chunk);
      },
    });
    try {
      await pipeline(res, counter, createWriteStream(dest, { mode: 0o600 }));
    } catch (err) {
      rmSync(dest, { force: true });
      if (err instanceof MediaFetchError) throw err;
      throw new MediaFetchError(res.destroyed && Date.now() >= deadline ? "timeout" : "network", "attachment download was interrupted");
    }
    const ct = res.headers["content-type"];
    return { bytes, contentType: typeof ct === "string" ? ct.split(";")[0]!.trim().toLowerCase() : null };
  }
}

/** multipart/form-data с одним файловым полем; файл стримится с диска, в память не читается. */
export async function uploadFileMultipart(
  rawUrl: string,
  filePath: string,
  { fieldName = "data", fileName, mimeType = "application/octet-stream", ...policy }: FetchPolicy & { fieldName?: string; fileName: string; mimeType?: string },
): Promise<{ status: number; body: string }> {
  const url = checkMediaUrl(rawUrl, policy);
  const size = statSync(filePath).size;
  const boundary = `----iva${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const safeName = fileName.replace(/[\r\n"\\]/g, "_");
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${safeName}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const res = await requestOnce(
    url,
    {
      method: "POST",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": String(head.length + size + tail.length),
      },
    },
    policy,
    policy.timeoutMs ?? 5 * 60_000,
    async (req) => {
      req.write(head);
      await pipeline(createReadStream(filePath), req, { end: false });
      req.end(tail);
    },
  );
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of res) {
    total += (c as Buffer).length;
    if (total > 64 * 1024) {
      res.destroy();
      break;
    }
    chunks.push(c as Buffer);
  }
  return { status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") };
}
