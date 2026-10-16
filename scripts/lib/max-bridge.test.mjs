import test from "node:test";
import assert from "node:assert/strict";
import { createMaxTg, toMaxKeyboard } from "./max-tg.mjs";
import { createFailureTracker, createMaxBridge, isIdempotentCallback, toCallback, toMsg } from "./max-bridge-core.mjs";
import { createLedger } from "../../agent/lib/max-ledger.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MaxApiError } from "../../agent/lib/max-api.ts";

const U = "9007199254740993123";
const msgUpdate = (text, over = {}) => ({
  update_type: "message_created",
  timestamp: 1,
  message: {
    sender: { user_id: over.userId ?? U, first_name: "x", is_bot: false },
    recipient: { chat_type: over.chatType ?? "dialog", chat_id: over.chatId === undefined ? "-55" : over.chatId, user_id: null },
    timestamp: 1,
    body: { mid: over.mid ?? "mid-1", seq: 1, text },
  },
});
const cbUpdate = (payload, userId = U) => ({
  update_type: "message_callback",
  timestamp: 1,
  callback: { timestamp: 1, callback_id: "cb-1", payload, user: { user_id: userId, first_name: "x", is_bot: false } },
  message: { sender: { user_id: 1, is_bot: true }, recipient: { chat_type: "dialog", chat_id: null, user_id: U }, timestamp: 1, body: { mid: "menu-mid", seq: 3, text: "menu" } },
});

// ---- tg-шим ----------------------------------------------------------------------------
function fakeClient() {
  const calls = [];
  const rec = (name, ret) => async (...a) => { calls.push([name, ...a]); if (ret instanceof Error) throw ret; return ret; };
  return {
    calls,
    client: {
      sendOnce: rec("sendOnce", { mid: "new-mid" }),
      editMessage: rec("editMessage"),
      deleteMessage: rec("deleteMessage"),
      answerCallback: rec("answerCallback"),
    },
  };
}

test("tg shim: Telegram-style calls become MAX calls (keyboard, ids, edit semantics)", async () => {
  const f = fakeClient();
  const tg = createMaxTg(f.client, { dialogChatId: (u) => (u === U ? "-55" : null) });
  const markup = { inline_keyboard: [[{ text: "A", callback_data: "iva_menu:r:o" }, { text: "L", url: "https://x.y" }]] };
  const sent = await tg("sendMessage", { chat_id: U, text: "hi", reply_markup: markup });
  assert.deepEqual(sent, { ok: true, result: { message_id: "new-mid", chat: { id: U } } });
  assert.deepEqual(f.calls[0], ["sendOnce", { chatId: "-55", userId: U }, "hi", {
    keyboard: [[{ type: "callback", text: "A", payload: "iva_menu:r:o" }, { type: "link", text: "L", url: "https://x.y" }]],
  }]);
  await tg("sendMessage", { chat_id: "42", text: "no dialog known" });
  assert.deepEqual(f.calls[1][1], { chatId: null, userId: "42" }); // fallback user_id

  await tg("editMessageText", { chat_id: U, message_id: "m1", text: "t" }); // без reply_markup → клавиатура снимается
  assert.deepEqual(f.calls[2], ["editMessage", "m1", "t", { keyboard: [] }]);
  await tg("editMessageReplyMarkup", { chat_id: U, message_id: "m1", reply_markup: { inline_keyboard: [] } });
  assert.deepEqual(f.calls[3], ["editMessage", "m1", undefined, { keyboard: [] }]);
  await tg("deleteMessage", { chat_id: U, message_id: "m1" });
  assert.deepEqual(f.calls[4], ["deleteMessage", "m1"]);
  await tg("answerCallbackQuery", { callback_query_id: "cb-9", text: "ok" });
  assert.deepEqual(f.calls[5], ["answerCallback", "cb-9", { notification: "ok" }]);
  const n = f.calls.length;
  await tg("answerCallbackQuery", { callback_query_id: "ivastop-1" }); // синтетический id — без обращения к API
  assert.equal(f.calls.length, n);
});

test("tg shim: API failures become {ok:false} (never throw); unsupported methods are reported", async () => {
  const f = fakeClient();
  f.client.sendOnce = async () => { throw new MaxApiError("MAX API HTTP 403", 403, false, { code: "chat.denied" }); };
  const tg = createMaxTg(f.client);
  const r = await tg("sendMessage", { chat_id: "1", text: "x" });
  assert.equal(r.ok, false);
  assert.match(r.description, /403.*chat\.denied/);
  assert.equal((await tg("kickChatMember", {})).ok, false);
});

test("keyboard conversion drops empty rows and clamps lengths", () => {
  assert.deepEqual(toMaxKeyboard({ inline_keyboard: [[], [{ text: "x".repeat(300), callback_data: "y".repeat(2000) }]] }), [
    [{ type: "callback", text: "x".repeat(128), payload: "y".repeat(1024) }],
  ]);
  assert.equal(toMaxKeyboard(undefined), undefined);
});

// ---- ядро моста ------------------------------------------------------------------------
function rig({ allowed = new Set([U]), pending = null, forwardFails = false, ledgerDir, ledgerIo, impl = {} } = {}) {
  const log = [];
  const forwarded = [];
  const mk = (name) => async (...a) => { log.push([name, ...a]); return true; };
  const flows = {
    get: (chat, user) => (pending && String(chat) === U && String(user) === U ? pending : null),
    end: async (...a) => { log.push(["flows.end", a[1]]); },
  };
  const tracker = createFailureTracker();
  const rawTg = async (...a) => { log.push(["tg", ...a]); return { ok: true, result: {} }; };
  const ledger = createLedger({ dir: ledgerDir ?? mkdtempSync(join(tmpdir(), "max-led-")), log: () => {}, ...(ledgerIo ? { io: ledgerIo } : {}) });
  const replies = [];
  const bridge = createMaxBridge({
    allowed,
    forward: async (u) => { if (forwardFails) throw new Error("down"); forwarded.push(u); },
    tg: tracker.wrap(impl.tg ?? rawTg),
    reply: impl.reply ?? (async (chat, text) => { replies.push(text); log.push(["reply", text]); return { message_id: "r" }; }),
    menu: { open: mk("menu.open"), onCallback: mk("menu.onCallback"), onText: mk("menu.onText"), ...impl.menu },
    wizard: { handleModelCmd: mk("wiz.model"), handleThinkCmd: mk("wiz.think"), handleWizardCallback: mk("wiz.cb"), handleKeyMessage: mk("wiz.key"), ...impl.wizard },
    flows,
    handleUpdate: impl.onUpdateCb ?? mk("update.cb"),
    handleUpdateCheck: impl.handleUpdateCheck ?? mk("update.check"),
    restartAgent: impl.restartAgent ?? mk("restart"),
    ledger,
    tracker,
    rememberDialog: (u, c) => log.push(["dialog", u, c]),
    log: () => {},
  });
  return { bridge, log, forwarded, replies, ledger };
}
const names = (log) => log.map((l) => l[0]);
const act = async (r, u) => { const x = await r.bridge.process(u); return `${x.status}:${x.action ?? x.reason}`; };

test("plain text, /new, /stop, /help, /usage, /tasks are forwarded to the agent channel — not handled locally", async () => {
  const r = rig();
  for (const t of ["hello", "/new", "/stop", "/help", "/usage week", "/tasks", "/task buy milk", "/digest"]) {
    assert.equal(await act(r, msgUpdate(t)), "ok:forwarded", t);
  }
  assert.equal(r.forwarded.length, 8);
  assert.equal(r.forwarded[0].message.sender.user_id, U); // int64 как строка, без потери точности
});

test("control commands are served by the bridge and never reach the agent", async () => {
  const r = rig();
  for (const [t, expected] of [["/menu", "menu.open"], ["/model", "wiz.model"], ["/think", "wiz.think"], ["/update", "update.check"], ["/restart", "restart"]]) {
    r.log.length = 0;
    assert.equal(await act(r, msgUpdate(t, { mid: `m-${t}` })), "ok:handled");
    assert.ok(names(r.log).includes(expected), `${t} → ${expected}`);
  }
  assert.equal(r.forwarded.length, 0);
});

test("strangers: nothing is handled or forwarded (messages and button taps)", async () => {
  const r = rig({ allowed: new Set(["1"]) });
  assert.equal(await act(r, msgUpdate("/menu")), "ok:denied");
  assert.equal(await act(r, msgUpdate("secret question")), "ok:denied");
  assert.equal(await act(r, cbUpdate("iva_menu:r:o")), "ok:denied");
  assert.equal(r.forwarded.length, 0);
  assert.ok(!names(r.log).some((n) => n.startsWith("menu") || n.startsWith("wiz")));
  const empty = rig({ allowed: new Set() });
  assert.equal(await act(empty, msgUpdate("hi")), "ok:denied");
});

test("button taps are routed by payload prefix; unknown payloads are just acknowledged", async () => {
  const r = rig();
  await r.bridge.process(cbUpdate("iva_menu:srch:o"));
  await r.bridge.process({ ...cbUpdate("iva_model:chg"), callback: { ...cbUpdate("x").callback, callback_id: "c2", payload: "iva_model:chg" } });
  await r.bridge.process({ ...cbUpdate("x"), callback: { ...cbUpdate("x").callback, callback_id: "c3", payload: "iva_think:cancel" } });
  await r.bridge.process({ ...cbUpdate("x"), callback: { ...cbUpdate("x").callback, callback_id: "c4", payload: "iva_update:do" } });
  assert.deepEqual(names(r.log).filter((n) => !["tg", "dialog"].includes(n)), ["menu.onCallback", "wiz.cb", "wiz.cb", "update.cb"]);
  r.log.length = 0;
  assert.equal(await act(r, { ...cbUpdate("x"), callback: { ...cbUpdate("x").callback, callback_id: "c5", payload: "something-else" } }), "ok:ignored");
  assert.deepEqual(r.log.map((l) => [l[0], l[1]]), [["tg", "answerCallbackQuery"]]);
  const cq = toCallback(cbUpdate("iva_menu:r:o"));
  assert.deepEqual([cq.id, cq.from.id, cq.message.message_id, cq.message.chat.id, cq.data], ["cb-1", U, "menu-mid", U, "iva_menu:r:o"]);
});

test("a pending input prompt captures the next message (never forwarded); a command cancels the wait", async () => {
  const menuPending = { flow: "menu", awaitText: { kind: "apikey", secret: true } };
  const r = rig({ pending: menuPending });
  assert.equal(await act(r, msgUpdate("sk-very-secret-key-123456")), "ok:handled");
  assert.ok(names(r.log).includes("menu.onText"));
  assert.equal(r.forwarded.length, 0);

  const wiz = rig({ pending: { flow: "model", awaitText: { kind: "apikey", secret: true } } });
  await wiz.bridge.process(msgUpdate("sk-another-secret-key"));
  assert.ok(names(wiz.log).includes("wiz.key"));
  assert.equal(wiz.forwarded.length, 0);

  const cancel = rig({ pending: menuPending });
  assert.equal(await act(cancel, msgUpdate("/new")), "ok:forwarded"); // ожидание снято, команда пошла в канал
  assert.ok(names(cancel.log).includes("flows.end"));
});

test("groups / channel posts / non-dialog are not handled locally (channel ignores them)", async () => {
  const r = rig();
  assert.equal(await act(r, msgUpdate("/menu", { chatType: "chat" })), "ok:forwarded");
  assert.equal(toMsg(msgUpdate("x", { chatType: "channel" })), null);
  assert.equal(r.log.filter((l) => l[0] === "menu.open").length, 0);
});

test("dialog chat_id is remembered when present, nullable chat_id is tolerated", async () => {
  const r = rig();
  await r.bridge.process(msgUpdate("/menu"));
  assert.deepEqual(r.log.find((l) => l[0] === "dialog"), ["dialog", U, "-55"]);
  const r2 = rig();
  await r2.bridge.process(msgUpdate("/menu", { chatId: null }));
  assert.equal(r2.log.filter((l) => l[0] === "dialog").length, 0);
  assert.ok(names(r2.log).includes("menu.open"));
});

test("bot_started goes to the channel; other update types are ignored", async () => {
  const r = rig();
  assert.equal(await act(r, { update_type: "bot_started", timestamp: 1, chat_id: 5, user: { user_id: U } }), "ok:forwarded");
  assert.equal(await act(r, { update_type: "message_edited", timestamp: 1 }), "ok:ignored");
});

// ---- явные статусы и повторная доставка -------------------------------------------------
test("agent unavailable → status 'retry' (nothing is acknowledged); a poison 4xx from the channel is consumed", async () => {
  const bad = rig({ forwardFails: true });
  assert.deepEqual(await bad.bridge.process(msgUpdate("hello")), { status: "retry", reason: "agent-unavailable" });
  const consumed = createMaxBridge({
    allowed: new Set([U]), forward: async () => { throw Object.assign(new Error("HTTP 400"), { consumed: true }); },
    tg: async () => ({ ok: true }), reply: async () => ({}), menu: {}, wizard: {}, flows: { get: () => null }, ledger: createLedger({ dir: mkdtempSync(join(tmpdir(), "l-")), log: () => {} }),
    handleUpdate: async () => {}, handleUpdateCheck: async () => {}, restartAgent: async () => {}, log: () => {},
  });
  assert.deepEqual(await consumed.process(msgUpdate("hello")), { status: "error", action: "forwarded" });
});

test("a throwing menu screen / wizard / update step is NOT swallowed: the user gets an explanation and the status is 'error'", async () => {
  const r = rig({
    impl: {
      menu: { open: async () => { throw new Error("screen exploded"); }, onCallback: async () => { throw new Error("cb boom"); } },
      wizard: { handleWizardCallback: async () => { throw new Error("wizard boom"); } },
      restartAgent: async () => { throw new Error("systemctl: Failed to connect to bus"); },
    },
  });
  assert.deepEqual(await r.bridge.process(msgUpdate("/menu", { mid: "a" })), { status: "error", action: "handled" });
  assert.match(r.replies.at(-1), /\/menu.*(failed|ошибка).*screen exploded/s);
  assert.deepEqual(await r.bridge.process(msgUpdate("/restart", { mid: "b" })), { status: "error", action: "handled" });
  assert.match(r.replies.at(-1), /Failed to connect to bus/);
  assert.equal((await r.bridge.process(cbUpdate("iva_menu:svc:apply"))).status, "error");
  assert.equal((await r.bridge.process({ ...cbUpdate("x"), callback: { ...cbUpdate("x").callback, callback_id: "w1", payload: "iva_model:m:0" } })).status, "error");
  assert.equal(r.forwarded.length, 0);
});

test("error text never leaks secrets", async () => {
  const r = rig({ impl: { menu: { open: async () => { throw new Error("bad key sk-abcdefghijklmnopqrstuvwxyz123456 in env"); } } } });
  await r.bridge.process(msgUpdate("/menu"));
  assert.ok(!r.replies.at(-1).includes("sk-abcdefghijkl"));
});

test("if the user cannot be told about a failure either, the status is 'retry' (not consumed)", async () => {
  const r = rig({ impl: { reply: async () => null, menu: { open: async () => { throw new Error("x"); } } } });
  assert.deepEqual(await r.bridge.process(msgUpdate("/menu")), { status: "retry", reason: "notify-failed" });
});

test("redelivery of /restart and /update runs them exactly once; the duplicate is acknowledged without side effects", async () => {
  const counts = { restart: 0, update: 0, updateCb: 0 };
  const r = rig({ impl: {
    restartAgent: async () => { counts.restart++; },
    handleUpdateCheck: async () => { counts.update++; },
    onUpdateCb: async () => { counts.updateCb++; },
  } });
  for (let i = 0; i < 3; i++) {
    assert.equal((await r.bridge.process(msgUpdate("/restart", { mid: "R1" }))).status, "ok");
    assert.equal((await r.bridge.process(msgUpdate("/update", { mid: "U1" }))).status, "ok");
    assert.equal((await r.bridge.process({ ...cbUpdate("iva_update:do"), callback: { ...cbUpdate("x").callback, callback_id: "UD1", payload: "iva_update:do" } })).status, "ok");
  }
  assert.deepEqual(counts, { restart: 1, update: 1, updateCb: 1 });
});

test("concurrent redelivery of the same dangerous event runs it once", async () => {
  let n = 0;
  const r = rig({ impl: { restartAgent: async () => { n++; await new Promise((x) => setTimeout(x, 30)); } } });
  const rs = await Promise.all(Array.from({ length: 10 }, () => r.bridge.process(msgUpdate("/restart", { mid: "RR" }))));
  assert.equal(n, 1);
  assert.ok(rs.every((x) => x.status === "ok"));
});

test("crash in the middle of /restart: the replay does NOT run it again, the user is told the outcome is unknown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "max-led-crash-"));
  let runs = 0;
  const first = rig({ ledgerDir: dir, impl: { restartAgent: async () => { runs++; throw Object.assign(new Error("simulated kill"), { crash: true }); } } });
  // «Падение»: процесс умер до записи итога — имитируем, не давая моста записать fail/finish
  first.ledger.begin("msg:R-crash", { idempotent: false });
  // новый процесс с тем же диском
  const second = rig({ ledgerDir: dir, impl: { restartAgent: async () => { runs++; } } });
  const res = await second.bridge.process(msgUpdate("/restart", { mid: "R-crash" }));
  assert.deepEqual(res, { status: "ok", action: "unknown-outcome" });
  assert.equal(runs, 0);
  assert.match(second.replies.at(-1), /interrupted|оборвалась/);
  // и после уведомления цикл закрыт: следующая доставка — просто дубль
  assert.deepEqual(await second.bridge.process(msgUpdate("/restart", { mid: "R-crash" })), { status: "ok", action: "duplicate" });
  assert.equal(runs, 0);
});

test("a dangerous command is NOT started when its intent cannot be persisted → retry; it runs after the disk recovers", async () => {
  let broken = true;
  const { writeJsonAtomic } = await import("../../agent/lib/max-store.ts");
  const io = { writeJson: (f, v) => { if (broken) throw new Error("ENOSPC"); writeJsonAtomic(f, v); } };
  let runs = 0;
  const r = rig({ ledgerIo: io, impl: { restartAgent: async () => { runs++; } } });
  assert.deepEqual(await r.bridge.process(msgUpdate("/restart", { mid: "R2" })), { status: "retry", reason: "ledger-unavailable" });
  assert.equal(runs, 0);
  broken = false;
  assert.equal((await r.bridge.process(msgUpdate("/restart", { mid: "R2" }))).status, "ok");
  assert.equal(runs, 1);
});

test("failed dangerous command is not retried on redelivery; the failure is reported once", async () => {
  let runs = 0;
  const r = rig({ impl: { restartAgent: async () => { runs++; throw new Error("nope"); } } });
  assert.equal((await r.bridge.process(msgUpdate("/restart", { mid: "R3" }))).status, "error");
  assert.deepEqual(await r.bridge.process(msgUpdate("/restart", { mid: "R3" })), { status: "error", action: "duplicate" });
  assert.equal(runs, 1);
  assert.equal(r.replies.length, 1);
});

test("safe navigation is simply re-run on redelivery (no ledger entry needed)", async () => {
  const r = rig();
  const dup = { ...cbUpdate("iva_menu:st:o"), callback: { ...cbUpdate("x").callback, callback_id: "N1", payload: "iva_menu:st:o" } };
  await r.bridge.process(dup);
  await r.bridge.process(dup);
  assert.equal(r.log.filter((l) => l[0] === "menu.onCallback").length, 2);
});

test("reply lost to a MAX outage after a safe command → 'retry'; after a dangerous one → 'retry' but never re-executed", async () => {
  // tg-вызов (показ экрана) падает как временный сбой MAX API
  const flaky = async (m) => (m === "sendMessage" ? { ok: false, retryable: true, description: "HTTP 503" } : { ok: true });
  let restarts = 0;
  const tracker = createFailureTracker();
  const wrapped = tracker.wrap(flaky);
  const ledger = createLedger({ dir: mkdtempSync(join(tmpdir(), "l2-")), log: () => {} });
  const bridge = createMaxBridge({
    allowed: new Set([U]), forward: async () => {}, tg: wrapped, reply: async () => ({}), flows: { get: () => null },
    menu: { open: async () => { await wrapped("sendMessage", {}); } }, wizard: {}, ledger, tracker,
    handleUpdate: async () => {}, handleUpdateCheck: async () => {},
    restartAgent: async () => { restarts++; await wrapped("sendMessage", {}); }, log: () => {},
  });
  assert.deepEqual(await bridge.process(msgUpdate("/menu", { mid: "T1" })), { status: "retry", reason: "reply-not-delivered" });
  assert.deepEqual(await bridge.process(msgUpdate("/restart", { mid: "T2" })), { status: "retry", reason: "reply-not-delivered" });
  assert.equal(restarts, 1);
  await bridge.process(msgUpdate("/restart", { mid: "T2" })); // повторная доставка
  assert.equal(restarts, 1, "the restart must not run again");
});

test("idempotency classification: only navigation / cancel / wizard steps may be re-run", () => {
  for (const d of ["iva_menu:r:o", "iva_menu:srch:pg:2", "iva_menu:st:rf", "iva_menu:r:x", "iva_menu:mdl", "iva_model:cancel", "iva_model:prov:ollama", "iva_model:m:3", "iva_think:eff:high", "iva_model:rs:later", "iva_update:skip"]) {
    assert.equal(isIdempotentCallback(d), true, d);
  }
  for (const d of ["iva_update:do", "iva_model:rs:now", "iva_menu:svc:apply", "iva_menu:core:fin", "iva_menu:lang:set:en", "iva_menu:gws:go"]) {
    assert.equal(isIdempotentCallback(d), false, d);
  }
});
