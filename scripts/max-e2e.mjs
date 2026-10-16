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
  const received = []; // {query, auth, text}
  const state = { failNext: 0, status: 500 };
  const server = createHttp(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const url = new URL(req.url, "http://x");
    if (req.method === "POST" && url.pathname === "/messages") {
      if (state.failNext > 0) { state.failNext--; res.writeHead(state.status); res.end("{}"); return; }
      received.push({ query: url.search, auth: req.headers.authorization, text: JSON.parse(Buffer.concat(chunks).toString()).text });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: { body: { mid: "m", seq: 1 } } }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { received, state, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
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
    console.log(`max e2e: OK (model requests: ${openai.requests.length}, MAX messages: ${maxApi.received.length})`);
  } catch (err) {
    console.error(`max e2e FAILED at phase "${phase}": ${err?.message ?? err}`);
    for (const l of logs.slice(-100)) console.error(l);
    process.exitCode = 1;
  } finally {
    await stopEve(eve); await openai.close(); await maxApi.close();
    if (process.env.REPLICA_KEEP === "1") console.error(`sandbox kept: ${sandbox}`);
    else await rm(sandbox, { recursive: true, force: true });
  }
}
await main();
