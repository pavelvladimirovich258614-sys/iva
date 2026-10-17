import test from "node:test";
import assert from "node:assert/strict";
import { notifyTarget, notifyConfigured, maxRecipient, sendReport, sendNotice, sendUpdateOfferVia } from "./notify.mjs";
import { updateOffer } from "./update-check.mjs";

const MAX_ENV = { MAX_BOT_TOKEN: "tok", MAX_ALLOWED_USER_IDS: "9007199254740993123, 5", MAX_API_BASE_URL: "http://127.0.0.1:1" };
const noSleep = async () => {};

function mockFetch(script) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : null });
    const r = script.shift() ?? { status: 200, body: '{"message":{"body":{"mid":"m1"}}}' };
    if (r instanceof Error) throw r;
    return new Response(r.body ?? "{}", { status: r.status, headers: r.headers });
  };
  return { fn, calls };
}

test("MAX-only env (all TELEGRAM_* empty) is fully configured, Telegram absent", () => {
  const env = { ...MAX_ENV, TELEGRAM_BOT_TOKEN: "", TELEGRAM_ALLOWED_USER_IDS: "", TELEGRAM_DIGEST_CHAT_ID: "" };
  assert.deepEqual(notifyTarget(env), { channel: "max", token: "tok", userId: "9007199254740993123" });
  assert.equal(notifyConfigured(env), true);
});

test("nothing configured is a quiet 'not configured', never an exception", async () => {
  for (const env of [{}, { TELEGRAM_BOT_TOKEN: "" }, { MAX_BOT_TOKEN: "t" }, { MAX_ALLOWED_USER_IDS: "1" }]) {
    assert.equal(notifyConfigured(env), false);
    const r = await sendReport("hi", { env });
    assert.deepEqual([r.ok, r.configured, r.channel], [false, false, null]);
  }
});

test("channel selection: auto prefers MAX, explicit overrides, none disables", () => {
  const both = { ...MAX_ENV, TELEGRAM_BOT_TOKEN: "t", TELEGRAM_DIGEST_CHAT_ID: "7" };
  assert.equal(notifyTarget(both).channel, "max");
  assert.equal(notifyTarget({ ...both, NOTIFY_CHANNEL: "telegram" }).channel, "telegram");
  assert.equal(notifyTarget({ ...both, NOTIFY_CHANNEL: "none" }).channel, null);
  assert.equal(notifyTarget({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_DIGEST_CHAT_ID: "7" }).channel, "telegram"); // legacy installs keep working
  assert.equal(notifyTarget({ ...MAX_ENV, NOTIFY_CHANNEL: "telegram" }).channel, null);
});

test("recipient: MAX_NOTIFY_USER_ID wins, else first allowed id, ignores junk", () => {
  assert.equal(maxRecipient({ MAX_NOTIFY_USER_ID: "42", MAX_ALLOWED_USER_IDS: "1" }), "42");
  assert.equal(maxRecipient({ MAX_NOTIFY_USER_ID: "x", MAX_ALLOWED_USER_IDS: "abc, 7" }), "7");
  assert.equal(maxRecipient({}), "");
});

test("report goes to MAX by user_id with markdown, token only in header, secrets redacted", async () => {
  const m = mockFetch([]);
  const r = await sendReport("**Digest** sk-abcdefghijklmnopqrstuvwxyz123456", { env: MAX_ENV, fetchImpl: m.fn, sleep: noSleep });
  assert.deepEqual([r.ok, r.channel, r.fellBack], [true, "max", false]);
  assert.equal(m.calls[0].url, "http://127.0.0.1:1/messages?user_id=9007199254740993123");
  assert.equal(m.calls[0].init.headers.authorization, "tok");
  assert.equal(m.calls[0].body.format, "markdown");
  assert.ok(m.calls[0].body.text.includes("[REDACTED]") && !m.calls[0].body.text.includes("sk-abc"));
});

test("markdown rejected with 400 → one plain retry, fellBack=true", async () => {
  const m = mockFetch([{ status: 400, body: '{"code":"proto.payload"}' }, { status: 200 }]);
  const r = await sendReport("# bad **", { env: MAX_ENV, fetchImpl: m.fn, sleep: noSleep });
  assert.deepEqual([r.ok, r.fellBack], [true, true]);
  assert.equal(m.calls.length, 2);
  assert.equal("format" in m.calls[1].body, false);
});

test("429/5xx/network are retried; permanent 403 fails with a diagnosable error, no token", async () => {
  const m = mockFetch([{ status: 429, headers: { "retry-after": "1" } }, { status: 503 }, new TypeError("x"), { status: 200 }]);
  assert.equal((await sendReport("x", { env: MAX_ENV, fetchImpl: m.fn, sleep: noSleep })).ok, true);
  assert.equal(m.calls.length, 4);
  const m2 = mockFetch([{ status: 403, body: '{"code":"chat.denied"}' }]);
  const r = await sendReport("x", { env: MAX_ENV, fetchImpl: m2.fn, sleep: noSleep });
  assert.equal(r.ok, false);
  assert.match(r.error, /403.*chat\.denied/);
  assert.ok(!r.error.includes("tok"));
});

test("long report is split into ≤4000-char messages", async () => {
  const m = mockFetch([]);
  const r = await sendReport("слово ".repeat(2500), { env: MAX_ENV, fetchImpl: m.fn, sleep: noSleep });
  assert.equal(r.ok, true);
  assert.ok(m.calls.length >= 4);
  assert.ok(m.calls.every((c) => c.body.text.length <= 4000));
});

test("notice is plain text", async () => {
  const m = mockFetch([]);
  await sendNotice("vault: 3 problems", { env: MAX_ENV, fetchImpl: m.fn, sleep: noSleep });
  assert.equal("format" in m.calls[0].body, false);
});

test("update offer becomes a MAX inline keyboard with the same callback vocabulary", async () => {
  const m = mockFetch([]);
  await sendUpdateOfferVia({ env: MAX_ENV, offer: updateOffer("0.3.8", "0.4.0", "en"), fetchImpl: m.fn });
  const kb = m.calls[0].body.attachments[0];
  assert.equal(kb.type, "inline_keyboard");
  assert.deepEqual(kb.payload.buttons[0].map((b) => [b.type, b.payload]), [["callback", "iva_update:do"], ["callback", "iva_update:skip"]]);
  await assert.rejects(() => sendUpdateOfferVia({ env: {}, offer: updateOffer("1", "2") }), /not configured/);
});
