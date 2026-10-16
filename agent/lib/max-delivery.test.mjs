import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMaxClient, MaxApiError, resolveMaxBaseUrl, splitMaxText, MAX_TEXT_LIMIT } from "./max-api.ts";
import { createMaxStore } from "./max-store.ts";
import { createMaxOutbox } from "./max-outbox.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "max-test-"));
const quiet = () => {};

function mockFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const r = responses.shift() ?? { status: 200 };
    if (r instanceof Error) throw r;
    return new Response(r.body ?? "{}", { status: r.status, headers: r.headers });
  };
  return { fn, calls };
}

// ---- клиент ----------------------------------------------------------------------------

test("client: chat_id addressing, token only in Authorization header", async () => {
  const m = mockFetch([{ status: 200 }]);
  const c = createMaxClient({ token: "TOKEN", fetchImpl: m.fn, baseUrl: "https://mock.local" });
  await c.sendOnce({ chatId: "-77", userId: "5" }, "hi");
  assert.equal(m.calls[0].url, "https://mock.local/messages?chat_id=-77");
  assert.equal(m.calls[0].init.headers.authorization, "TOKEN");
  assert.ok(!m.calls[0].url.includes("TOKEN"));
  assert.deepEqual(JSON.parse(m.calls[0].init.body), { text: "hi" });
});

test("client: nullable chat_id falls back to user_id addressing", async () => {
  const m = mockFetch([{ status: 200 }]);
  const c = createMaxClient({ token: "T", fetchImpl: m.fn, baseUrl: "https://mock.local" });
  await c.sendOnce({ chatId: null, userId: "9007199254740993123" }, "hi");
  assert.equal(m.calls[0].url, "https://mock.local/messages?user_id=9007199254740993123");
});

test("client: errors carry status/code/retryability but never the token", async () => {
  const m = mockFetch([
    { status: 429, headers: { "retry-after": "3" }, body: '{"code":"too.many","message":"x"}' },
    { status: 403, body: '{"code":"chat.denied","message":"nope"}' },
    { status: 500 },
    new TypeError("fetch failed"),
  ]);
  const c = createMaxClient({ token: "SECRET-TOKEN", fetchImpl: m.fn, baseUrl: "https://mock.local" });
  const grab = async () => c.sendOnce({ chatId: "1", userId: "1" }, "x").then(() => null, (e) => e);
  const e429 = await grab();
  assert.ok(e429 instanceof MaxApiError);
  assert.deepEqual([e429.status, e429.retryable, e429.retryAfterMs, e429.code], [429, true, 3000, "too.many"]);
  const e403 = await grab();
  assert.deepEqual([e403.status, e403.retryable, e403.code], [403, false, "chat.denied"]);
  assert.equal((await grab()).retryable, true);
  const net = await grab();
  assert.deepEqual([net.status, net.retryable], [null, true]);
  for (const e of [e429, e403, net]) assert.ok(!e.message.includes("SECRET-TOKEN"));
});

test("client: base url must be https (http only for loopback)", () => {
  assert.equal(resolveMaxBaseUrl(undefined), "https://platform-api2.max.ru");
  assert.equal(resolveMaxBaseUrl("http://127.0.0.1:9/"), "http://127.0.0.1:9");
  assert.throws(() => resolveMaxBaseUrl("http://evil.example"));
});

test("splitMaxText respects 4000 and keeps all content", () => {
  const text = ("слово ".repeat(1500) + "\n\n").repeat(3);
  const parts = splitMaxText(text);
  assert.ok(parts.length >= 3);
  for (const p of parts) assert.ok(p.length <= MAX_TEXT_LIMIT);
  assert.equal(parts.join(" ").replace(/\s+/g, " "), text.trim().replace(/\s+/g, " "));
  assert.ok(splitMaxText("😀".repeat(5000)).every((p) => p.length <= MAX_TEXT_LIMIT));
  assert.deepEqual(splitMaxText("   "), []);
});

// ---- outbox ----------------------------------------------------------------------------

function rig({ dir = tmp(), script = [], now0 = 1_000_000, opts = {} } = {}) {
  const clock = { t: now0 };
  const now = () => clock.t;
  const sleep = async (ms) => { clock.t += ms; };
  const starts = [];
  const sent = [];
  const queue = [...script];
  const client = {
    async sendOnce(target, text) {
      starts.push(clock.t);
      sent.push({ target, text });
      // реальный запрос занимает время — чтобы окна пересекались
      await new Promise((r) => setImmediate(r));
      const step = queue.shift();
      if (step instanceof Error) throw step;
    },
  };
  const store = createMaxStore({ dir, now, log: quiet });
  const outbox = createMaxOutbox({ store, client, now, sleep, log: quiet, ...opts });
  return { dir, clock, starts, sent, store, outbox, client };
}
const apiErr = (status, extra = {}) =>
  new MaxApiError(`HTTP ${status}`, status, status === 429 || status >= 500, extra);

test("outbox: concurrent enqueues to ONE dialog never exceed 2 msg/sec and keep order", async () => {
  const r = rig();
  await Promise.all(["a", "b", "c", "d", "e"].map(async (t) => r.outbox.enqueue("42", t)));
  await r.outbox.idle();
  assert.deepEqual(r.sent.map((s) => s.text), ["a", "b", "c", "d", "e"]);
  for (let i = 1; i < r.starts.length; i++) assert.ok(r.starts[i] - r.starts[i - 1] >= 500, `gap ${r.starts[i] - r.starts[i - 1]}`);
  // любые 3 подряд — шире секунды ⇒ ≤2 за секунду
  for (let i = 2; i < r.starts.length; i++) assert.ok(r.starts[i] - r.starts[i - 2] >= 1000);
  assert.equal(r.store.stats().queued, 0);
});

test("outbox: different dialogs do not block each other", async () => {
  const r = rig();
  r.outbox.enqueue("1", "x");
  r.outbox.enqueue("2", "y");
  await r.outbox.idle();
  assert.equal(r.sent.length, 2);
});

test("outbox: long reply is chunked in order, ≤4000 each", async () => {
  const r = rig();
  r.outbox.enqueue("1", "слово ".repeat(2500));
  await r.outbox.idle();
  assert.ok(r.sent.length >= 4);
  assert.ok(r.sent.every((s) => s.text.length <= MAX_TEXT_LIMIT));
});

test("outbox: 5xx/429 are retried with backoff (Retry-After honoured), order preserved, then delivered", async () => {
  const r = rig({ script: [apiErr(500), apiErr(429, { retryAfterMs: 30_000 })], opts: { backoffBaseMs: 1000 } });
  r.outbox.enqueue("1", "first");
  r.outbox.enqueue("1", "second");
  await r.outbox.idle();
  assert.deepEqual(r.sent.map((s) => s.text), ["first"]); // second ждёт голову, не обгоняет
  assert.equal(r.store.stats().queued, 2);
  r.clock.t += 1500; r.outbox.poke(); await r.outbox.idle(); // backoff 1s → попытка 2 → 429 с Retry-After 30с
  assert.deepEqual(r.sent.map((s) => s.text), ["first", "first"]);
  r.clock.t += 5000; r.outbox.poke(); await r.outbox.idle();
  assert.equal(r.sent.length, 2); // Retry-After ещё не истёк
  r.clock.t += 30_000; r.outbox.poke(); await r.outbox.idle();
  assert.deepEqual(r.sent.map((s) => s.text), ["first", "first", "first", "second"]);
  assert.equal(r.store.stats().queued, 0);
});

test("outbox: 4xx (non-429) is NOT retried; item becomes dead with diagnostics but no content", async () => {
  const logs = [];
  const r = rig({ script: [apiErr(403, { code: "chat.denied" })], opts: { log: (m) => logs.push(m) } });
  r.outbox.enqueue("1", "secret reply text");
  await r.outbox.idle();
  const st = r.store.stats();
  assert.equal(r.sent.length, 1);
  assert.equal(st.queued, 0);
  assert.equal(st.dead, 1);
  assert.deepEqual([st.deadItems[0].lastError.status, st.deadItems[0].lastError.name], [403, "chat.denied"]);
  assert.equal(st.deadItems[0].text, "");
  assert.ok(logs.some((l) => /DELIVERY FAILED permanently/.test(l)));
  assert.ok(!readFileSync(join(r.dir, "outbox.json"), "utf8").includes("secret reply text"));
});

test("outbox: gives up after maxAttempts and records it", async () => {
  const r = rig({ script: Array(10).fill(apiErr(500)), opts: { maxAttempts: 3, backoffBaseMs: 10 } });
  r.outbox.enqueue("1", "x");
  for (let i = 0; i < 6; i++) { await r.outbox.idle(); r.clock.t += 1000; r.outbox.poke(); }
  await r.outbox.idle();
  assert.equal(r.sent.length, 3);
  assert.equal(r.store.stats().dead, 1);
});

test("outbox: undelivered replies survive a restart and are delivered by the new process", async () => {
  const r1 = rig({ script: [apiErr(500)], opts: { backoffBaseMs: 100 } });
  r1.outbox.enqueue("7", "important");
  await r1.outbox.idle();
  r1.outbox.stop();
  assert.equal(r1.store.stats().queued, 1);
  const r2 = rig({ dir: r1.dir, now0: r1.clock.t + 10_000 });
  assert.equal(r2.store.stats().queued, 1);
  r2.outbox.start();
  await r2.outbox.idle();
  r2.outbox.stop();
  assert.deepEqual(r2.sent.map((s) => s.text), ["important"]);
  assert.equal(r2.store.stats().queued, 0);
});

test("outbox: target uses last known chat_id, falls back to user_id", async () => {
  const r = rig();
  r.outbox.enqueue("5", "no chat yet");
  r.store.rememberDialog("5", "-1234567890123456789");
  r.outbox.enqueue("5", "with chat");
  await r.outbox.idle();
  assert.deepEqual(r.sent.map((s) => s.target), [
    { chatId: null, userId: "5" },
    { chatId: "-1234567890123456789", userId: "5" },
  ]);
});

// ---- store -----------------------------------------------------------------------------

test("store: accepted events persist, in-flight does not; files are private and corrupt files are set aside", () => {
  const dir = tmp();
  const s1 = createMaxStore({ dir, log: quiet });
  assert.equal(s1.claim("k1"), "new");
  assert.equal(s1.claim("k1"), "in_flight");
  s1.claim("k2"); s1.commit("k2");
  assert.equal(s1.claim("k2"), "done");
  s1.abort("k1");
  assert.equal(s1.claim("k1"), "new"); // после сбоя можно повторить
  const s2 = createMaxStore({ dir, log: quiet }); // «рестарт»: k1 был in-flight → забыт, k2 принят
  assert.equal(s2.claim("k1"), "new");
  assert.equal(s2.claim("k2"), "done");
  assert.equal(statSync(join(dir, "state.json")).mode & 0o077, 0);
});

test("store: corrupt state file is moved aside, not silently overwritten", async () => {
  const { writeFileSync, readdirSync } = await import("node:fs");
  const dir = tmp();
  createMaxStore({ dir, log: quiet }).commit("x");
  writeFileSync(join(dir, "state.json"), "{not json");
  const logs = [];
  const s = createMaxStore({ dir, log: (m) => logs.push(m) });
  assert.equal(s.claim("x"), "new");
  assert.ok(readdirSync(dir).some((f) => f.startsWith("state.json.corrupt-")));
  assert.ok(logs.length === 1);
  assert.ok(existsSync(dir));
});
