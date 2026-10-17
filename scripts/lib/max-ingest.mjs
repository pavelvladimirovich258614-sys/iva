// Два способа получить Update от MAX — long polling и webhook — сходятся в одну функцию
// process(update) (scripts/lib/max-bridge-core.mjs). Здесь только транспорт и его гарантии:
//
//   polling : маркер двигается лишь после того, как КАЖДОЕ событие страницы получило статус ok/error;
//             на "retry" событие повторяется с backoff, маркер стоит на месте.
//   webhook : 200 — только при ok/error (событие потреблено); 503 — при "retry", и MAX доставит заново.
//             Секрет X-Max-Bot-Api-Secret проверяется до чтения тела; тело читается потоком с лимитом.
//
// Одновременно работает ровно один транспорт: блокировка data/max/transport.lock (на хост) и
// проверка подписки MAX (polling не стартует при активном webhook).
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { readBodyLimited } from "../../agent/lib/max-body.ts";
import { MAX_BODY_LIMIT, MAX_BODY_TIMEOUT_MS, MAX_SECRET_HEADER, parseMaxJson, verifyMaxSecret } from "../../agent/lib/max-updates.ts";

export const EX_CONFIG = 78; // systemd: RestartPreventExitStatus=78 — конфликт конфигурации не лечится перезапуском

export class TransportConflict extends Error {
  constructor(message) {
    super(message);
    this.name = "TransportConflict";
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

/** Исключительная блокировка транспорта. Возвращает release(). Бросает TransportConflict. */
export function acquireTransportLock(dir, mode, { pid = process.pid, isAlive = alive } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "transport.lock");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, JSON.stringify({ pid, mode, startedAt: new Date().toISOString() }));
      closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          if (JSON.parse(readFileSync(file, "utf8")).pid === pid) rmSync(file, { force: true });
        } catch {
          /* уже нет */
        }
      };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    let holder = null;
    try {
      holder = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      /* битый/исчезнувший файл — считаем протухшим */
    }
    if (holder && holder.pid !== pid && isAlive(holder.pid)) {
      throw new TransportConflict(
        `another MAX transport is already running (mode=${holder.mode}, pid=${holder.pid}); only one of polling / webhook may receive events`,
      );
    }
    rmSync(file, { force: true });
  }
  throw new TransportConflict("could not acquire the MAX transport lock");
}

/**
 * Проверка до старта транспорта по состоянию подписки MAX.
 * poll + активная подписка → конфликт (события идут на webhook, polling ничего не получит).
 */
export async function checkSubscriptionForMode(client, mode, { webhookUrl = "" } = {}) {
  let subs;
  try {
    subs = await client.getSubscriptions();
  } catch (e) {
    return { ok: true, warning: `could not read subscriptions (${e.message}) — continuing` };
  }
  if (mode === "poll" && subs.length > 0) {
    throw new TransportConflict(
      `a webhook subscription is active (${subs.join(", ")}) — MAX delivers events there, not to polling. ` +
        "Switch properly: `iva max webhook off` (then polling) or set MAX_INGEST=webhook",
    );
  }
  if (mode === "webhook") {
    if (subs.length === 0) return { ok: true, warning: "no webhook subscription is registered at MAX yet — run: iva max webhook set <https-url>" };
    if (webhookUrl && !subs.includes(webhookUrl)) {
      return { ok: true, warning: `MAX_WEBHOOK_URL (${webhookUrl}) is not among the registered subscriptions (${subs.join(", ")})` };
    }
  }
  return { ok: true };
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Цикл long polling. markerStore: { load(): Promise<string|null>, save(m): Promise<void> }.
 * Возвращается, когда signal.aborted.
 */
export async function runPolling({ client, process: processUpdate, markerStore, types, signal, log = () => {}, sleep = defaultSleep, timeoutSec = 30 }) {
  let marker = await markerStore.load();
  log(`polling started, marker: ${marker ?? "(none)"}`);
  let failures = 0;
  while (!signal.aborted) {
    let page;
    try {
      page = await client.getUpdates({ marker, timeoutSec, limit: 100, types, signal });
      failures = 0;
    } catch (e) {
      if (signal.aborted) break;
      failures += 1;
      const wait = Math.min(30, 2 ** Math.min(failures, 5));
      log(`getUpdates failed (${e.message}); retry in ${wait}s`);
      await sleep(wait * 1000);
      continue;
    }
    for (const update of page.updates) {
      for (let attempt = 1; !signal.aborted; attempt++) {
        const r = await processUpdate(update);
        if (r.status !== "retry") {
          if (r.status === "error") log(`update consumed with an error (${r.action ?? "?"})`);
          break;
        }
        log(`update not processed (${r.reason}); attempt ${attempt}, marker stays`);
        await sleep(Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)));
      }
      if (signal.aborted) return; // не двигаем маркер: событие не обработано
    }
    if (page.marker && page.marker !== marker) {
      try {
        await markerStore.save(page.marker);
        marker = page.marker;
      } catch (e) {
        // Маркер всё равно уйдёт MAX со следующим запросом; запись нужна только для рестарта.
        marker = page.marker;
        log(`cannot save the marker: ${e.message}`);
      }
    }
  }
}

/**
 * Webhook-приёмник. Слушает только то, что передано в host (по умолчанию loopback);
 * наружу его публикует reverse proxy, ограничившись путём `path`.
 */
export function createWebhookServer({ secret, process: processUpdate, log = () => {}, path = "/max/webhook", mode = "webhook" }) {
  return createServer(async (req, res) => {
    const reply = (code, text = "", headers = {}) => {
      res.writeHead(code, { "content-type": "text/plain; charset=utf-8", ...headers });
      res.end(text);
    };
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (req.method === "GET" && url.pathname === "/healthz") return reply(200, JSON.stringify({ ok: true, mode }), { "content-type": "application/json" });
      if (url.pathname !== path) return reply(404, "not found");
      if (req.method !== "POST") return reply(405, "method not allowed", { allow: "POST" });
      // Секрет — до чтения тела и до любой обработки.
      const received = req.headers[MAX_SECRET_HEADER];
      if (!verifyMaxSecret(Array.isArray(received) ? received[0] : (received ?? null), secret)) return reply(401, "unauthorized");

      const request = new Request("http://local/", {
        method: "POST",
        headers: { ...(req.headers["content-length"] ? { "content-length": String(req.headers["content-length"]) } : {}) },
        body: Readable.toWeb(req),
        duplex: "half",
      });
      const body = await readBodyLimited(request, { maxBytes: MAX_BODY_LIMIT, timeoutMs: MAX_BODY_TIMEOUT_MS });
      if (!body.ok) {
        log(`webhook body rejected: ${body.reason}`);
        // Тело недочитано: честно закрываем соединение, чтобы клиент не переиспользовал «мёртвый» сокет.
        return reply(body.status, body.reason, { connection: "close" });
      }
      let update;
      try {
        update = parseMaxJson(body.text);
      } catch {
        return reply(400, "invalid JSON");
      }
      if (!update || typeof update !== "object" || Array.isArray(update)) return reply(200, "ok");

      const r = await processUpdate(update);
      if (r.status === "retry") {
        log(`update not processed (${r.reason}); asking MAX to redeliver`);
        return reply(503, "retry", { "retry-after": "5" });
      }
      return reply(200, "ok");
    } catch (e) {
      log(`webhook handler failure: ${e.message}`);
      if (!res.headersSent) reply(500, "error");
    }
  });
}
