// E2E канала MAX на РЕАЛЬНО собранном eve: build → eve start → webhook → mock-провайдер модели →
// mock MAX API. Токенов и сети нет: всё на 127.0.0.1. Запуск: npm run test:max-e2e.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile, cp, readFile } from "node:fs/promises";
import { createServer as createHttp } from "node:http";
import { createServer as createNet } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMockOpenAiServer } from "./lib/mock-openai-server.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SECRET = "e2e-secret_value-123";
const TOKEN = "e2e-max-token";
const USER = "9007199254740993123"; // > 2^53: проверяет int64 end-to-end
const CHAT = "-4242";
const logs = [];
const note = (l) => { logs.push(l); if (logs.length > 300) logs.shift(); };
let phase = "prepare";
const setPhase = (p) => { phase = p; note(`[e2e] phase: ${p}`); };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, what, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await sleep(100); }
  throw new Error(`timeout waiting for: ${what}`);
}
const assert = (c, m) => { if (!c) throw new Error(`assertion failed: ${m}`); };

function freePort() {
  return new Promise((res, rej) => {
    const s = createNet();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}

// --- mock MAX API ---------------------------------------------------------------------
async function startMockMax() {
  const received = []; // POST /messages: {query, auth, text, body}
  const edits = []; // PUT /messages
  const answers = []; // POST /answers
  const deletes = [];
  const commands = []; // PATCH /me/commands
  const updates = []; // очередь для GET /updates: {seq, update}
  const polls = []; // marker, с которым приходил мост
  const state = { failNext: 0, status: 500, seq: 0, mid: 0, committed: 0 };
  const server = createHttp(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    const url = new URL(req.url, "http://x");
    const json = (obj, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    const auth = req.headers.authorization;
    if (auth !== TOKEN) return json({ code: "verify.token", message: "bad token" }, 401);
    if (req.method === "POST" && url.pathname === "/messages") {
      if (state.failNext > 0) { state.failNext--; res.writeHead(state.status); res.end("{}"); return; }
      const body = JSON.parse(raw);
      const mid = `mid-${++state.mid}`;
      received.push({ query: url.search, auth, text: body.text, body, mid });
      return json({ message: { body: { mid, seq: state.mid } } });
    }
    if (req.method === "PUT" && url.pathname === "/messages") { edits.push({ mid: url.searchParams.get("message_id"), body: JSON.parse(raw) }); return json({ success: true }); }
    if (req.method === "DELETE" && url.pathname === "/messages") { deletes.push(url.searchParams.get("message_id")); return json({ success: true }); }
    if (req.method === "POST" && url.pathname === "/answers") { answers.push({ id: url.searchParams.get("callback_id"), body: JSON.parse(raw || "{}") }); return json({ success: true }); }
    if (req.method === "PATCH" && url.pathname === "/me/commands") { commands.push(...(JSON.parse(raw).commands ?? [])); return json({ commands }); }
    if (req.method === "GET" && url.pathname === "/me") return json({ user_id: 999, first_name: "Iva", username: "iva_test_bot", is_bot: true });
    if (req.method === "GET" && url.pathname === "/subscriptions") return json({ subscriptions: [] });
    if (req.method === "GET" && url.pathname === "/updates") {
      const m = url.searchParams.get("marker");
      if (m) state.committed = Math.max(state.committed, Number(m));
      polls.push(m);
      const from = m ? Number(m) : state.committed;
      const deadline = Date.now() + 1500;
      let batch = updates.filter((u) => u.seq >= from);
      while (batch.length === 0 && Date.now() < deadline) { await sleep(50); batch = updates.filter((u) => u.seq >= from); }
      const next = batch.length ? batch[batch.length - 1].seq + 1 : from || 1;
      // int64 как число в JSON — так отдаёт настоящий MAX
      return res.writeHead(200, { "content-type": "application/json" }), res.end(`{"updates":${toWire(batch.map((u) => u.update))},"marker":${next}}`);
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    received, edits, answers, deletes, commands, polls, state,
    push: (update) => updates.push({ seq: ++state.seq, update }),
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

function startEve({ app, env, port }) {
  const child = spawn(process.execPath, [join(app, "node_modules/eve/bin/eve.js"), "start", "--host", "127.0.0.1", "--port", String(port)],
    { cwd: app, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const cap = (b) => String(b).split("\n").filter(Boolean).forEach(note);
  child.stdout.on("data", cap); child.stderr.on("data", cap);
  return child;
}
async function stopEve(child) {
  if (!child || child.exitCode !== null) return;
  const gone = new Promise((r) => child.once("exit", r));
  try { process.kill(-child.pid, "SIGTERM"); } catch { return; }
  if ((await Promise.race([gone, sleep(15_000).then(() => "t")])) === "t") { try { process.kill(-child.pid, "SIGKILL"); } catch {} await gone; }
}
function startBridge({ app, env }) {
  const child = spawn(process.execPath, [join(app, "scripts/max-bridge.mjs")], { cwd: app, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const cap = (b) => String(b).split("\n").filter(Boolean).forEach((l) => note(`[bridge] ${l}`));
  child.stdout.on("data", cap); child.stderr.on("data", cap);
  return child;
}
function run(cmd, args, opts) {
  return new Promise((res, rej) => {
    const c = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    const cap = (b) => String(b).split("\n").filter(Boolean).forEach(note);
    c.stdout.on("data", cap); c.stderr.on("data", cap);
    c.on("exit", (code) => (code === 0 ? res() : rej(new Error(`${cmd} ${args.join(" ")} exited ${code}`))));
  });
}

const msg = ({ text, mid, userId = USER, chatId = CHAT, chatType = "dialog" }) => ({
  update_type: "message_created", timestamp: Date.now(),
  message: {
    sender: { user_id: userId, first_name: "T", is_bot: false },
    recipient: { chat_type: chatType, chat_id: chatId, user_id: null },
    timestamp: Date.now(), body: { mid, seq: 1, text },
  },
});
// int64 в JSON-числах, как у настоящего MAX (строкой его не шлют)
const toWire = (u) => JSON.stringify(u).replace(/"(user_id|chat_id)":"(-?\d+)"/g, '"$1":$2');

async function main() {
  const sandbox = await mkdtemp(join(tmpdir(), "iva-max-e2e-"));
  const openai = await startMockOpenAiServer();
  const maxApi = await startMockMax();
  let eve = null;
  let bridge = null;
  try {
    const app = join(sandbox, "app");
    await mkdir(join(app, "data"), { recursive: true });
    for (const d of ["agent", "scripts", "patches", "vault-template"]) await cp(join(ROOT, d), join(app, d), { recursive: true });
    for (const f of ["package.json", "package-lock.json", "tsconfig.json"]) await cp(join(ROOT, f), join(app, f));
    await symlink(join(ROOT, "node_modules"), join(app, "node_modules"), "dir");
    const port = await freePort();
    const env = {
      PATH: process.env.PATH, HOME: sandbox, NODE_ENV: "production", PORT: String(port), IVA_PORT: String(port),
      MODEL_PROVIDER: "ollama", OLLAMA_BASE_URL: openai.baseUrl, OLLAMA_API_KEY: "k", OLLAMA_MODEL: "iva-replica", OLLAMA_CONTEXT_WINDOW: "131072",
      ASSISTANT_BEARER: "e2e-bearer", ASSISTANT_DATA_DIR: join(app, "data"), ASSISTANT_VAULT_DIR: join(app, "vault"),
      ASSISTANT_TIMEZONE: "UTC", MEMORY_SEARCH_MODE: "bm25",
      // MAX-only: никаких TELEGRAM_* вообще
      MAX_BOT_TOKEN: TOKEN, MAX_WEBHOOK_SECRET: SECRET, MAX_ALLOWED_USER_IDS: USER,
      MAX_API_BASE_URL: maxApi.url, MAX_OUTBOX_BACKOFF_MS: "300", MAX_MIN_SEND_INTERVAL_MS: "50",
    };
    await writeFile(join(app, ".env"), "ASSISTANT_BEARER=e2e-bearer\n", { mode: 0o600 });
    setPhase("vault");
    await run(process.execPath, [join(app, "scripts/init-vault.mjs")], { cwd: app, env });
    setPhase("build");
    await run(process.execPath, [join(app, "node_modules/eve/bin/eve.js"), "build"], { cwd: app, env });
    setPhase("start");
    eve = startEve({ app, env, port });
    const base = `http://127.0.0.1:${port}`;
    await until(async () => { try { return (await fetch(`${base}/`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } }, "eve health", 90_000);

    const post = (body, headers = { "x-max-bot-api-secret": SECRET }) =>
      fetch(`${base}/eve/v1/max`, { method: "POST", headers, body: typeof body === "string" ? body : toWire(body) });

    setPhase("auth");
    assert((await post(msg({ text: "hi", mid: "a0" }), {})).status === 401, "missing secret must be 401");
    assert((await post(msg({ text: "hi", mid: "a1" }), { "x-max-bot-api-secret": "wrong" })).status === 401, "wrong secret must be 401");
    assert((await post(msg({ text: "hi", mid: "a2", userId: "222" }))).status === 200, "stranger gets silent 200");
    assert((await post(msg({ text: "hi", mid: "a3", chatType: "chat" }))).status === 200, "group ignored");
    await sleep(500);
    assert(maxApi.received.length === 0 && openai.requests.length === 0, "unauthorised/ignored events must not reach agent or MAX");

    setPhase("limits");
    const huge = await fetch(`${base}/eve/v1/max`, { method: "POST", headers: { "x-max-bot-api-secret": SECRET }, body: "x".repeat(400_000) });
    assert(huge.status === 413, `oversized body must be 413, got ${huge.status}`);

    setPhase("round-trip");
    assert((await post(msg({ text: "Reply with a status word.", mid: "m1" }))).status === 200, "webhook ACK");
    await until(() => maxApi.received.length >= 1, "first MAX reply");
    const first = maxApi.received[0];
    assert(first.text === "REPLICA_OK", `reply text: ${first.text}`);
    assert(first.auth === TOKEN, "token must be in Authorization header");
    assert(first.query === `?chat_id=${CHAT}`, `addressing: ${first.query}`);
    assert(!first.query.includes(TOKEN), "token must not be in URL");

    setPhase("dedup");
    const before = openai.requests.length;
    assert((await post(msg({ text: "Reply with a status word.", mid: "m1" }))).status === 200, "dup ACK");
    await sleep(800);
    assert(openai.requests.length === before && maxApi.received.length === 1, "duplicate must not trigger another turn/reply");

    setPhase("session-memory-and-new");
    await post(msg({ text: "Remember this code: CEDAR-7001", mid: "m2" }));
    await until(() => maxApi.received.length >= 2, "REMEMBERED");
    assert(maxApi.received[1].text === "REMEMBERED", "seed reply");
    await post(msg({ text: "What code did I ask you to remember? Reply with the code only.", mid: "m3" }));
    await until(() => maxApi.received.length >= 3, "recall");
    assert(maxApi.received[2].text === "CEDAR-7001", `session kept history: ${maxApi.received[2].text}`);
    await post(msg({ text: "/new", mid: "m4" }));
    await until(() => maxApi.received.length >= 4, "/new confirmation");
    await post(msg({ text: "What code did I ask you to remember? Reply with the code only.", mid: "m5" }));
    await until(() => maxApi.received.length >= 5, "post-/new recall");
    assert(!maxApi.received[4].text.includes("CEDAR-7001"), `/new must retire the MAX session, got ${maxApi.received[4].text}`);

    setPhase("outbox-retry");
    maxApi.state.failNext = 2; maxApi.state.status = 500;
    const n = maxApi.received.length;
    await post(msg({ text: "Reply with a status word.", mid: "m6" }));
    await until(() => maxApi.received.length > n, "reply delivered after 500s (outbox retry)");
    assert(maxApi.received.at(-1).text === "REPLICA_OK", "retried reply text");

    setPhase("restart-durability");
    maxApi.state.failNext = 1000; // MAX «лежит»
    const n2 = maxApi.received.length;
    await post(msg({ text: "Reply with a status word.", mid: "m7" }));
    await sleep(1200);
    const status = await (await fetch(`${base}/eve/v1/max/status`, { headers: { "x-max-bot-api-secret": SECRET } })).json();
    assert(status.queued >= 1, `reply must be queued durably: ${JSON.stringify(status)}`);
    assert((await fetch(`${base}/eve/v1/max/status`)).status === 401, "status requires the secret");
    await stopEve(eve);
    maxApi.state.failNext = 0; // MAX вернулся
    eve = startEve({ app, env, port });
    await until(async () => { try { return (await fetch(`${base}/`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } }, "eve health after restart", 90_000);
    await until(() => maxApi.received.length > n2, "queued reply delivered after restart", 60_000);
    // accepted-события пережили рестарт: повтор m7 не запускает новый ход
    const reqs = openai.requests.length;
    assert((await post(msg({ text: "Reply with a status word.", mid: "m7" }))).status === 200, "dup after restart ACK");
    await sleep(800);
    assert(openai.requests.length === reqs, "event accepted before restart must stay deduplicated");

    const files = JSON.stringify(await readFile(join(app, "data/max/state.json"), "utf8"));
    assert(files.length > 2, "state persisted under data/max");
    // ── фоновые задачи в MAX-only: дайджест и отчёт памяти доставляются в MAX ──
    setPhase("background-jobs");
    const jobEnv = { ...env, ASSISTANT_HOST: base, ASSISTANT_BEARER: "e2e-bearer" };
    const digestBefore = maxApi.received.length;
    await run(process.execPath, [join(app, "scripts/daily-digest.ts")], { cwd: app, env: jobEnv });
    assert(maxApi.received.length === digestBefore + 1, "digest delivered to MAX");
    const dg = maxApi.received.at(-1);
    assert(dg.query === `?user_id=${USER}`, `digest addressed by user_id: ${dg.query}`);
    assert(dg.text === "REPLICA_OK" && dg.body.format === "markdown", "digest text/format");
    const rollBefore = maxApi.received.length;
    await run(process.execPath, [join(app, "scripts/memory/rollup.ts"), "daily"], { cwd: app, env: jobEnv });
    assert(maxApi.received.length === rollBefore + 1, "daily memory report delivered to MAX");
    // и при полном отсутствии канала задачи не падают (память важнее доставки)
    const quietEnv = { ...jobEnv };
    for (const k of ["MAX_BOT_TOKEN", "MAX_ALLOWED_USER_IDS", "MAX_WEBHOOK_SECRET", "IVA_CHANNELS"]) delete quietEnv[k];
    const quietBefore = maxApi.received.length;
    await run(process.execPath, [join(app, "scripts/memory/rollup.ts"), "daily"], { cwd: app, env: quietEnv });
    assert(maxApi.received.length === quietBefore, "no channel → nothing sent, rollup still succeeds");

    // ── MAX-bridge: polling вместо webhook, управление из MAX ──────────────────
    setPhase("bridge-start");
    const callback = (payload, mid, userId = USER, id = `cb-${Math.random().toString(36).slice(2)}`) => ({
      update_type: "message_callback", timestamp: Date.now(),
      callback: { timestamp: Date.now(), callback_id: id, payload, user: { user_id: userId, first_name: "T", is_bot: false } },
      message: { sender: { user_id: "999", first_name: "Iva", is_bot: true }, recipient: { chat_type: "dialog", chat_id: CHAT, user_id: null }, timestamp: Date.now(), body: { mid, seq: 1, text: "m" } },
    });
    const sentCount = () => maxApi.received.length;
    bridge = startBridge({ app, env });
    await until(() => maxApi.commands.length > 0, "bridge registered bot commands");
    assert(maxApi.commands.some((c) => c.name === "menu") && maxApi.commands.some((c) => c.name === "model"), "commands registered");

    setPhase("bridge-text");
    let n3 = sentCount();
    const modelReqs = openai.requests.length;
    maxApi.push(msg({ text: "Reply with a status word.", mid: "br1" }));
    await until(() => sentCount() > n3, "agent reply via bridge");
    assert(maxApi.received.at(-1).text === "REPLICA_OK", "text via bridge reaches the agent and back");
    assert(openai.requests.length === modelReqs + 1, "exactly one model turn");

    setPhase("bridge-stranger");
    // на медленном раннере после ответа могут дойти хвостовые запросы к модели: ждём, пока счётчики устоятся
    for (let last = "", stable = 0; stable < 3; await sleep(700)) {
      const cur = `${sentCount()}/${openai.requests.length}`;
      stable = cur === last ? stable + 1 : 0;
      last = cur;
    }
    n3 = sentCount();
    const reqs2 = openai.requests.length;
    maxApi.push(msg({ text: "/menu", mid: "br2", userId: "222" }));
    maxApi.push(msg({ text: "hello agent", mid: "br3", userId: "222" }));
    await sleep(2500);
    assert(sentCount() === n3 && openai.requests.length === reqs2, `strangers get nothing through the bridge (sent ${n3}->${sentCount()}, model requests ${reqs2}->${openai.requests.length}, last: ${JSON.stringify(maxApi.received.at(-1)?.text)})`);

    setPhase("bridge-help-usage");
    n3 = sentCount();
    maxApi.push(msg({ text: "/help", mid: "br4" }));
    await until(() => sentCount() > n3, "/help reply");
    assert(/\/menu/.test(maxApi.received.at(-1).text) && /\/usage/.test(maxApi.received.at(-1).text), `help lists commands: ${maxApi.received.at(-1).text}`);
    assert(openai.requests.length === reqs2, "/help must not spend model tokens");
    n3 = sentCount();
    maxApi.push(msg({ text: "/stop", mid: "br5" }));
    await until(() => sentCount() > n3, "/stop reply");
    assert(/Nothing is running|ничего не выполняется/i.test(maxApi.received.at(-1).text), `stop when idle: ${maxApi.received.at(-1).text}`);
    n3 = sentCount();
    maxApi.push(msg({ text: "/usage", mid: "br6" }));
    await until(() => sentCount() > n3, "/usage reply");
    assert(openai.requests.length === reqs2, "/usage must not spend model tokens");

    setPhase("bridge-menu");
    n3 = sentCount();
    maxApi.push(msg({ text: "/menu", mid: "br7" }));
    await until(() => sentCount() > n3, "/menu reply");
    const menuMsg = maxApi.received.at(-1);
    const kb = menuMsg.body.attachments?.[0];
    assert(kb?.type === "inline_keyboard", "menu carries a MAX inline keyboard");
    const buttons = kb.payload.buttons.flat();
    assert(buttons.every((b) => b.type === "callback" && b.payload.length <= 1024 && b.text.length <= 128), "valid callback buttons");
    assert(buttons.some((b) => b.payload === "iva_menu:mdl"), "Model button");
    assert(!buttons.some((b) => /userbot|ub:o/i.test(b.payload + b.text)), "no Telegram userbot entry in MAX menu");
    assert(menuMsg.query === `?chat_id=${CHAT}`, `menu addressed to the dialog: ${menuMsg.query}`);

    setPhase("bridge-callbacks");
    const e0 = maxApi.edits.length;
    maxApi.push(callback("iva_menu:st:o", menuMsg.mid, USER, "cb-status"));
    await until(() => maxApi.edits.length > e0, "menu screen edited in place");
    assert(maxApi.edits.at(-1).mid === menuMsg.mid, "edit targets the menu message");
    assert(maxApi.answers.some((a) => a.id === "cb-status"), "callback acknowledged via /answers");
    const e1 = maxApi.edits.length;
    maxApi.push(callback("iva_menu:mdl", menuMsg.mid, USER, "cb-model"));
    await until(() => maxApi.edits.length > e1, "model wizard handed off");
    assert(/provider|провайдер/i.test(maxApi.edits.at(-1).body.text), `wizard intro: ${maxApi.edits.at(-1).body.text}`);
    const e2 = maxApi.edits.length;
    maxApi.push(callback("iva_model:cancel", menuMsg.mid, USER, "cb-cancel"));
    await until(() => maxApi.edits.length > e2, "wizard cancelled");
    assert(/Cancelled|Отменено/.test(maxApi.edits.at(-1).body.text), "wizard cancel text");
    const e3 = maxApi.edits.length;
    maxApi.push(callback("iva_menu:st:o", menuMsg.mid, "222", "cb-stranger"));
    await sleep(2500);
    assert(maxApi.edits.length === e3, "stranger button taps are ignored");

    setPhase("bridge-restart-no-replay");
    const snap = { sent: sentCount(), reqs: openai.requests.length };
    await stopEve(bridge);
    maxApi.push(msg({ text: "Reply with a status word.", mid: "br8" })); // пришло, пока моста нет
    bridge = startBridge({ app, env });
    await until(() => sentCount() > snap.sent, "message sent while bridge was down is delivered after restart");
    await sleep(2500);
    assert(sentCount() === snap.sent + 1 && openai.requests.length === snap.reqs + 1, "no replay of already committed updates, no loss of the pending one");
    await stopEve(bridge);

    setPhase("bridge-agent-down");
    // агент недоступен → мост не теряет событие и не двигает маркер дальше
    await stopEve(eve);
    bridge = startBridge({ app, env });
    const lost = { sent: sentCount() };
    maxApi.push(msg({ text: "Reply with a status word.", mid: "br9" }));
    await sleep(4000);
    assert(sentCount() === lost.sent, "nothing delivered while the agent is down");
    eve = startEve({ app, env, port });
    await until(async () => { try { return (await fetch(`${base}/`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } }, "eve health after bridge test", 90_000);
    await until(() => sentCount() > lost.sent, "event delivered once the agent is back", 60_000);
    await stopEve(bridge);

    console.log(`max e2e: OK (model requests: ${openai.requests.length}, MAX messages: ${maxApi.received.length})`);
  } catch (err) {
    console.error(`max e2e FAILED at phase "${phase}": ${err?.message ?? err}`);
    for (const l of logs.slice(-100)) console.error(l);
    process.exitCode = 1;
  } finally {
    await stopEve(bridge); await stopEve(eve); await openai.close(); await maxApi.close();
    if (process.env.REPLICA_KEEP === "1") console.error(`sandbox kept: ${sandbox}`);
    else await rm(sandbox, { recursive: true, force: true });
  }
}
await main();
