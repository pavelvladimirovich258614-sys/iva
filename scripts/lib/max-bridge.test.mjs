import test from "node:test";
import assert from "node:assert/strict";
import { createMaxTg, toMaxKeyboard } from "./max-tg.mjs";
import { createMaxBridge, toCallback, toMsg } from "./max-bridge-core.mjs";
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
function rig({ allowed = new Set([U]), pending = null, forwardFails = false } = {}) {
  const log = [];
  const forwarded = [];
  const mk = (name) => async (...a) => { log.push([name, ...a]); return true; };
  const flows = {
    get: (chat, user) => (pending && String(chat) === U && String(user) === U ? pending : null),
    end: async (...a) => { log.push(["flows.end", a[1]]); },
  };
  const bridge = createMaxBridge({
    allowed,
    forward: async (u) => { if (forwardFails) throw new Error("down"); forwarded.push(u); },
    tg: async (...a) => { log.push(["tg", ...a]); return { ok: true }; },
    reply: mk("reply"),
    menu: { open: mk("menu.open"), onCallback: mk("menu.onCallback"), onText: mk("menu.onText") },
    wizard: { handleModelCmd: mk("wiz.model"), handleThinkCmd: mk("wiz.think"), handleWizardCallback: mk("wiz.cb"), handleKeyMessage: mk("wiz.key") },
    flows,
    handleUpdate: mk("update.cb"),
    handleUpdateCheck: mk("update.check"),
    restartAgent: mk("restart"),
    rememberDialog: (u, c) => log.push(["dialog", u, c]),
    log: () => {},
  });
  return { bridge, log, forwarded };
}
const names = (log) => log.map((l) => l[0]);

test("plain text, /new, /stop, /help, /usage, /tasks are forwarded to the agent channel — not handled locally", async () => {
  const r = rig();
  for (const t of ["hello", "/new", "/stop", "/help", "/usage week", "/tasks", "/task buy milk", "/digest"]) {
    assert.equal(await r.bridge.handleUpdate(msgUpdate(t)), "forwarded", t);
  }
  assert.equal(r.forwarded.length, 8);
  assert.equal(r.forwarded[0].message.sender.user_id, U); // int64 как строка, без потери точности
});

test("control commands are served by the bridge and never reach the agent", async () => {
  const r = rig();
  for (const [t, expected] of [["/menu", "menu.open"], ["/model", "wiz.model"], ["/think", "wiz.think"], ["/update", "update.check"], ["/restart", "restart"]]) {
    r.log.length = 0;
    assert.equal(await r.bridge.handleUpdate(msgUpdate(t)), "handled");
    assert.ok(names(r.log).includes(expected), `${t} → ${expected}`);
  }
  assert.equal(r.forwarded.length, 0);
});

test("strangers: nothing is handled or forwarded (messages and button taps)", async () => {
  const r = rig({ allowed: new Set(["1"]) });
  assert.equal(await r.bridge.handleUpdate(msgUpdate("/menu")), "denied");
  assert.equal(await r.bridge.handleUpdate(msgUpdate("secret question")), "denied");
  assert.equal(await r.bridge.handleUpdate(cbUpdate("iva_menu:r:o")), "denied");
  assert.equal(r.forwarded.length, 0);
  assert.ok(!names(r.log).some((n) => n.startsWith("menu") || n.startsWith("wiz")));
  const empty = rig({ allowed: new Set() });
  assert.equal(await empty.bridge.handleUpdate(msgUpdate("hi")), "denied");
});

test("button taps are routed by payload prefix; unknown payloads are just acknowledged", async () => {
  const r = rig();
  await r.bridge.handleUpdate(cbUpdate("iva_menu:srch:o"));
  await r.bridge.handleUpdate(cbUpdate("iva_model:chg"));
  await r.bridge.handleUpdate(cbUpdate("iva_think:cancel"));
  await r.bridge.handleUpdate(cbUpdate("iva_update:do"));
  assert.deepEqual(names(r.log).filter((n) => !["tg", "dialog"].includes(n)), ["menu.onCallback", "wiz.cb", "wiz.cb", "update.cb"]);
  r.log.length = 0;
  await r.bridge.handleUpdate(cbUpdate("something-else"));
  assert.deepEqual(r.log.map((l) => [l[0], l[1]]), [["tg", "answerCallbackQuery"]]);
  const cq = toCallback(cbUpdate("iva_menu:r:o"));
  assert.deepEqual([cq.id, cq.from.id, cq.message.message_id, cq.message.chat.id, cq.data], ["cb-1", U, "menu-mid", U, "iva_menu:r:o"]);
});

test("a pending secret prompt captures the next message (never forwarded); a command cancels the wait", async () => {
  const menuPending = { flow: "menu", awaitText: { kind: "apikey", secret: true } };
  const r = rig({ pending: menuPending });
  assert.equal(await r.bridge.handleUpdate(msgUpdate("sk-very-secret-key-123456")), "handled");
  assert.ok(names(r.log).includes("menu.onText"));
  assert.equal(r.forwarded.length, 0);

  const wiz = rig({ pending: { flow: "model", awaitText: { kind: "apikey", secret: true } } });
  await wiz.bridge.handleUpdate(msgUpdate("sk-another-secret-key"));
  assert.ok(names(wiz.log).includes("wiz.key"));
  assert.equal(wiz.forwarded.length, 0);

  const cancel = rig({ pending: menuPending });
  assert.equal(await cancel.bridge.handleUpdate(msgUpdate("/new")), "forwarded"); // ожидание снято, команда пошла в канал
  assert.ok(names(cancel.log).includes("flows.end"));
});

test("groups / channel posts / non-dialog are not handled locally (channel ignores them)", async () => {
  const r = rig();
  assert.equal(await r.bridge.handleUpdate(msgUpdate("/menu", { chatType: "chat" })), "forwarded");
  assert.equal(toMsg(msgUpdate("x", { chatType: "channel" })), null);
  assert.equal(r.log.filter((l) => l[0] === "menu.open").length, 0);
});

test("dialog chat_id is remembered when present, nullable chat_id is tolerated", async () => {
  const r = rig();
  await r.bridge.handleUpdate(msgUpdate("/menu"));
  assert.deepEqual(r.log.find((l) => l[0] === "dialog"), ["dialog", U, "-55"]);
  const r2 = rig();
  await r2.bridge.handleUpdate(msgUpdate("/menu", { chatId: null }));
  assert.equal(r2.log.filter((l) => l[0] === "dialog").length, 0);
  assert.ok(names(r2.log).includes("menu.open"));
});

test("bot_started goes to the channel; other update types are ignored; forward failure is surfaced for retry", async () => {
  const r = rig();
  assert.equal(await r.bridge.handleUpdate({ update_type: "bot_started", timestamp: 1, chat_id: 5, user: { user_id: U } }), "forwarded");
  assert.equal(await r.bridge.handleUpdate({ update_type: "message_edited", timestamp: 1 }), "ignored");
  const bad = rig({ forwardFails: true });
  await assert.rejects(() => bad.bridge.handleUpdate(msgUpdate("hello")), /down/);
});

test("a throwing menu screen does not crash the bridge or leak to the agent", async () => {
  const r = rig();
  const orig = createMaxBridge;
  const bridge = createMaxBridge({
    allowed: new Set([U]), forward: async () => { throw new Error("must not forward"); }, tg: async () => ({ ok: true }), reply: async () => {},
    menu: { open: async () => { throw new Error("screen exploded"); }, onCallback: async () => { throw new Error("x"); }, onText: async () => {} },
    wizard: { handleModelCmd: async () => {}, handleThinkCmd: async () => {}, handleWizardCallback: async () => { throw new Error("y"); }, handleKeyMessage: async () => {} },
    flows: { get: () => null, end: async () => {} }, handleUpdate: async () => {}, handleUpdateCheck: async () => {}, restartAgent: async () => {}, log: () => {},
  });
  assert.equal(await bridge.handleUpdate(msgUpdate("/menu")), "handled");
  assert.equal(await bridge.handleUpdate(cbUpdate("iva_menu:r:o")), "handled");
  assert.equal(await bridge.handleUpdate(cbUpdate("iva_model:chg")), "handled");
});
