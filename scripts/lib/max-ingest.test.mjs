import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TransportConflict,
  acquireTransportLock,
  checkSubscriptionForMode,
  createWebhookServer,
  runPolling,
} from "./max-ingest.mjs";

const SECRET = "wh-secret_123";
const tmp = () => mkdtempSync(join(tmpdir(), "max-ingest-"));

// ---- polling ----------------------------------------------------------------------------
function pollRig({ pages, results }) {
  const queue = [...pages];
  const calls = [];
  const saved = [];
  const ac = new AbortController();
  const client = {
    getUpdates: async (o) => {
      calls.push(o.marker);
      const next = queue.shift();
      if (!next) { ac.abort(); return { updates: [], marker: o.marker }; }
      if (next instanceof Error) throw next;
      return next;
    },
  };
  const processed = [];
  const process = async (u) => { processed.push(u.id); return (results[u.id]?.shift() ?? { status: "ok", action: "handled" }); };
  const markerStore = { load: async () => "10", save: async (m) => void saved.push(m) };
  return { client, process, markerStore, calls, saved, processed, ac, run: () => runPolling({ client, process, markerStore, types: ["message_created"], signal: ac.signal, sleep: async () => {}, log: () => {} }) };
}

test("polling: the marker moves only after every update of the page is ok/error; 'retry' repeats the same update", async () => {
  const r = pollRig({
    pages: [{ updates: [{ id: "a" }, { id: "b" }], marker: "12" }],
    results: { b: [{ status: "retry", reason: "agent-unavailable" }, { status: "retry", reason: "agent-unavailable" }, { status: "ok" }] },
  });
  await r.run();
  assert.deepEqual(r.processed, ["a", "b", "b", "b"]);
  assert.deepEqual(r.saved, ["12"]);
  assert.equal(r.calls[0], "10"); // начали с сохранённого маркера
  assert.equal(r.calls[1], "12"); // и передали новый только после обработки
});

test("polling: an update consumed with an error (user notified) does not block the queue", async () => {
  const r = pollRig({ pages: [{ updates: [{ id: "x" }, { id: "y" }], marker: "20" }], results: { x: [{ status: "error", action: "handled" }] } });
  await r.run();
  assert.deepEqual(r.processed, ["x", "y"]);
  assert.deepEqual(r.saved, ["20"]);
});

test("polling: shutdown while an update is still failing keeps the old marker (no loss)", async () => {
  const r = pollRig({ pages: [{ updates: [{ id: "z" }], marker: "30" }], results: { z: Array(50).fill({ status: "retry", reason: "r" }) } });
  const orig = r.process;
  let n = 0;
  const process = async (u) => { if (++n === 3) r.ac.abort(); return orig(u); };
  await runPolling({ client: r.client, process, markerStore: r.markerStore, types: [], signal: r.ac.signal, sleep: async () => {}, log: () => {} });
  assert.deepEqual(r.saved, []);
});

test("polling: API errors back off and continue; marker-save failure is not fatal", async () => {
  const sleeps = [];
  const ac = new AbortController();
  let calls = 0;
  const client = { getUpdates: async () => { calls++; if (calls < 3) throw new Error("net"); if (calls === 3) return { updates: [{ id: "q" }], marker: "5" }; ac.abort(); return { updates: [], marker: "5" }; } };
  const processed = [];
  await runPolling({
    client, process: async (u) => (processed.push(u.id), { status: "ok" }),
    markerStore: { load: async () => null, save: async () => { throw new Error("disk"); } },
    types: [], signal: ac.signal, sleep: async (ms) => void sleeps.push(ms), log: () => {},
  });
  assert.deepEqual(processed, ["q"]);
  assert.equal(sleeps.length, 2);
});

// ---- webhook ----------------------------------------------------------------------------
async function withServer(processFn, fn) {
  const server = createWebhookServer({ secret: SECRET, process: processFn, log: () => {} });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  }
}
const post = (base, body, headers = { "x-max-bot-api-secret": SECRET }, path = "/max/webhook") =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("webhook: 200 for ok and for a consumed error, 503 for retry; the update reaches process() with exact int64 ids", async () => {
  const seen = [];
  const results = [{ status: "ok" }, { status: "error", action: "handled" }, { status: "retry", reason: "agent-unavailable" }];
  await withServer(async (u) => (seen.push(u), results.shift()), async (base) => {
    assert.equal((await post(base, '{"update_type":"message_created","message":{"sender":{"user_id":9007199254740993123}}}')).status, 200);
    assert.equal(seen[0].message.sender.user_id, "9007199254740993123");
    assert.equal((await post(base, { update_type: "x" })).status, 200);
    const r = await post(base, { update_type: "x" });
    assert.equal(r.status, 503);
    assert.equal(r.headers.get("retry-after"), "5");
  });
});

test("webhook: wrong/missing secret → 401 BEFORE the body is read or anything is processed", async () => {
  let called = 0;
  await withServer(async () => (called++, { status: "ok" }), async (base) => {
    assert.equal((await post(base, {}, {})).status, 401);
    assert.equal((await post(base, {}, { "x-max-bot-api-secret": "nope" })).status, 401);
    assert.equal((await post(base, {}, { "x-max-bot-api-secret": SECRET + "x" })).status, 401);
    assert.equal(called, 0);
  });
});

test("webhook: only POST on the exact path; oversized/garbage bodies are rejected; /healthz is open and harmless", async () => {
  let called = 0;
  await withServer(async () => (called++, { status: "ok" }), async (base) => {
    assert.equal((await fetch(base + "/max/webhook")).status, 405);
    assert.equal((await post(base, {}, undefined, "/eve/v1/max")).status, 404);
    assert.equal((await post(base, {}, undefined, "/")).status, 404);
    assert.equal((await post(base, "{nope")).status, 400);
    // Заявленная длина больше лимита → 413 до чтения тела (сырой http: fetch пересчитал бы Content-Length).
    const status413 = await new Promise((resolve, reject) => {
      const u = new URL(base);
      const rq = httpRequest({ host: u.hostname, port: u.port, path: "/max/webhook", method: "POST", headers: { "x-max-bot-api-secret": SECRET, "content-length": "999999" } }, (res) => { resolve(res.statusCode); res.resume(); });
      rq.on("error", reject);
      rq.write("{}");
    });
    assert.equal(status413, 413);
    // Поток без Content-Length: ответ 413 либо обрыв соединения (сервер перестаёт читать) — главное, process() не вызван.
    const big = await post(base, "x".repeat(400_000)).then((r) => r.status, () => "reset");
    assert.ok(big === 413 || big === "reset", String(big));
    assert.equal((await post(base, "[1,2]")).status, 200); // не объект — игнор
    assert.equal(called, 0);
    const h = await fetch(base + "/healthz");
    assert.equal(h.status, 200);
    assert.deepEqual(await h.json(), { ok: true, mode: "webhook" });
  });
});

test("webhook: a crash inside process() yields 500, not a hang or a false 200", async () => {
  await withServer(async () => { throw new Error("boom"); }, async (base) => {
    assert.equal((await post(base, {})).status, 500);
  });
});

// ---- единственный транспорт ---------------------------------------------------------------
test("transport lock: a live holder blocks the second transport; stale and own locks are replaced; release is owner-only", () => {
  const dir = tmp();
  const releasePoll = acquireTransportLock(dir, "poll", { pid: 111, isAlive: () => true });
  assert.throws(() => acquireTransportLock(dir, "webhook", { pid: 222, isAlive: () => true }), (e) => e instanceof TransportConflict && /mode=poll/.test(e.message));
  // владелец умер → блокировка протухла
  const releaseWh = acquireTransportLock(dir, "webhook", { pid: 222, isAlive: () => false });
  assert.equal(JSON.parse(readFileSync(join(dir, "transport.lock"), "utf8")).mode, "webhook");
  releasePoll(); // чужая запись не удаляется
  assert.equal(JSON.parse(readFileSync(join(dir, "transport.lock"), "utf8")).pid, 222);
  releaseWh();
  assert.throws(() => readFileSync(join(dir, "transport.lock")));
  writeFileSync(join(dir, "transport.lock"), "{garbage");
  acquireTransportLock(dir, "poll", { pid: 5, isAlive: () => true })(); // битый файл не блокирует
});

test("subscription guard: polling refuses to start while a webhook subscription exists; webhook warns when it is missing", async () => {
  const withSubs = (subs) => ({ getSubscriptions: async () => subs });
  await assert.rejects(() => checkSubscriptionForMode(withSubs(["https://x.example/max/webhook"]), "poll"), (e) => e instanceof TransportConflict && /iva max webhook off/.test(e.message));
  assert.deepEqual(await checkSubscriptionForMode(withSubs([]), "poll"), { ok: true });
  assert.match((await checkSubscriptionForMode(withSubs([]), "webhook")).warning, /iva max webhook set/);
  assert.match((await checkSubscriptionForMode(withSubs(["https://other/x"]), "webhook", { webhookUrl: "https://mine/x" })).warning, /not among/);
  assert.equal((await checkSubscriptionForMode(withSubs(["https://mine/x"]), "webhook", { webhookUrl: "https://mine/x" })).warning, undefined);
  // MAX недоступен — старт не блокируем (MAX всё равно шлёт события в один канал)
  assert.match((await checkSubscriptionForMode({ getSubscriptions: async () => { throw new Error("net"); } }, "poll")).warning, /could not read/);
});
