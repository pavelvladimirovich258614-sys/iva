import test from "node:test";
import assert from "node:assert/strict";
import { MAX_SECRET_RE, peekMaxUsers, setupMaxChannel, validateMaxToken, validateWebhookUrl } from "./max-setup.mjs";
import { channelServices, configuredChannels, unusedBridgeUnits, channelLabel } from "./channels.mjs";

const C = { g: "", y: "", c: "", b: "", r: "", x: "" };
const t = (en) => en;

function mockMax({ updates = [], meStatus = 200, isBot = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(String(url));
    calls.push({ path: u.pathname, search: u.search, auth: init?.headers?.authorization });
    if (u.pathname === "/me") {
      if (meStatus !== 200) return new Response('{"code":"verify.token"}', { status: meStatus });
      return new Response(JSON.stringify({ user_id: 77, first_name: "Iva", username: "iva_bot", is_bot: isBot }));
    }
    if (u.pathname === "/updates") return new Response(JSON.stringify({ updates, marker: 5 }));
    return new Response("{}", { status: 404 });
  };
  return { fetchImpl, calls };
}
const upd = (id, extra = {}) => ({
  update_type: "message_created",
  timestamp: 1,
  message: { sender: { user_id: id, first_name: "Ann", is_bot: false, ...extra }, recipient: { chat_type: "dialog", chat_id: 1 }, timestamp: 1, body: { mid: "m", seq: 1, text: "hi" } },
});

function io(answers, out = []) {
  const queue = [...answers];
  const next = async () => {
    if (queue.length === 0) throw new Error("scripted answers exhausted (wizard asked more than expected)");
    return queue.shift();
  };
  return {
    ask: async (_q, def = "") => (await next()) || def,
    askRequired: async (_q, { validate, existing }) => {
      for (;;) {
        const a = (await next()) || existing;
        if (!validate || !(await validate(a))) return a;
      }
    },
    say: (m) => out.push(m),
    C,
    t,
  };
}

test("token validation: bot token ok, 401 rejected, non-bot rejected", async () => {
  const mk = (m) => ({ getMe: async () => { const r = await m.fetchImpl("https://x/me", { headers: {} }); const j = await r.json(); if (!r.ok) throw Object.assign(new Error("HTTP"), { status: r.status }); return { userId: String(j.user_id), username: j.username, isBot: j.is_bot }; } });
  assert.deepEqual(await validateMaxToken(mk(mockMax())), { ok: true, username: "iva_bot", userId: "77" });
  assert.equal((await validateMaxToken(mk(mockMax({ meStatus: 401 })))).ok, false);
  assert.equal((await validateMaxToken(mk(mockMax({ isBot: false })))).ok, false);
});

test("peekMaxUsers lists only humans from private dialogs, deduplicated, keeps int64 ids exact", async () => {
  const m = mockMax({ updates: [
    upd(9007199254740993123),
    upd(9007199254740993123),
    upd(5, { is_bot: true }),
    { update_type: "message_created", timestamp: 1, message: { sender: { user_id: 6, first_name: "G" }, recipient: { chat_type: "chat", chat_id: 2 }, body: { mid: "x", seq: 1, text: "g" } } },
    { update_type: "bot_started", timestamp: 1, chat_id: 3, user: { user_id: 8, first_name: "Bo", is_bot: false } },
  ] });
  const { createMaxClient } = await import("../../agent/lib/max-api.ts");
  // числа > 2^53 приходят в JSON числами — как у настоящего MAX
  const raw = JSON.stringify({ updates: [], marker: 1 });
  const fetchImpl = async (url) => new Response(String(url).includes("/updates")
    ? '{"updates":[{"update_type":"message_created","timestamp":1,"message":{"sender":{"user_id":9007199254740993123,"first_name":"Ann","is_bot":false},"recipient":{"chat_type":"dialog","chat_id":1},"body":{"mid":"m","seq":1,"text":"hi"}}},{"update_type":"bot_started","timestamp":1,"chat_id":3,"user":{"user_id":8,"first_name":"Bo","is_bot":false}}],"marker":2}'
    : raw);
  const users = await peekMaxUsers(createMaxClient({ token: "t", baseUrl: "https://x", fetchImpl }));
  assert.deepEqual(users.map((u) => u.id), ["9007199254740993123", "8"]);
  void m;
});

test("setup step writes MAX settings: validated token, random valid secret, discovered id, poll ingest", async () => {
  const m = mockMax({ updates: [upd(41)] });
  const out = {};
  const lines = [];
  const r = await setupMaxChannel({ io: io(["tok-123", "", "", ""], lines), existing: {}, out, fetchImpl: m.fetchImpl, env: { MAX_API_BASE_URL: "http://127.0.0.1:1" } });
  assert.equal(out.MAX_BOT_TOKEN, "tok-123");
  assert.equal(out.MAX_BOT_USERNAME, "iva_bot");
  assert.match(out.MAX_WEBHOOK_SECRET, MAX_SECRET_RE);
  assert.equal(out.MAX_ALLOWED_USER_IDS, "41");
  assert.equal(out.MAX_INGEST, "poll");
  assert.deepEqual(r.ids, ["41"]);
  assert.ok(m.calls.every((c) => c.auth === "tok-123"), "token only in the Authorization header");
  assert.ok(!lines.join("\n").includes("tok-123"), "token is never echoed");
  assert.ok(m.calls.some((c) => c.path === "/updates" && !c.search.includes("marker")), "peek must not commit updates");
});

test("setup step keeps an existing valid secret, asks again for a rejected token, accepts a manual id", async () => {
  const m = mockMax({ updates: [] });
  const out = {};
  // 1й токен будет отвергнут (401) — второй принят; ids: Enter (ничего не найдено) → ручной ввод
  let n = 0;
  const fetchImpl = async (url, init) => {
    if (new URL(String(url)).pathname === "/me" && init?.headers?.authorization === "bad") return new Response("{}", { status: 401 });
    n++;
    return m.fetchImpl(url, init);
  };
  const existing = { MAX_WEBHOOK_SECRET: "kept-secret_123", MAX_INGEST: "webhook", MAX_WEBHOOK_URL: "https://iva.example.com/max/webhook" };
  await setupMaxChannel({ io: io(["bad", "good", "", "12345", "", ""]), existing, out, fetchImpl, env: { MAX_API_BASE_URL: "http://127.0.0.1:1" } });
  assert.equal(out.MAX_BOT_TOKEN, "good");
  assert.equal(out.MAX_WEBHOOK_SECRET, "kept-secret_123");
  assert.equal(out.MAX_INGEST, "webhook");
  assert.equal(out.MAX_ALLOWED_USER_IDS, "12345");
  assert.ok(n > 0);
});

test("manual id input ignores non-numeric garbage and never leaves the allowlist empty", async () => {
  const m = mockMax({ updates: [] });
  const out = {};
  await setupMaxChannel({ io: io(["tok", "", "abc, ", "", "777", ""]), existing: {}, out, fetchImpl: m.fetchImpl, env: { MAX_API_BASE_URL: "http://127.0.0.1:1" } });
  assert.equal(out.MAX_ALLOWED_USER_IDS, "777");
});

// ---- выбор каналов и сервисов ---------------------------------------------------------
test("MAX-only: no telegram-poll, no Telegram variables required", () => {
  const env = { IVA_CHANNELS: "max", MAX_BOT_TOKEN: "t", MAX_WEBHOOK_SECRET: "s", TELEGRAM_BOT_TOKEN: "", TELEGRAM_ALLOWED_USER_IDS: "" };
  assert.deepEqual(channelServices(env), ["iva.service", "iva-max-bridge.service"]);
  assert.deepEqual(unusedBridgeUnits(env), ["iva-telegram-poll.service"]);
  assert.equal(channelLabel(env), "MAX");
});

test("explicit IVA_CHANNELS wins over leftover tokens (Telegram can be re-enabled later)", () => {
  const env = { IVA_CHANNELS: "max", MAX_BOT_TOKEN: "t", MAX_WEBHOOK_SECRET: "s", TELEGRAM_BOT_TOKEN: "123:abc" };
  assert.equal(configuredChannels(env).telegram, false);
  assert.deepEqual(channelServices({ ...env, IVA_CHANNELS: "max,telegram" }), ["iva.service", "iva-telegram-poll.service", "iva-max-bridge.service"]);
});

test("legacy installs without IVA_CHANNELS are inferred from tokens; webhook ingest also runs the bridge; empty config stays legacy", () => {
  assert.deepEqual(channelServices({ TELEGRAM_BOT_TOKEN: "123:abc" }), ["iva.service", "iva-telegram-poll.service"]);
  assert.deepEqual(channelServices({ MAX_BOT_TOKEN: "t", MAX_WEBHOOK_SECRET: "s" }), ["iva.service", "iva-max-bridge.service"]);
  assert.deepEqual(channelServices({ IVA_CHANNELS: "max", MAX_BOT_TOKEN: "t", MAX_WEBHOOK_SECRET: "s", MAX_INGEST: "webhook" }), ["iva.service", "iva-max-bridge.service"]); // мост принимает и webhook
  assert.deepEqual(channelServices({}), ["iva.service", "iva-telegram-poll.service"]);
  assert.equal(configuredChannels({ IVA_CHANNELS: "garbage" }).telegram, true); // unknown value → inferred (legacy default)
});

test("webhook choice: asks for a public HTTPS URL, rejects unsafe ones, stores it, never registers anything", async () => {
  const m = mockMax({ updates: [upd(41)] });
  const out = {};
  const lines = [];
  // токен; Done; выбрать все; доставка=2; плохие адреса; хороший
  await setupMaxChannel({
    io: io(["tok", "", "", "2", "http://x.example/max/webhook", "https://localhost/max/webhook", "https://iva.example.com:8443/x", "https://iva.example.com/max/webhook"], lines),
    existing: {}, out, fetchImpl: m.fetchImpl, env: { MAX_API_BASE_URL: "http://127.0.0.1:1" },
  });
  assert.equal(out.MAX_INGEST, "webhook");
  assert.equal(out.MAX_WEBHOOK_URL, "https://iva.example.com/max/webhook");
  assert.ok(lines.join("\n").includes("iva max webhook set https://iva.example.com/max/webhook"));
  assert.ok(!m.calls.some((c) => c.path === "/subscriptions"), "the wizard must not touch subscriptions");
});

test("polling choice clears a stale webhook URL", async () => {
  const m = mockMax({ updates: [upd(41)] });
  const out = {};
  await setupMaxChannel({ io: io(["tok", "", "", "1"]), existing: { MAX_INGEST: "webhook", MAX_WEBHOOK_URL: "https://old.example/x" }, out, fetchImpl: m.fetchImpl, env: { MAX_API_BASE_URL: "http://127.0.0.1:1" } });
  assert.equal(out.MAX_INGEST, "poll");
  assert.equal(out.MAX_WEBHOOK_URL, "");
});

test("webhook URL validation", () => {
  assert.equal(validateWebhookUrl("https://iva.example.com/max/webhook"), "https://iva.example.com/max/webhook");
  assert.equal(validateWebhookUrl("https://iva.example.com:443/max/webhook"), "https://iva.example.com/max/webhook");
  for (const bad of ["http://iva.example.com/x", "https://iva.example.com/", "https://iva.example.com:8443/x", "https://u:p@iva.example.com/x", "https://iva.example.com/x?token=1", "https://127.0.0.1/x", "https://192.168.1.2/x", "https://localhost/x", "nonsense"]) {
    assert.throws(() => validateWebhookUrl(bad), undefined, bad);
  }
});
