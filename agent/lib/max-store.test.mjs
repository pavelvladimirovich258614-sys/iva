import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMaxStore, writeJsonAtomic } from "./max-store.ts";
import { loadMaxConfig } from "./max-updates.ts";
import { handleMaxWebhook } from "./max-webhook.ts";

const quiet = () => {};
const tmp = () => mkdtempSync(join(tmpdir(), "max-store-"));

/** Диск, который можно «ломать» и «чинить»; запись делегируется настоящей атомарной. */
function flakyIo() {
  const io = {
    broken: false,
    writes: 0,
    writeJson(file, value) {
      io.writes++;
      if (io.broken) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      writeJsonAtomic(file, value);
    },
  };
  return io;
}

// ---- контракт commit ------------------------------------------------------------------
test("commit() throws when the acknowledgement cannot be written, and never reports success", () => {
  const io = flakyIo();
  const dir = tmp();
  const s = createMaxStore({ dir, log: quiet, io });
  assert.equal(s.claim("k"), "new");
  io.broken = true;
  assert.throws(() => s.commit("k"), /ENOSPC/);
  assert.equal(s.stats().health.persistFailing, true);
  assert.equal(s.stats().health.unpersistedEvents, 1);
  // на диске подтверждения нет
  assert.equal(createMaxStore({ dir, log: quiet }).claim("k"), "new");
});

test("after a failed commit the event stays 'accepted' in memory, but claim() will not say done until the file is written", () => {
  const io = flakyIo();
  const dir = tmp();
  const s = createMaxStore({ dir, log: quiet, io });
  s.claim("k");
  io.broken = true;
  assert.throws(() => s.commit("k"));
  assert.throws(() => s.claim("k"), /ENOSPC/); // ложного «done» нет, пока запись невозможна
  io.broken = false;
  assert.equal(s.claim("k"), "done"); // записали → теперь честно «done»
  assert.equal(s.stats().health.persistFailing, false);
  assert.equal(createMaxStore({ dir, log: quiet }).claim("k"), "done"); // и это пережило рестарт
});

test("a failing dialog-cache write never blocks acceptance and is retried with the next write", () => {
  const io = flakyIo();
  const dir = tmp();
  const s = createMaxStore({ dir, log: quiet, io });
  io.broken = true;
  s.rememberDialog("5", "-77"); // не бросает
  assert.equal(s.dialogChatId("5"), "-77");
  io.broken = false;
  s.claim("k");
  s.commit("k");
  assert.equal(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).dialogs["5"], "-77");
});

test("real filesystem failure: unreadable state stops the owner; a target that turns into a directory makes commit() throw", () => {
  const dir = tmp();
  mkdirSync(join(dir, "state.json", "x"), { recursive: true }); // state.json — каталог
  assert.throws(() => createMaxStore({ dir, log: quiet })); // нечитаемое состояние: владелец не стартует молча с пустого

  const dir2 = tmp();
  const s = createMaxStore({ dir: dir2, log: quiet });
  s.claim("a");
  s.commit("a");
  rmSync(join(dir2, "state.json"));
  mkdirSync(join(dir2, "state.json", "x"), { recursive: true }); // rename файла поверх непустого каталога невозможен
  s.claim("b");
  assert.throws(() => s.commit("b"));
  assert.deepEqual(readdirSync(dir2).filter((n) => n.includes(".tmp-")), [], "no tmp litter");
});

test("write is atomic: a failed write keeps the previous file intact and removes its tmp file", () => {
  const dir = tmp();
  const file = join(dir, "x.json");
  writeJsonAtomic(file, { v: 1 });
  const circular = {};
  circular.self = circular; // JSON.stringify бросит
  assert.throws(() => writeJsonAtomic(file, circular));
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { v: 1 });
  assert.deepEqual(readdirSync(dir).filter((n) => n.includes(".tmp-")), []);
  assert.equal(statSync(file).mode & 0o077, 0); // 0600
});

// ---- повреждение ----------------------------------------------------------------------
test("a corrupt state/outbox file is moved aside, reported in health, and the store still starts", () => {
  const dir = tmp();
  writeFileSync(join(dir, "state.json"), "{broken");
  writeFileSync(join(dir, "outbox.json"), "[1,2,3]"); // валидный JSON, но неверной формы
  const logs = [];
  const s = createMaxStore({ dir, log: (m) => logs.push(m) });
  const h = s.stats().health;
  assert.equal(h.corruptFiles.length, 2);
  assert.ok(readdirSync(dir).filter((n) => n.includes(".corrupt-")).length === 2);
  assert.ok(logs.every((l) => /ERROR/.test(l)));
  assert.equal(s.claim("k"), "new"); // дедуп-история потеряна — это видно в health, а не тихо
  s.commit("k");
  assert.equal(createMaxStore({ dir, log: quiet }).claim("k"), "done");
});

// ---- параллельность и рестарт ---------------------------------------------------------
test("concurrent claims of one event: exactly one 'new', the rest in_flight; after commit all done", () => {
  const s = createMaxStore({ dir: tmp(), log: quiet });
  const results = Array.from({ length: 50 }, () => s.claim("same"));
  assert.equal(results.filter((r) => r === "new").length, 1);
  assert.equal(results.filter((r) => r === "in_flight").length, 49);
  s.commit("same");
  assert.ok(Array.from({ length: 10 }, () => s.claim("same")).every((r) => r === "done"));
});

test("restart: accepted events survive; events that were only in flight are replayed", () => {
  const dir = tmp();
  const a = createMaxStore({ dir, log: quiet });
  a.claim("done-1"); a.commit("done-1");
  a.claim("inflight-1");
  const b = createMaxStore({ dir, log: quiet });
  assert.equal(b.claim("done-1"), "done");
  assert.equal(b.claim("inflight-1"), "new");
});

// ---- на уровне обработчика ------------------------------------------------------------
const SECRET = "s3cret-value";
const env = { MAX_BOT_TOKEN: "t", MAX_WEBHOOK_SECRET: SECRET, MAX_ALLOWED_USER_IDS: "111" };
const update = (mid, text = "привет") => ({
  update_type: "message_created",
  timestamp: 1,
  message: {
    sender: { user_id: 111, first_name: "U", is_bot: false },
    recipient: { chat_type: "dialog", chat_id: 500, user_id: null },
    timestamp: 1,
    body: { mid, seq: 1, text },
  },
});
const req = (body) =>
  new Request("http://x/", { method: "POST", headers: { "x-max-bot-api-secret": SECRET }, body: JSON.stringify(body) });

function harness({ dir = tmp(), io } = {}) {
  const sent = [];
  const replies = [];
  const store = createMaxStore({ dir, log: quiet, ...(io ? { io } : {}) });
  const deps = {
    config: loadMaxConfig(env),
    store,
    reply: (u, t) => void replies.push([u, t]),
    send: async (m) => void sent.push(m),
    reset: async () => {},
    cancel: async () => ({ status: "accepted" }),
    commands: { greeting: "hi", newConversation: "new", help: () => "h", usage: () => "u", stopped: "s", nothingRunning: "n", needsBridge: "b" },
    log: quiet,
  };
  return { deps, sent, replies, store, dir };
}

test("handler: Eve accepted the turn but the ack cannot be written → 5xx, NOT 200; redelivery does not start a second turn", async () => {
  const io = flakyIo();
  const h = harness({ io });
  io.broken = true;
  const r1 = await handleMaxWebhook(req(update("m1")), h.deps);
  assert.equal(r1.status, 500);
  assert.equal(h.sent.length, 1);
  // MAX повторяет доставку, диск всё ещё сломан → по-прежнему не подтверждаем и не запускаем ход повторно
  const r2 = await handleMaxWebhook(req(update("m1")), h.deps);
  assert.equal(r2.status, 500);
  assert.equal(h.sent.length, 1);
  // диск восстановился → подтверждение дописано, 200, ход всё ещё один
  io.broken = false;
  const r3 = await handleMaxWebhook(req(update("m1")), h.deps);
  assert.equal(r3.status, 200);
  assert.equal(h.sent.length, 1);
  assert.equal(createMaxStore({ dir: h.dir, log: quiet }).claim("msg:m1"), "done");
});

test("handler: process dies while the ack is unwritten → the replay runs the turn again (documented at-least-once)", async () => {
  const io = flakyIo();
  const h = harness({ io });
  io.broken = true;
  assert.equal((await handleMaxWebhook(req(update("m2")), h.deps)).status, 500);
  const h2 = harness({ dir: h.dir }); // «рестарт»
  assert.equal((await handleMaxWebhook(req(update("m2")), h2.deps)).status, 200);
  assert.equal(h.sent.length + h2.sent.length, 2, "no exactly-once claim: the turn ran in both lives");
});

test("handler: 50 concurrent copies of one event → one turn, all answered 200 after the first commit", async () => {
  const h = harness();
  const rs = await Promise.all(Array.from({ length: 50 }, () => handleMaxWebhook(req(update("burst")), h.deps)));
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal(h.sent.length, 1);
});

test("handler: 30 distinct concurrent events of one user are processed in order, each exactly once", async () => {
  const order = [];
  const h = harness();
  h.deps.send = async (m) => { order.push(m); await new Promise((r) => setTimeout(r, 2)); };
  const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => handleMaxWebhook(req(update(`e${i}`, `msg-${i}`)), h.deps)));
  assert.ok(rs.every((r) => r.status === 200));
  assert.deepEqual(order, Array.from({ length: 30 }, (_, i) => `msg-${i}`));
});

test("handler: unreadable earlier acknowledgement (claim fails) → 5xx instead of a false 200", async () => {
  const io = flakyIo();
  const h = harness({ io });
  io.broken = true;
  await handleMaxWebhook(req(update("m3")), h.deps); // 500, ack unpersisted
  const r = await handleMaxWebhook(req(update("m3")), h.deps);
  assert.equal(r.status, 500);
});

test("outbox: a failing queue write never triggers a resend loop for an already delivered chunk", async () => {
  const { createMaxOutbox } = await import("./max-outbox.ts");
  const io = flakyIo();
  const store = createMaxStore({ dir: tmp(), log: quiet, io });
  const sends = [];
  const outbox = createMaxOutbox({
    store, log: quiet, minIntervalMs: 0, sleep: async () => {},
    client: { sendOnce: async (_t, text) => void sends.push(text) },
  });
  outbox.enqueue("1", "once");
  io.broken = true; // сломался диск между постановкой и подтверждением доставки
  await outbox.idle();
  outbox.poke();
  await outbox.idle();
  outbox.poke();
  await outbox.idle();
  assert.deepEqual(sends, ["once"], "delivered chunk is forgotten in memory even if the disk write failed");
});
