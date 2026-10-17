// E2E мультимедиа MAX на РЕАЛЬНО собранном Eve (build → eve start → мост → mock MAX API → mock-модель):
//   голос, фото, документы → скачивание → проверка → STT / vision / извлечение текста → агент Ивы с её настоящими
//   инструментами (tasks, write_card, memory_search, write_file, max_send_file) → ответ и файлы обратно в MAX
//   через Upload API. Один и тот же набор сценариев гоняется в режиме WEBHOOK и в режиме POLLING.
// Всё на 127.0.0.1: настоящих токенов и внешней сети нет (STT/vision/MAX — mock; это НЕ живой тест).
// Запуск: npm run test:max-media-e2e [-- --mode=webhook|poll]
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { startMockOpenAiServer } from "./lib/mock-openai-server.mjs";
import { mediaBehavior } from "./lib/mock-media-model.mjs";
import { assert, att, freePort, makeFakeBin, msg, prepareApp, run, runAny, sleep, startMockMax, startProc, stopProc, until } from "./lib/max-e2e-kit.mjs";
import { csvFixture, makeDocx, makePdf, makePng, makeScanPdf, makeSilence, makeVoice, makeXlsx, readVoiceText } from "./lib/media-fixtures.mjs";

const TOKEN = "e2e-max-token";
const SECRET = "e2e-media-secret_123";
const DG_KEY = "e2e-deepgram-key";
const USER = "9007199254740993123";
const CHAT = "-4242";
const WH_URL = "https://iva.example.com/max/webhook";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const hasPoppler = (() => { try { execFileSync("pdftotext", ["-v"], { stdio: "ignore" }); return true; } catch { return false; } })();

const modeArg = process.argv.find((a) => a.startsWith("--mode="))?.slice(7);
const MODES = modeArg ? [modeArg] : ["webhook", "poll"];

async function scenario(mode) {
  const logs = [];
  const note = (l) => { logs.push(l); if (logs.length > 500) logs.shift(); };
  let phase = "prepare";
  const setPhase = (p) => { phase = p; note(`[e2e] phase: ${p}`); console.log(`  · [${mode}] ${p}`); };

  const sandbox = await mkdtemp(join(tmpdir(), `iva-max-media-${mode}-`));
  const dg = { requests: [], status: 200 };
  const dgServer = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bytes = Buffer.concat(chunks);
    dg.requests.push({ auth: req.headers.authorization, url: req.url, sha: sha(bytes), type: req.headers["content-type"] });
    if (dg.status !== 200) { res.writeHead(dg.status); return res.end("{}"); }
    const text = readVoiceText(bytes) ?? "";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: text }] }] } }));
  });
  await new Promise((r) => dgServer.listen(0, "127.0.0.1", r));

  const bridgePort = await freePort();
  const evePort = await freePort();
  const maxApi = await startMockMax({ token: TOKEN, webhookTarget: () => `http://127.0.0.1:${bridgePort}/max/webhook` });
  let eve = null;
  let bridge = null;
  let openai = null;
  try {
    const app = await prepareApp(sandbox);
    const vaultDir = join(app, "vault");
    const dataDir = join(app, "data");
    openai = await startMockOpenAiServer({ behave: mediaBehavior({ vaultDir, dataDir, appDir: app, log: note }) });
    const fake = await makeFakeBin(join(sandbox, "fakebin"));
    const dict = {
      MODEL_PROVIDER: "ollama", OLLAMA_BASE_URL: openai.baseUrl, OLLAMA_API_KEY: "k", OLLAMA_MODEL: "iva-replica", OLLAMA_CONTEXT_WINDOW: "131072",
      IVA_CATALOG_BASE_URL_OLLAMA: openai.baseUrl,
      ASSISTANT_BEARER: "e2e-bearer-".padEnd(48, "x"), ASSISTANT_DATA_DIR: dataDir, ASSISTANT_VAULT_DIR: vaultDir,
      ASSISTANT_TIMEZONE: "UTC", MEMORY_SEARCH_MODE: "bm25", IVA_PORT: String(evePort), PORT: String(evePort),
      IVA_CHANNELS: "max", MAX_BOT_TOKEN: TOKEN, MAX_WEBHOOK_SECRET: SECRET, MAX_ALLOWED_USER_IDS: USER,
      MAX_INGEST: mode === "webhook" ? "webhook" : "poll", MAX_BRIDGE_PORT: String(bridgePort), MAX_API_BASE_URL: maxApi.url,
      MAX_OUTBOX_BACKOFF_MS: "300", MAX_MIN_SEND_INTERVAL_MS: "50", AGENT_LANGUAGE: "ru",
      DEEPGRAM_API_KEY: DG_KEY, DEEPGRAM_BASE_URL: `http://127.0.0.1:${dgServer.address().port}`, DEEPGRAM_LANGUAGE: "ru",
      MAX_MEDIA_FILE_MAX_BYTES: "200000", MAX_MEDIA_IMAGE_MAX_BYTES: "200000", MAX_MEDIA_AUDIO_MAX_BYTES: "200000",
    };
    await writeFile(join(app, ".env"), Object.entries(dict).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
    const PATH = `${join(sandbox, "fakebin")}:${process.env.PATH}`;
    const eveEnv = { ...dict, PATH, HOME: sandbox, NODE_ENV: "production" };
    const iva = (...args) => runAny(process.execPath, [join(app, "bin/iva.mjs"), ...args], { cwd: app, env: { PATH, HOME: sandbox, NO_COLOR: "1" }, note });
    const evePath = join(app, "node_modules/eve/bin/eve.js");
    const startEve = () => startProc(process.execPath, [evePath, "start", "--host", "127.0.0.1", "--port", String(evePort)], { cwd: app, env: eveEnv, note, tag: "eve" });
    const eveHealthy = async () => { try { return (await fetch(`http://127.0.0.1:${evePort}/`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } };
    const startBridge = () => startProc(process.execPath, ["--env-file=.env", "scripts/max-bridge.mjs"], { cwd: app, env: { PATH, HOME: sandbox, NO_COLOR: "1" }, note, tag: "bridge" });

    setPhase("build");
    await run(process.execPath, [join(app, "scripts/init-vault.mjs")], { cwd: app, env: eveEnv, note });
    await run(process.execPath, [evePath, "build"], { cwd: app, env: eveEnv, note });
    setPhase("start");
    eve = startEve();
    await until(eveHealthy, "eve health", 90_000);
    if (mode === "webhook") {
      const r = await iva("max", "webhook", "set", WH_URL, "--yes", "--no-restart");
      assert(r.code === 0, `webhook set failed: ${r.out}`);
    }
    bridge = startBridge();
    await until(() => maxApi.commands.length > 0, "bridge registered bot commands", 45_000);
    if (mode === "webhook") assert(maxApi.pollLog.length === 0, "webhook mode must never poll");

    // ── утилиты ────────────────────────────────────────────────────────────────
    let mid = 0;
    const nextMid = () => `${mode}-${++mid}`;
    const say = (text, attachments, extra = {}) => maxApi.route(msg({ text, mid: nextMid(), userId: USER, chatId: CHAT, attachments, ...extra }));
    const texts = () => maxApi.received.map((m) => m.text ?? "");
    async function ask(text, attachments, re, what, ms = 60_000) {
      const n = maxApi.received.length;
      await say(text, attachments);
      await until(() => maxApi.received.slice(n).some((m) => re.test(m.text ?? "")), `${what}: reply matching ${re}; got ${JSON.stringify(texts().slice(n))}`, ms);
      return maxApi.received.slice(n).find((m) => re.test(m.text ?? ""));
    }
    const modelUserTexts = () => openai.requests.map((b) => { const u = [...(b.messages ?? [])].reverse().find((m) => m.role === "user"); return typeof u?.content === "string" ? u.content : (u?.content ?? []).map((p) => p?.text ?? "").join(" "); });
    const settle = async () => { for (let last = "", stable = 0; stable < 3; await sleep(500)) { const cur = `${maxApi.received.length}/${openai.requests.length}`; stable = cur === last ? stable + 1 : 0; last = cur; } };
    const today = new Date().toISOString().slice(0, 10);

    // ── 0. регрессия: обычный текст и команда ────────────────────────────────
    setPhase("text-regression");
    await ask("Reply with a status word.", undefined, /^REPLICA_OK$/, "text round-trip");
    await ask("/help", undefined, /\/menu/, "/help");

    // ── 1. голос → задача и напоминание ───────────────────────────────────────
    setPhase("voice-to-task");
    const spoken = "Ива, завтра в десять утра напомни позвонить клиенту и подготовить коммерческое предложение";
    const voice = makeVoice(spoken);
    const reqsBefore = openai.requests.length;
    const reply = await ask(undefined, [att.audio(maxApi.hostFile(voice, { contentType: "audio/ogg" }))], /Задача создана/, "voice task confirmation");
    assert(reply.text.includes("Позвонить клиенту и подготовить коммерческое предложение"), `confirmation text: ${reply.text}`);
    assert(dg.requests.length === 1 && dg.requests[0].sha === sha(voice), "Deepgram received exactly the downloaded audio");
    assert(dg.requests[0].auth === `Token ${DG_KEY}` && /language=ru/.test(dg.requests[0].url), `Deepgram request: ${JSON.stringify(dg.requests[0])}`);
    assert(modelUserTexts().slice(reqsBefore).some((t) => t.includes(spoken) && /<<<TRANSCRIPT/.test(t)), "the agent received the exact transcript, framed as the user's words");
    const tasks = JSON.parse(await readFile(join(dataDir, "tasks.json"), "utf8"));
    assert(tasks.some((t) => t.text === "Позвонить клиенту и подготовить коммерческое предложение" && t.due === "завтра 10:00"), `task created by the real tasks tool: ${JSON.stringify(tasks)}`);
    assert(maxApi.mediaRequests.every((r) => r.authorization === null), "the bot token was never sent to the file host");
    const attDir = join(vaultDir, "attachments", today);
    const voiceFiles = (await readdir(attDir)).filter((f) => f.startsWith("voice-"));
    assert(voiceFiles.length === 1 && sha(await readFile(join(attDir, voiceFiles[0]))) === sha(voice), "voice saved in vault byte-identical");
    const daily = await readFile(join(vaultDir, "daily", `${today}.md`), "utf8");
    assert(daily.includes(spoken), "the transcript is in the daily journal (feeds nightly memory)");

    // ── 2. аудио без речи / недоступный STT → точная ошибка, без выдумок ────────
    setPhase("voice-failures");
    await settle();
    let n = maxApi.received.length, rq = openai.requests.length;
    await say(undefined, [att.audio(maxApi.hostFile(makeSilence()))]);
    await until(() => maxApi.received.length > n, "no-speech notice");
    assert(/не обнаружена речь|no speech/.test(maxApi.received.at(-1).text), maxApi.received.at(-1).text);
    await sleep(800);
    assert(openai.requests.length === rq, "no model turn for a recording without speech (nothing to invent from)");
    dg.status = 503;
    n = maxApi.received.length;
    await say(undefined, [att.audio(maxApi.hostFile(makeVoice("секретный текст")))]);
    await until(() => maxApi.received.length > n, "STT outage notice");
    assert(/сервис распознавания речи недоступен|unavailable/.test(maxApi.received.at(-1).text), maxApi.received.at(-1).text);
    await sleep(800);
    assert(openai.requests.length === rq && !texts().some((t) => t.includes("секретный текст")), "no invented transcript while STT is down");
    dg.status = 200;

    // ── 3. фото/скриншот с подписью ───────────────────────────────────────────
    setPhase("photo-with-caption");
    const shot = makePng("Traceback: KeyError 'user_id' at billing.py:88");
    const caption = "Посмотри на эту ошибку, найди причину и предложи исправление";
    const r3 = await ask(caption, [att.image(maxApi.hostFile(shot, { contentType: "image/png" }))], /KeyError 'user_id'/, "screenshot analysis");
    assert(/Причина по скриншоту/.test(r3.text), r3.text);
    const visionReq = openai.requests.find((b) => JSON.stringify(b.messages ?? []).includes("data:image/png;base64"));
    const sent = visionReq?.messages?.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((p) => p?.image_url)?.image_url?.url;
    assert(sent && sha(Buffer.from(sent.split(",")[1], "base64")) === sha(shot), "the vision model received the very screenshot that was sent");
    assert(modelUserTexts().some((t) => t.startsWith(caption) && t.includes("Image text: Traceback: KeyError")), "agent turn contains the caption and the vision description");

    setPhase("several-images");
    const r4 = await ask("Сравни две картинки", [att.image(maxApi.hostFile(makePng("HTTP 502 Bad Gateway"))), att.image(maxApi.hostFile(makePng("Disk usage 97 percent")))], /Картинок: 2/, "two images");
    assert(/#1: HTTP 502 Bad Gateway/.test(r4.text) && /#2: Disk usage 97 percent/.test(r4.text), r4.text);

    // ── 4. документы ──────────────────────────────────────────────────────────
    setPhase("docx-to-memory");
    const docx = makeDocx({ paragraphs: ["Договор поставки № 17", "Срок: 30 дней.", "Штраф: 0,5% в день."], table: [["Этап", "Сумма"], ["Аванс", "100 000"]] });
    const askText = "Ива, изучи файл, выдели главное, сделай таблицу и запомни важную информацию";
    const r5 = await ask(askText, [att.file(maxApi.hostFile(docx), "dogovor.docx", docx.length)], /Запомнила условия договора/, "docx memory");
    assert(r5.text.includes("Штраф: 0,5% в день.") && r5.text.includes("Срок: 30 дней."), r5.text);
    const cardsDir = join(vaultDir, "cards", "notes");
    const cardFiles = existsSync(cardsDir) ? (await readdir(cardsDir)).filter((f) => f.endsWith(".md")) : [];
    assert(cardFiles.length === 1, `memory card written by the real write_card tool: ${cardFiles}`);
    assert((await readFile(join(cardsDir, cardFiles[0]), "utf8")).includes("Штраф: 0,5% в день."), "the card holds the fact extracted from the document");
    assert((await readdir(attDir)).includes("dogovor.docx") && sha(await readFile(join(attDir, "dogovor.docx"))) === sha(docx), "the document itself is stored in the vault");
    // позднее — поиск по памяти реальным memory_search
    const r6 = await ask("Какие условия по договору я просил запомнить?", undefined, /Нашла в памяти/, "memory recall");
    assert(/0,5% в день/.test(r6.text), `memory_search found the fact: ${r6.text}`);

    setPhase("xlsx-analysis");
    const xlsx = makeXlsx({ sheets: [{ name: "Q1", rows: [["Месяц", "Выручка"], ["Январь", 100], ["Февраль", 150], ["Итого", { f: "SUM(B2:B3)", v: 250 }]] }, { name: "Q2", rows: [["Месяц", "Выручка"], ["Апрель", 90]] }] });
    const r7 = await ask("посчитай итог по таблице", [att.file(maxApi.hostFile(xlsx), "report.xlsx", xlsx.length)], /сумма B = /, "xlsx analysis");
    assert(/Лист «Q1»: сумма B = 250 \(значений: 2\)/.test(r7.text), r7.text);

    setPhase("csv-and-txt");
    const r8 = await ask("Что ты получила?", [att.file(maxApi.hostFile(Buffer.from(csvFixture)), "prices.csv", csvFixture.length)], /Получено:/, "csv");
    assert(/widget,3,9\.50/.test(r8.text) && /gadget,2,20\.00/.test(r8.text), r8.text);

    if (hasPoppler) {
      setPhase("pdf");
      const pdf = makePdf(["Section 3: delivery in 10 business days.", "Total amount: 48 000 RUB."]);
      const r9 = await ask("Что ты получила?", [att.file(maxApi.hostFile(pdf), "offer.pdf", pdf.length)], /Получено:/, "pdf");
      assert(/Section 3: delivery in 10 business days\./.test(r9.text) && /Total amount: 48 000 RUB\./.test(r9.text), r9.text);
      setPhase("scanned-pdf");
      // скан: у PDF нет текстового слоя → страницы рендерятся (pdftoppm) и уходят в vision-модель; агенту честно сказано, что это OCR
      rq = openai.requests.length;
      const scan = makeScanPdf();
      await say(undefined, [att.file(maxApi.hostFile(scan), "scan.pdf", scan.length)]);
      await until(() => modelUserTexts().slice(rq).some((t) => /скан PDF: текст распознан vision-моделью/.test(t) && /--- page 1 ---/.test(t)), "scan goes through page-by-page OCR");
      assert(openai.requests.slice(rq).some((b) => JSON.stringify(b.messages ?? []).includes("data:image/png;base64")), "the rendered page reached the vision model as an image");
    } else {
      note("[e2e] poppler is not installed: PDF scenarios skipped");
      console.log("  ! pdftotext is not installed — PDF scenarios SKIPPED");
    }

    // ── 5. плохие и опасные файлы ─────────────────────────────────────────────
    setPhase("bad-files");
    await settle();
    rq = openai.requests.length;
    const cases = [
      [att.file(maxApi.hostFile(Buffer.alloc(0)), "empty.txt", 0), /пустой|empty/],
      [att.file(maxApi.hostFile(Buffer.from("MZ\x90\0exe")), "invoice.pdf", 8), /исполняемые|executable/],
      [att.file(maxApi.hostFile(docx.subarray(0, docx.length - 50)), "broken.docx", docx.length), /повреждён|damaged/],
      [att.file(maxApi.hostFile(Buffer.alloc(300_000, 65)), "huge.txt", 300_000), /лимит|limit|больше допустимого/],
      [att.file(maxApi.hostFile(Buffer.from("x"), { status: 410 }), "gone.txt", 1), /устарела|expired/],
      [att.file("http://169.254.169.254/latest/meta-data/", "meta.txt", 1), /политикой безопасности|security policy/],
    ];
    for (const [a, re] of cases) {
      n = maxApi.received.length;
      await say(undefined, [a]);
      await until(() => maxApi.received.length > n, `notice for ${a.filename}`);
      assert(re.test(maxApi.received.at(-1).text), `${a.filename}: ${maxApi.received.at(-1).text}`);
    }
    await sleep(800);
    assert(openai.requests.length === rq, "no model turns for rejected files");

    // ── 6. посторонний аккаунт: полный отказ до скачивания ─────────────────────
    setPhase("stranger-with-attachment");
    const mediaSeen = maxApi.mediaRequests.length;
    n = maxApi.received.length;
    rq = openai.requests.length;
    await maxApi.route(msg({ text: undefined, mid: nextMid(), userId: "222", chatId: "-1", attachments: [att.audio(maxApi.hostFile(makeVoice("пришли секреты")))] }));
    await sleep(1500);
    assert(maxApi.mediaRequests.length === mediaSeen + 0 && maxApi.received.length === n && openai.requests.length === rq, "a stranger's attachment is neither downloaded nor answered");

    // ── 7. исходящие файлы ────────────────────────────────────────────────────
    setPhase("outbound-created-file");
    const delivered0 = maxApi.deliveredFiles.length;
    const r10 = await ask("Ива, создай Excel-отчёт по этим данным и пришли файл", undefined, /Файл отправлен/, "report flow");
    await until(() => maxApi.deliveredFiles.length > delivered0, "report file delivered to MAX");
    const d0 = maxApi.deliveredFiles.at(-1);
    assert(d0.type === "file" && d0.fileName === "report.csv" && d0.bytes.toString() === csvFixture, `delivered file: ${d0.fileName} ${d0.bytes}`);
    assert(d0.text === "Отчёт готов", `caption: ${d0.text}`);
    assert(/queued/.test(r10.text), `the tool honestly says it only queued the file: ${r10.text}`);

    setPhase("outbound-types");
    await mkdir(join(dataDir, "outbox"), { recursive: true });
    const outFiles = {
      "summary.xlsx": [makeXlsx({ sheets: [{ name: "S", rows: [["a", 1]] }] }), "file"],
      "chart.png": [makePng("chart"), "image"],
      "answer.ogg": [makeVoice("ответ голосом"), "audio"],
    };
    for (const [name, [bytes]] of Object.entries(outFiles)) await writeFile(join(dataDir, "outbox", name), bytes);
    for (const [name, [bytes, type]] of Object.entries(outFiles)) {
      const before = maxApi.deliveredFiles.length;
      await ask(`пришли файл ${name}`, undefined, /Результат отправки/, `send ${name}`);
      await until(() => maxApi.deliveredFiles.length > before, `${name} delivered`);
      const d = maxApi.deliveredFiles.at(-1);
      assert(d.type === type && d.bytes.equals(bytes), `${name}: delivered as ${d.type}, bytes ${d.bytes.equals(bytes) ? "identical" : "DIFFER"}`);
    }
    assert(maxApi.uploadAuth.every((a) => a === null), "the bot token never goes to the upload host");

    setPhase("outbound-not-ready");
    maxApi.state.notReady = 2;
    const up0 = maxApi.uploads.length;
    const del0 = maxApi.deliveredFiles.length;
    await ask("пришли файл summary.xlsx", undefined, /Результат отправки/, "not-ready flow");
    await until(() => maxApi.deliveredFiles.length > del0, "file delivered after attachment.not.ready", 60_000);
    assert(maxApi.uploads.length === up0 + 1, "one upload despite two not-ready answers");

    setPhase("outbound-policy");
    const del1 = maxApi.deliveredFiles.length;
    const r11 = await ask("пришли секреты", undefined, /Не отправила/, "secrets refused");
    assert(/never sent|outside|secret|keys/i.test(r11.text), r11.text);
    const r12 = await ask("пришли файл /etc/passwd", undefined, /Результат отправки/, "outside roots refused");
    assert(/outside the directories|not found|не разрешены/i.test(r12.text), r12.text);
    await sleep(1000);
    assert(maxApi.deliveredFiles.length === del1, "nothing outside the policy was delivered");
    const noToken = JSON.stringify(maxApi.received.map((m) => m.text));
    assert(!noToken.includes(TOKEN) && !noToken.includes(SECRET) && !noToken.includes(DG_KEY), "no token/secret leaked into any message");

    setPhase("max-api-outage-on-upload");
    maxApi.state.uploadFail = 2;
    const del2 = maxApi.deliveredFiles.length;
    await ask("пришли файл summary.xlsx", undefined, /Результат отправки/, "upload retry flow");
    await until(() => maxApi.deliveredFiles.length > del2, "file delivered after upload host errors", 60_000);

    // ── 8. перезапуск посреди обработки вложения ──────────────────────────────
    setPhase("restart-during-processing");
    await settle();
    rq = openai.requests.length;
    const slow = maxApi.hostFile(makeVoice("медленная запись"), { delayMs: 6000 });
    const seen0 = maxApi.mediaRequests.length;
    n = maxApi.received.length;
    await say(undefined, [att.audio(slow)]);
    await until(() => maxApi.mediaRequests.length > seen0, "download started");
    await stopProc(eve, "SIGKILL");
    eve = startEve();
    await until(eveHealthy, "eve health after crash", 90_000);
    await until(() => maxApi.received.slice(n).some((m) => /перезапускался|restarted/.test(m.text ?? "")), "interrupted-job notice after restart", 60_000);
    await sleep(1500);
    assert(openai.requests.length === rq, "the interrupted attachment was NOT silently processed");
    // после рестарта всё работает: повторная отправка проходит
    await ask(undefined, [att.audio(maxApi.hostFile(makeVoice("Ива, напомни проверить почту")))], /Задача создана/, "voice after restart");

    // ── 9. повторная доставка того же события ────────────────────────────────
    setPhase("event-replay");
    await settle();
    rq = openai.requests.length;
    const replayMid = nextMid();
    const upd = msg({ text: "Что ты получила?", mid: replayMid, userId: USER, chatId: CHAT, attachments: [att.file(maxApi.hostFile(Buffer.from("replay-me\n")), "r.txt", 10)] });
    await maxApi.route(upd);
    await until(() => modelUserTexts().slice(rq).some((t) => t.includes("replay-me")), "first delivery processed");
    const rq2 = openai.requests.length;
    if (mode === "webhook") {
      assert((await maxApi.deliverWebhook(upd)) === 200, "replayed webhook event is acknowledged");
      await sleep(1500);
      assert(openai.requests.length === rq2, "the replayed event started no second turn");
    }

    // ── 10. состояние и гигиена ───────────────────────────────────────────────
    setPhase("hygiene");
    await settle();
    const tmpLeft = existsSync(join(dataDir, "max", "tmp")) ? await readdir(join(dataDir, "max", "tmp")) : [];
    assert(tmpLeft.length === 0, `temporary files are cleaned up: ${tmpLeft}`);
    const status = await (await fetch(`http://127.0.0.1:${evePort}/eve/v1/max/status`, { headers: { "x-max-bot-api-secret": SECRET } })).json();
    assert(status.dead === 0 && status.health.mediaJobs.pending === 0, `queue is clean: ${JSON.stringify(status)}`);
    const all = logs.join("\n");
    assert(!all.includes(TOKEN) && !all.includes(SECRET) && !all.includes(DG_KEY), "no secrets in process logs");
    console.log(`  ✓ ${mode}: model requests ${openai.requests.length}, MAX messages ${maxApi.received.length}, files delivered ${maxApi.deliveredFiles.length}`);
  } catch (err) {
    console.error(`max media e2e [${mode}] FAILED at phase "${phase}": ${err?.message ?? err}`);
    for (const l of logs.slice(-120)) console.error(l);
    process.exitCode = 1;
  } finally {
    await stopProc(bridge);
    await stopProc(eve);
    await openai?.close();
    await maxApi.close();
    await new Promise((r) => dgServer.close(r));
    if (process.env.REPLICA_KEEP === "1") console.error(`sandbox kept: ${sandbox}`);
    else await rm(sandbox, { recursive: true, force: true });
  }
}

for (const mode of MODES) {
  console.log(`max media e2e: ${mode}`);
  await scenario(mode);
  if (process.exitCode) break;
}
if (!process.exitCode) console.log(`max media e2e: OK (${MODES.join(", ")})`);
