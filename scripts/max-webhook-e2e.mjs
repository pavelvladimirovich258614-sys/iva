// E2E режима WEBHOOK на реально собранном Eve (production-топология):
//   MAX → HTTP-приёмник моста (127.0.0.1) → проверка секрета/доступа → команда или callback →
//   управление Ивой (меню, мастер модели, restart/update) ИЛИ канал агента Eve → ответ в MAX.
// Mock MAX моделирует подписку: события идут ровно в один транспорт. Здесь же — переключение
// polling ↔ webhook, повторные доставки, падение процессов и ошибки выполнения.
// Запуск: npm run test:max-webhook-e2e (Node 24). Токенов и внешней сети нет.
import { mkdtemp, readFile, rename, rm, mkdir, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockOpenAiServer } from "./lib/mock-openai-server.mjs";
import {
  assert, callback, freePort, makeFakeBin, msg, prepareApp, run, runAny, sleep, startMockMax, startProc, stopProc, until,
} from "./lib/max-e2e-kit.mjs";

const TOKEN = "e2e-max-token";
const SECRET = "e2e-wh-secret_123";
const USER = "9007199254740993123"; // > 2^53
const CHAT = "-4242";
const WH_URL = "https://iva.example.com/max/webhook";
const logs = [];
const note = (l) => {
  logs.push(l);
  if (logs.length > 400) logs.shift();
};
let phase = "prepare";
const setPhase = (p) => {
  phase = p;
  note(`[e2e] phase: ${p}`);
  console.log(`  · ${p}`);
};

async function main() {
  const sandbox = await mkdtemp(join(tmpdir(), "iva-max-wh-e2e-"));
  const openai = await startMockOpenAiServer();
  const bridgePort = await freePort();
  const evePort = await freePort();
  const maxApi = await startMockMax({ token: TOKEN, webhookTarget: () => `http://127.0.0.1:${bridgePort}/max/webhook` });
  let eve = null;
  let bridge = null;
  const extras = []; // побочные процессы моста (проверки конфликтов) — гасим при любом исходе
  try {
    const app = await prepareApp(sandbox);
    const fake = await makeFakeBin(join(sandbox, "fakebin"));
    const dict = {
      MODEL_PROVIDER: "ollama", OLLAMA_BASE_URL: openai.baseUrl, OLLAMA_API_KEY: "k", OLLAMA_MODEL: "iva-replica", OLLAMA_CONTEXT_WINDOW: "131072",
      IVA_CATALOG_BASE_URL_OLLAMA: openai.baseUrl,
      ASSISTANT_BEARER: "e2e-bearer-".padEnd(48, "x"), ASSISTANT_DATA_DIR: join(app, "data"), ASSISTANT_VAULT_DIR: join(app, "vault"),
      ASSISTANT_TIMEZONE: "UTC", MEMORY_SEARCH_MODE: "bm25", IVA_PORT: String(evePort), PORT: String(evePort),
      IVA_CHANNELS: "max", MAX_BOT_TOKEN: TOKEN, MAX_WEBHOOK_SECRET: SECRET, MAX_ALLOWED_USER_IDS: USER,
      MAX_INGEST: "webhook", MAX_BRIDGE_PORT: String(bridgePort), MAX_API_BASE_URL: maxApi.url,
      MAX_OUTBOX_BACKOFF_MS: "300", MAX_MIN_SEND_INTERVAL_MS: "50", AGENT_LANGUAGE: "en",
    };
    const envFile = Object.entries(dict).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
    await writeFile(join(app, ".env"), envFile, { mode: 0o600 });
    const PATH = `${join(sandbox, "fakebin")}:${process.env.PATH}`;
    const eveEnv = { ...dict, PATH, HOME: sandbox, NODE_ENV: "production" };
    const bridgeEnv = { PATH, HOME: sandbox, NO_COLOR: "1" }; // всё остальное — из .env, как у systemd EnvironmentFile
    const cliEnv = { PATH, HOME: sandbox, NO_COLOR: "1" };
    const iva = (...args) => runAny(process.execPath, [join(app, "bin/iva.mjs"), ...args], { cwd: app, env: cliEnv, note });
    const evePath = join(app, "node_modules/eve/bin/eve.js");
    const startEve = () => startProc(process.execPath, [evePath, "start", "--host", "127.0.0.1", "--port", String(evePort)], { cwd: app, env: eveEnv, note, tag: "eve" });
    const eveHealthy = async () => { try { return (await fetch(`http://127.0.0.1:${evePort}/`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } };
    const startBridge = (extraEnv = {}) => startProc(process.execPath, ["--env-file=.env", "scripts/max-bridge.mjs"], { cwd: app, env: { ...bridgeEnv, ...extraEnv }, note, tag: "bridge" });
    const bridgeUp = async () => { try { return (await fetch(`http://127.0.0.1:${bridgePort}/healthz`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } };
    const bridgeUrl = `http://127.0.0.1:${bridgePort}/max/webhook`;
    const callsLog = async () => (await readFile(fake.calls, "utf8").catch(() => "")).split("\n").filter(Boolean);
    const count = async (re) => (await callsLog()).filter((l) => re.test(l)).length;
    const envNow = () => readFile(join(app, ".env"), "utf8");

    // «Пользователь пишет»: MAX отдаёт событие webhook-у. Возвращает HTTP-статус ответа моста.
    const user = (text, mid, extra = {}) => maxApi.route(msg({ text, mid, userId: USER, chatId: CHAT, ...extra }));
    const lastMsg = () => maxApi.received.at(-1);
    const lastTimeline = () => maxApi.timeline.at(-1);
    const textOf = (t) => t?.body?.text ?? "";
    // Нажатие кнопки, найденной в ПОСЛЕДНЕМ экране так, как это увидел бы пользователь.
    async function press(re, { dupId } = {}) {
      const t = lastTimeline();
      const kb = t?.body?.attachments?.find((a) => a.type === "inline_keyboard");
      const btn = kb?.payload.buttons.flat().find((b) => re.test(b.text));
      assert(btn, `button ${re} not found on the current screen: ${JSON.stringify(kb?.payload.buttons.flat().map((b) => b.text))} / "${textOf(t)}"`);
      const before = maxApi.timeline.length;
      const status = await maxApi.route(callback({ payload: btn.payload, mid: t.mid, userId: USER, chatId: CHAT, id: dupId }));
      assert(status === 200, `callback webhook status ${status}`);
      return { btn, before };
    }
    const pressAndWait = async (re) => {
      const { before } = await press(re);
      await until(() => maxApi.timeline.length > before, `screen update after pressing ${re}`);
    };

    setPhase("build");
    await run(process.execPath, [join(app, "scripts/init-vault.mjs")], { cwd: app, env: eveEnv, note });
    await run(process.execPath, [evePath, "build"], { cwd: app, env: eveEnv, note });

    setPhase("start-eve-and-register-webhook");
    eve = startEve();
    await until(eveHealthy, "eve health", 90_000);
    // Регистрация подписки — явной командой владельца; здесь против mock MAX (URL подписки — «публичный», доставка идёт на loopback-приёмник).
    let r = await iva("max", "webhook", "set", WH_URL, "--yes", "--no-restart");
    assert(r.code === 0, `webhook set failed: ${r.out}`);
    assert(maxApi.subs.length === 1 && maxApi.subs[0].url === WH_URL && maxApi.subs[0].secret === SECRET, "subscription registered with the secret");
    assert(/MAX_INGEST=webhook/.test(await envNow()) && /MAX_WEBHOOK_URL=https:\/\/iva\.example\.com\/max\/webhook/.test(await envNow()), ".env switched to webhook");
    r = await iva("max", "webhook", "set", "http://insecure.example/x", "--yes", "--no-restart");
    assert(r.code !== 0 && /HTTPS/.test(r.out), "plain-http webhook URL must be refused");
    r = await iva("max", "webhook", "set", "https://localhost/max/webhook", "--yes", "--no-restart");
    assert(r.code !== 0, "local webhook host must be refused");
    bridge = startBridge();
    await until(bridgeUp, "bridge webhook listener", 30_000);
    await until(() => maxApi.commands.length > 0, "bot commands registered");
    assert(maxApi.pollLog.length === 0, "webhook mode must never poll");

    setPhase("access-control");
    const raw = (headers, body = "{}", path = "/max/webhook", method = "POST") =>
      fetch(`http://127.0.0.1:${bridgePort}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: method === "POST" ? body : undefined }).then((x) => x.status);
    assert((await raw({})) === 401, "no secret → 401");
    assert((await raw({ "x-max-bot-api-secret": "wrong" })) === 401, "wrong secret → 401");
    assert((await raw({ "x-max-bot-api-secret": SECRET }, "{nope")) === 400, "garbage JSON → 400");
    assert((await raw({ "x-max-bot-api-secret": SECRET }, "{}", "/eve/v1/max")) === 404, "Eve channel path is not exposed by the bridge");
    assert((await raw({ "x-max-bot-api-secret": SECRET }, "", "/eve/v1/max/status", "GET")) === 404, "Eve control routes are not exposed");
    assert((await raw({}, "", "/healthz", "GET")) === 200, "healthz is open");
    const declared = await new Promise((resolve, reject) => {
      const rq = httpRequest({ host: "127.0.0.1", port: bridgePort, path: "/max/webhook", method: "POST", headers: { "x-max-bot-api-secret": SECRET, "content-length": "5000000" } }, (res) => { resolve(res.statusCode); res.resume(); });
      rq.on("error", reject);
      rq.write("{}");
    });
    assert(declared === 413, `oversized declared body → 413, got ${declared}`);
    const reqs0 = openai.requests.length;
    assert((await maxApi.deliverWebhook(msg({ text: "hello", mid: "x1", userId: "222", chatId: CHAT }))) === 200, "stranger → silent 200");
    assert((await maxApi.deliverWebhook(callback({ payload: "iva_menu:r:o", mid: "m", userId: "222", chatId: CHAT }))) === 200, "stranger button tap → silent 200");
    assert((await maxApi.deliverWebhook(msg({ text: "/restart", mid: "x2", userId: "222", chatId: CHAT }))) === 200, "stranger /restart → silent 200");
    assert((await maxApi.deliverWebhook(msg({ text: "hi", mid: "x3", userId: USER, chatId: "-1", chatType: "chat" }))) === 200, "group message is ignored");
    await sleep(800);
    assert(maxApi.received.length === 0 && maxApi.edits.length === 0 && openai.requests.length === reqs0, "nothing reached the agent or MAX for strangers / groups");
    assert((await count(/restart/)) === 0, "a stranger must not be able to restart anything");

    setPhase("chat-roundtrip-and-dedup");
    assert((await user("Reply with a status word.", "w1")) === 200, "ack");
    await until(() => maxApi.received.length === 1, "agent reply");
    assert(lastMsg().text === "REPLICA_OK" && lastMsg().query === `?chat_id=${CHAT}`, `reply ${JSON.stringify(lastMsg())}`);
    const reqs1 = openai.requests.length;
    assert((await user("Reply with a status word.", "w1")) === 200, "duplicate ack");
    await sleep(800);
    assert(openai.requests.length === reqs1 && maxApi.received.length === 1, "redelivered chat event must not start a second turn");

    setPhase("command-parity");
    const sent0 = maxApi.received.length;
    assert((await user("/help", "c1")) === 200);
    await until(() => maxApi.received.length > sent0, "/help");
    assert(/\/menu/.test(lastMsg().text) && /\/usage/.test(lastMsg().text), "help lists commands");
    assert((await user("/usage", "c2")) === 200);
    await until(() => maxApi.received.length > sent0 + 1, "/usage");
    assert((await user("/stop", "c3")) === 200);
    await until(() => maxApi.received.length > sent0 + 2, "/stop");
    assert(/Nothing is running/i.test(lastMsg().text), `stop when idle: ${lastMsg().text}`);
    assert((await user("/new", "c4")) === 200);
    await until(() => maxApi.received.length > sent0 + 3, "/new");
    assert(/new conversation/i.test(lastMsg().text), `/new: ${lastMsg().text}`);
    const modelBefore = openai.requests.length;
    for (const [i, cmd] of ["/task buy milk", "/tasks", "/digest"].entries()) {
      const n = maxApi.received.length;
      assert((await user(cmd, `c${5 + i}`)) === 200);
      await until(() => maxApi.received.length > n, cmd);
      assert(lastMsg().text === "REPLICA_OK", `${cmd} is answered by the agent`);
    }
    assert(openai.requests.length === modelBefore + 3, "/task /tasks /digest went to the agent (3 turns)");
    const taskSeen = openai.requests.some((q) => JSON.stringify(q.messages).includes("/task buy milk"));
    assert(taskSeen, "the agent received the /task text");
    assert(openai.requests.length === modelBefore + 3 && (await count(/restart|systemd-run/)) === 0, "agent commands did not touch the system");

    setPhase("menu-buttons-and-model-change");
    assert((await user("/menu", "m1")) === 200);
    await until(() => lastTimeline()?.body?.attachments?.length > 0, "menu keyboard");
    assert(lastMsg().query === `?chat_id=${CHAT}`, "menu addressed to the dialog");
    await pressAndWait(/Status|Статус/);
    await pressAndWait(/Menu|Меню/);
    await pressAndWait(/Model|Модель/);
    assert(/ollama/i.test(textOf(lastTimeline())), `wizard intro: ${textOf(lastTimeline())}`);
    await pressAndWait(/Change|Сменить/);
    await pressAndWait(/Ollama/);
    assert(/iva-alt/.test(JSON.stringify(lastTimeline().body.attachments)), "live catalog shown as buttons");
    await pressAndWait(/iva-alt/);
    await pressAndWait(/^high$/);
    assert(/Restart|Перезапустить/i.test(textOf(lastTimeline())), `saved screen: ${textOf(lastTimeline())}`);
    const env1 = await envNow();
    assert(/^OLLAMA_MODEL=iva-alt$/m.test(env1) && /^THINKING_EFFORT=high$/m.test(env1), "model + thinking effort written to .env");
    assert(/^MAX_BOT_TOKEN=/m.test(env1), ".env otherwise preserved");
    const restartsBefore = await count(/restart iva\.service/);
    const dupId = "cb-restart-now";
    const { btn: rsBtn, before: rsBefore } = await press(/Restart now|Перезапустить сейчас/, { dupId });
    assert(rsBtn.payload === "iva_model:rs:now", `restart button payload ${rsBtn.payload}`);
    await until(() => maxApi.timeline.length > rsBefore, "wizard acknowledged the restart request");
    await until(async () => (await count(/restart iva\.service/)) === restartsBefore + 1, "agent restart requested via systemctl --user");
    // MAX повторяет доставку того же нажатия (тот же callback_id) — перезапуска больше нет
    const rsCallback = callback({ payload: rsBtn.payload, mid: lastTimeline().mid, userId: USER, chatId: CHAT, id: dupId });
    for (let i = 0; i < 3; i++) assert((await maxApi.deliverWebhook(rsCallback)) === 200, "redelivered button acked");
    await sleep(500);
    assert((await count(/restart iva\.service/)) === restartsBefore + 1, "redelivered 'Restart now' must not restart again");

    setPhase("execution-errors");
    // 1) каталог моделей недоступен → понятная ошибка, конфигурация не тронута
    openai.state.modelsStatus = 500;
    const envBeforeErr = await envNow();
    assert((await user("/model", "e1")) === 200);
    await until(() => /Ollama|ollama/.test(textOf(lastTimeline())) && lastTimeline().body.attachments?.length, "wizard intro");
    await pressAndWait(/Change|Сменить/);
    await pressAndWait(/Ollama/);
    assert(/Couldn't validate|Не удалось проверить/i.test(textOf(lastTimeline())), `catalog error shown: ${textOf(lastTimeline())}`);
    assert((await envNow()) === envBeforeErr, ".env untouched after a failed catalog");
    openai.state.modelsStatus = 200;
    // 2) ключ провайдера отсутствует → в чат не просим, отправляем к локальной команде
    await pressAndWait(/Back|Назад/);
    await pressAndWait(/OpenCode/);
    assert(/iva secret set OPENCODE_API_KEY/.test(textOf(lastTimeline())), `local secret hint: ${textOf(lastTimeline())}`);
    assert(!/next message|следующим сообщением/i.test(textOf(lastTimeline())), "no request to type the key into chat");
    // 3) /update без git-репозитория → ошибка проверки показана пользователю
    const nU = maxApi.timeline.length;
    assert((await user("/update", "u1")) === 200);
    await until(() => maxApi.timeline.slice(nU).some((t) => /Couldn't check for updates|Не удалось проверить обновления/.test(textOf(t))), "update-check error shown");
    // 4) systemctl restart падает → понятная ошибка
    await writeFile(fake.failFlag, "");
    const nR = maxApi.timeline.length;
    assert((await user("/restart", "r-fail")) === 200);
    await until(() => maxApi.timeline.slice(nR).some((t) => /Couldn't restart|Не удалось перезапустить/.test(textOf(t))), "restart error shown");
    await rm(fake.failFlag, { force: true });

    setPhase("dangerous-commands-run-once");
    const rBase = await count(/restart iva\.service/);
    const restartUpdate = msg({ text: "/restart", mid: "r-once", userId: USER, chatId: CHAT });
    assert((await maxApi.deliverWebhook(restartUpdate)) === 200);
    await until(async () => (await count(/restart iva\.service/)) === rBase + 1, "restart executed");
    for (let i = 0; i < 4; i++) assert((await maxApi.deliverWebhook(restartUpdate)) === 200, "redelivery acked");
    await Promise.all(Array.from({ length: 5 }, () => maxApi.deliverWebhook(restartUpdate)));
    await sleep(500);
    assert((await count(/restart iva\.service/)) === rBase + 1, "/restart redelivered 9 times ran exactly once");
    const updDo = callback({ payload: "iva_update:do", mid: "m-upd", userId: USER, chatId: CHAT, id: "upd-do-1" });
    for (let i = 0; i < 3; i++) assert((await maxApi.deliverWebhook(updDo)) === 200);
    await sleep(500);
    assert((await count(/systemd-run/)) === 1, "update launched exactly once despite redelivery");

    setPhase("ledger-unavailable-blocks-dangerous-commands");
    const ledgerPath = join(app, "data/max/control.json");
    await rename(ledgerPath, `${ledgerPath}.bak`).catch(() => {});
    await mkdir(join(ledgerPath, "block"), { recursive: true }); // запись журнала станет невозможной
    const rBase2 = await count(/restart iva\.service/);
    const rStuck = msg({ text: "/restart", mid: "r-ledger", userId: USER, chatId: CHAT });
    assert((await maxApi.deliverWebhook(rStuck)) === 503, "cannot persist the intent → 503 (MAX will redeliver)");
    assert((await count(/restart iva\.service/)) === rBase2, "the dangerous command was NOT started");
    await rm(ledgerPath, { recursive: true, force: true });
    assert((await maxApi.deliverWebhook(rStuck)) === 200, "after the disk recovers the redelivery succeeds");
    assert((await count(/restart iva\.service/)) === rBase2 + 1, "…and runs exactly once");

    setPhase("agent-down-keeps-events");
    await stopProc(eve);
    const nChat = maxApi.received.length;
    const lost = msg({ text: "Reply with a status word.", mid: "w-down", userId: USER, chatId: CHAT });
    assert((await maxApi.deliverWebhook(lost)) === 503, "agent down → 503, event not acknowledged");
    const nTl = maxApi.timeline.length;
    assert((await user("/menu", "m-down")) === 200, "control still works while the agent is down");
    await until(() => maxApi.timeline.length > nTl, "menu while agent is down");
    assert(maxApi.received.length === nChat + 1, "only the menu message was sent; no phantom agent reply");
    eve = startEve();
    await until(eveHealthy, "eve back", 90_000);
    assert((await maxApi.deliverWebhook(lost)) === 200, "redelivery after recovery is accepted");
    await until(() => maxApi.received.some((m) => m.text === "REPLICA_OK" && maxApi.received.indexOf(m) >= nChat), "reply after recovery");

    setPhase("crash-in-the-middle-of-restart");
    await writeFile(fake.blockFlag, ""); // systemctl restart «зависает»
    const rCrash = msg({ text: "/restart", mid: "r-crash", userId: USER, chatId: CHAT });
    const rBase3 = await count(/restart iva\.service/);
    const pending = maxApi.deliverWebhook(rCrash).catch(() => "connection-lost");
    await until(async () => (await count(/restart iva\.service/)) === rBase3 + 1, "restart reached systemctl (blocked)");
    await stopProc(bridge, "SIGKILL"); // процесс моста умирает посреди команды
    await pending;
    await rm(fake.blockFlag, { force: true });
    bridge = startBridge();
    await until(bridgeUp, "bridge after crash", 30_000);
    const nCrash = maxApi.timeline.length;
    assert((await maxApi.deliverWebhook(rCrash)) === 200, "MAX redelivers the interrupted /restart");
    await until(() => maxApi.timeline.slice(nCrash).some((t) => /interrupted|оборвалась/.test(textOf(t))), "outcome-unknown notice");
    assert((await count(/restart iva\.service/)) === rBase3 + 1, "the interrupted /restart was NOT run a second time");
    assert((await maxApi.deliverWebhook(rCrash)) === 200 && (await count(/restart iva\.service/)) === rBase3 + 1, "and the loop is closed");

    setPhase("switch-webhook-to-polling");
    await stopProc(bridge);
    assert(!(await bridgeUp()), "bridge stopped");
    r = await iva("max", "webhook", "off", "--no-restart");
    assert(r.code === 0 && maxApi.subs.length === 0, `webhook off: ${r.out}`);
    assert(/^MAX_INGEST=poll$/m.test(await envNow()), ".env switched to poll");
    const pollsBefore = maxApi.pollLog.length;
    bridge = startBridge();
    await until(() => maxApi.pollLog.length > pollsBefore, "bridge polls", 30_000);
    assert((await user("Reply with a status word.", "p1")) === null, "with no subscription MAX queues the event for polling (no webhook delivery)");
    const deliveriesBeforePoll = maxApi.state.webhookDeliveries.length;
    const nPoll = maxApi.received.length;
    await until(() => maxApi.received.length > nPoll, "reply received through the polling transport");
    assert(maxApi.state.webhookDeliveries.length === deliveriesBeforePoll, "polling mode received nothing via webhook");
    // control commands work identically over polling
    const nPollTl = maxApi.timeline.length;
    assert((await user("/menu", "p2")) === null);
    await until(() => maxApi.timeline.length > nPollTl, "/menu over polling");
    // второй транспорт не может стартовать параллельно
    const dup = startBridge({ MAX_INGEST: "webhook" });
    extras.push(dup);
    const dupExit = await Promise.race([dup.exited, sleep(15_000).then(() => "timeout")]);
    assert(dupExit !== "timeout" && dupExit.code === 78, `second transport refused (exit ${JSON.stringify(dupExit)})`);
    assert(logs.some((l) => /another MAX transport is already running/.test(l)), "conflict explained");

    setPhase("switch-polling-to-webhook");
    await stopProc(bridge);
    r = await iva("max", "webhook", "set", WH_URL, "--yes", "--no-restart");
    assert(r.code === 0 && maxApi.subs.length === 1, `webhook set again: ${r.out}`);
    // polling при активной подписке запрещён и даже не обращается к /updates
    const pollsGuard = maxApi.pollLog.length;
    const refused = startBridge({ MAX_INGEST: "poll" });
    extras.push(refused);
    const refusedExit = await Promise.race([refused.exited, sleep(15_000).then(() => "timeout")]);
    assert(refusedExit !== "timeout" && refusedExit.code === 78, `polling refused while a webhook is active (exit ${JSON.stringify(refusedExit)})`);
    assert(maxApi.pollLog.length === pollsGuard, "the refused polling bridge never touched /updates");
    assert(logs.some((l) => /iva max webhook off/.test(l)), "refusal tells how to switch properly");
    bridge = startBridge();
    await until(bridgeUp, "bridge in webhook mode", 30_000);
    const pollsWh = maxApi.pollLog.length;
    const nWh = maxApi.received.length;
    const whBefore = maxApi.state.webhookDeliveries.length;
    assert((await user("Reply with a status word.", "p3")) === 200, "event delivered by webhook");
    await until(() => maxApi.received.length > nWh, "reply via webhook transport");
    assert(maxApi.state.webhookDeliveries.length === whBefore + 1, "delivered through the webhook transport");
    await sleep(1500);
    assert(maxApi.pollLog.length === pollsWh, "webhook mode never polled");
    // событие, уже обработанное через polling (p1), приходит повторно по webhook (переключение «на лету») — второго хода нет
    const reqsSwitch = openai.requests.length;
    assert((await maxApi.deliverWebhook(msg({ text: "Reply with a status word.", mid: "p1", userId: USER, chatId: CHAT }))) === 200);
    await sleep(800);
    assert(openai.requests.length === reqsSwitch, "an event already handled over polling is not run again over webhook");

    setPhase("final-health");
    const st = await (await fetch(`http://127.0.0.1:${evePort}/eve/v1/max/status`, { headers: { "x-max-bot-api-secret": SECRET } })).json();
    assert(st.dead === 0 && st.health.corruptFiles.length === 0 && st.health.persistFailing === false, `healthy: ${JSON.stringify(st)}`);
    console.log(`max webhook e2e: OK (model requests: ${openai.requests.length}, MAX messages: ${maxApi.received.length}, edits: ${maxApi.edits.length}, webhook deliveries: ${maxApi.state.webhookDeliveries.length})`);
  } catch (err) {
    console.error(`max webhook e2e FAILED at phase "${phase}": ${err?.message ?? err}`);
    for (const l of logs.slice(-120)) console.error(l);
    process.exitCode = 1;
  } finally {
    for (const p of extras) await stopProc(p, "SIGKILL");
    await stopProc(bridge);
    await stopProc(eve);
    await openai.close();
    await maxApi.close();
    if (process.env.REPLICA_KEEP === "1") console.error(`sandbox kept: ${sandbox}`);
    else await rm(sandbox, { recursive: true, force: true });
  }
}
await main();
