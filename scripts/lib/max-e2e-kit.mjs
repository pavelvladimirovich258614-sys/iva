// Общий инструментарий e2e-сценариев MAX на РЕАЛЬНО собранном Eve: mock MAX API (с моделью подписки:
// события идут ровно в один транспорт), процессы, песочница приложения, поддельные systemctl/systemd-run.
// Токенов и внешней сети нет: всё на 127.0.0.1.
import { spawn } from "node:child_process";
import { chmod, cp, mkdir, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttp } from "node:http";
import { createServer as createNet } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(cond, what, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(100);
  }
  throw new Error(`timeout waiting for: ${what}`);
}
export const assert = (c, m) => {
  if (!c) throw new Error(`assertion failed: ${m}`);
};

export function freePort() {
  return new Promise((res, rej) => {
    const s = createNet();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

// int64 в JSON-числах, как у настоящего MAX (строкой его не шлют)
export const toWire = (u) => JSON.stringify(u).replace(/"(user_id|chat_id)":"(-?\d+)"/g, '"$1":$2');

export const msg = ({ text, mid, userId, chatId, chatType = "dialog", attachments, link }) => ({
  update_type: "message_created",
  timestamp: Date.now(),
  message: {
    sender: { user_id: userId, first_name: "T", is_bot: false },
    recipient: { chat_type: chatType, chat_id: chatId, user_id: null },
    timestamp: Date.now(),
    body: { mid, seq: 1, text, ...(attachments ? { attachments } : {}) },
    ...(link ? { link } : {}),
  },
});

/** Вложения в форме официальной схемы MAX (Attachment → payload.url/token…). */
export const att = {
  image: (url, token = "img-tok") => ({ type: "image", payload: { photo_id: 1234567890123456789, token, url } }),
  audio: (url, token = "aud-tok", transcription = null) => ({ type: "audio", payload: { url, token }, ...(transcription !== null ? { transcription } : {}) }),
  file: (url, filename, size, token = "file-tok") => ({ type: "file", payload: { url, token }, filename, size }),
  video: (token = "vid-tok") => ({ type: "video", payload: { url: "https://unused.invalid/v", token }, duration: 3, width: 320, height: 240 }),
};

/** Разбор multipart/form-data с одним файловым полем (достаточно для проверки загрузки). */
export function parseMultipart(buf, contentType) {
  const m = /boundary=(.+)$/i.exec(contentType ?? "");
  if (!m) return null;
  const boundary = Buffer.from(`--${m[1]}`);
  const start = buf.indexOf(boundary);
  if (start < 0) return null;
  const headEnd = buf.indexOf(Buffer.from("\r\n\r\n"), start);
  const head = buf.subarray(start + boundary.length, headEnd).toString("utf8");
  const dataStart = headEnd + 4;
  const dataEnd = buf.indexOf(Buffer.from(`\r\n--${m[1]}`), dataStart);
  if (dataEnd < 0) return null;
  const field = /name="([^"]*)"/.exec(head)?.[1] ?? "";
  const fileName = /filename="([^"]*)"/.exec(head)?.[1] ?? "";
  const ct = /Content-Type:\s*([^\r\n]+)/i.exec(head)?.[1] ?? "";
  return { field, fileName, contentType: ct, bytes: buf.subarray(dataStart, dataEnd) };
}
export const callback = ({ payload, mid, userId, chatId, id = `cb-${Math.random().toString(36).slice(2)}` }) => ({
  update_type: "message_callback",
  timestamp: Date.now(),
  callback: { timestamp: Date.now(), callback_id: id, payload, user: { user_id: userId, first_name: "T", is_bot: false } },
  message: {
    sender: { user_id: "999", first_name: "Iva", is_bot: true },
    recipient: { chat_type: "dialog", chat_id: chatId, user_id: null },
    timestamp: Date.now(),
    body: { mid, seq: 1, text: "m" },
  },
});

/**
 * Mock MAX Bot API. Модель подписки как у MAX: если зарегистрирован webhook, события уходят ТОЛЬКО
 * туда, а GET /updates пуст; без подписки события копятся для long polling.
 * route(update) — «MAX получил событие от пользователя».
 */
export async function startMockMax({ token, webhookTarget = () => null }) {
  const received = []; // POST /messages
  const edits = []; // PUT /messages
  const answers = [];
  const deletes = [];
  const commands = [];
  const timeline = []; // хронология видимых пользователю сообщений: {type:'send'|'edit', mid, body}
  const updates = []; // очередь polling
  const subs = []; // { url, secret, types }
  const pollLog = []; // каждый GET /updates: { marker, subscribed }
  const state = { seq: 0, mid: 0, committed: 0, failNext: 0, status: 500, webhookDeliveries: [], uploadSeq: 0, uploadFail: 0, notReady: 0, mediaSeq: 0 };
  const media = new Map(); // id → { bytes, contentType, status, location }
  const mediaRequests = [];
  const endpoints = new Map(); // upload id → { type, upload? }
  const uploads = [];
  const uploadAuth = [];
  const deliveredFiles = []; // файлы, доставленные пользователю POST /messages (с байтами загрузки)
  const videos = new Map(); // token → { url }

  const server = createHttp(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const rawBuf = Buffer.concat(chunks);
    const raw = rawBuf.toString();
    const url = new URL(req.url, "http://x");
    const json = (obj, code = 200) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const p = url.pathname;
    // Хостинг файлов вложений: без авторизации, как CDN MAX. Фиксируем, не прислали ли нам токен бота.
    if (req.method === "GET" && p.startsWith("/media/")) {
      const id = p.slice(7);
      const f = media.get(id);
      mediaRequests.push({ id, authorization: req.headers.authorization ?? null });
      if (!f) { res.writeHead(404); return res.end(); }
      if (f.delayMs) await sleep(f.delayMs);
      if (f.status && f.status !== 200) { res.writeHead(f.status, f.status >= 300 && f.status < 400 && f.location ? { location: f.location } : {}); return res.end(); }
      res.writeHead(200, { "content-type": f.contentType ?? "application/octet-stream", "content-length": f.bytes.length });
      return res.end(f.bytes);
    }
    // Приём загрузки файла (адрес выдан POST /uploads): multipart, без авторизации.
    if (req.method === "POST" && p.startsWith("/upload/")) {
      const id = p.slice(8);
      const ep = endpoints.get(id);
      uploadAuth.push(req.headers.authorization ?? null);
      if (!ep) { res.writeHead(404); return res.end(); }
      if (state.uploadFail > 0) { state.uploadFail--; res.writeHead(500); return res.end("{}"); }
      const part = parseMultipart(rawBuf, req.headers["content-type"]);
      if (!part || part.field !== "data") { res.writeHead(400); return res.end("{}"); }
      ep.upload = { fileName: part.fileName, contentType: part.contentType, bytes: part.bytes };
      uploads.push({ id, type: ep.type, ...ep.upload });
      if (ep.type === "image") return json({ photos: { [`p${id}`]: { token: `ptok-${id}` } } });
      if (ep.type === "file") return json({ token: `ftok-${id}` });
      return json({ retval: "1" });
    }
    if (req.headers.authorization !== token) return json({ code: "verify.token", message: "bad token" }, 401);
    if (req.method === "POST" && p === "/uploads") {
      const type = url.searchParams.get("type");
      if (!["image", "video", "audio", "file"].includes(type)) return json({ code: "proto.payload", message: "bad type" }, 400);
      const id = String(++state.uploadSeq);
      endpoints.set(id, { type });
      return json({ url: `${api.url}/upload/${id}`, ...(type === "audio" || type === "video" ? { token: `etok-${id}` } : {}) });
    }
    if (req.method === "GET" && p.startsWith("/videos/")) {
      const t = decodeURIComponent(p.slice(8));
      const v = videos.get(t);
      if (!v) return json({ code: "not.found" }, 404);
      return json({ token: t, urls: { mp4_360: v.url }, width: 320, height: 240, duration: 3 });
    }
    if (req.method === "POST" && p === "/messages") {
      if (state.failNext > 0) {
        state.failNext--;
        res.writeHead(state.status);
        res.end("{}");
        return;
      }
      const body = JSON.parse(raw);
      if (Array.isArray(body.attachments) && body.attachments.some((a) => a.type !== "inline_keyboard")) {
        // как у MAX: вложение, ещё не обработанное платформой, отправить нельзя (HTTP 400)
        if (state.notReady > 0) { state.notReady--; return json({ code: "attachment.not.ready", message: "not ready" }, 400); }
        const a = body.attachments[0];
        const tok = a.payload?.token ?? Object.values(a.payload?.photos ?? {})[0]?.token;
        const known = String(tok ?? "");
        const id = known.replace(/^(ptok|ftok|etok)-/, "");
        const real = endpoints.get(id);
        if (!real?.upload) return json({ code: "attachment.not.ready", message: "no such upload" }, 400);
        deliveredFiles.push({ type: a.type, token: known, fileName: real.upload.fileName, bytes: real.upload.bytes, text: body.text ?? null });
      }
      const mid = `mid-${++state.mid}`;
      received.push({ query: url.search, text: body.text, body, mid });
      timeline.push({ type: "send", mid, body });
      return json({ message: { body: { mid, seq: state.mid } } });
    }
    if (req.method === "PUT" && p === "/messages") {
      edits.push({ mid: url.searchParams.get("message_id"), body: JSON.parse(raw) });
      timeline.push({ type: "edit", mid: url.searchParams.get("message_id"), body: JSON.parse(raw) });
      return json({ success: true });
    }
    if (req.method === "DELETE" && p === "/messages") {
      deletes.push(url.searchParams.get("message_id"));
      return json({ success: true });
    }
    if (req.method === "POST" && p === "/answers") {
      answers.push({ id: url.searchParams.get("callback_id"), body: JSON.parse(raw || "{}") });
      return json({ success: true });
    }
    if (req.method === "PATCH" && p === "/me/commands") {
      commands.push(...(JSON.parse(raw).commands ?? []));
      return json({ commands });
    }
    if (req.method === "GET" && p === "/me") return json({ user_id: 999, first_name: "Iva", username: "iva_test_bot", is_bot: true });
    if (p === "/subscriptions") {
      if (req.method === "GET") return json({ subscriptions: subs.map((s) => ({ url: s.url, time: 1, update_types: s.types })) });
      if (req.method === "POST") {
        const b = JSON.parse(raw);
        subs.push({ url: b.url, secret: b.secret, types: b.update_types });
        return json({ success: true });
      }
      if (req.method === "DELETE") {
        const i = subs.findIndex((s) => s.url === url.searchParams.get("url"));
        if (i >= 0) subs.splice(i, 1);
        return json({ success: true });
      }
    }
    if (req.method === "GET" && p === "/updates") {
      const m = url.searchParams.get("marker");
      if (m) state.committed = Math.max(state.committed, Number(m));
      pollLog.push({ marker: m, subscribed: subs.length > 0 });
      const from = m ? Number(m) : state.committed;
      const deadline = Date.now() + 1200;
      let batch = subs.length ? [] : updates.filter((u) => u.seq >= from);
      while (batch.length === 0 && Date.now() < deadline) {
        await sleep(50);
        batch = subs.length ? [] : updates.filter((u) => u.seq >= from);
      }
      const next = batch.length ? batch[batch.length - 1].seq + 1 : from || 1;
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(`{"updates":${toWire(batch.map((u) => u.update))},"marker":${next}}`);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  async function deliverWebhook(update, { secret } = {}) {
    const target = webhookTarget();
    const sub = subs[0];
    if (!target || !sub) throw new Error("no webhook subscription / target");
    const r = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json", "x-max-bot-api-secret": secret ?? sub.secret },
      body: toWire(update),
    });
    state.webhookDeliveries.push({ status: r.status, update_type: update.update_type });
    return r.status;
  }
  const api = {
    received, edits, answers, deletes, commands, subs, pollLog, state, timeline, mediaRequests, uploads, uploadAuth, deliveredFiles,
    /** Кладёт файл «на CDN MAX» и возвращает его URL (для payload.url входящего вложения). */
    hostFile(bytes, { contentType, status, location, delayMs } = {}) {
      const id = `f${++state.mediaSeq}`;
      media.set(id, { bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), contentType, status, location, delayMs });
      return `${api.url}/media/${id}`;
    },
    expireFile(url) { const f = media.get(new URL(url).pathname.slice(7)); if (f) f.status = 410; },
    hostVideo(token, bytes) { videos.set(token, { url: api.hostFile(bytes, { contentType: "video/mp4" }) }); },
    url: `http://127.0.0.1:${server.address().port}`,
    pushPoll: (update) => updates.push({ seq: ++state.seq, update }),
    deliverWebhook,
    /** «Пользователь что-то сделал»: MAX отдаёт событие ровно одному транспорту. */
    async route(update) {
      if (subs.length) return deliverWebhook(update);
      api.pushPoll(update);
      return null;
    },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
  return api;
}

export function startProc(cmd, args, { cwd, env, note = () => {}, tag = "" }) {
  const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const cap = (b) => String(b).split("\n").filter(Boolean).forEach((l) => note(tag ? `[${tag}] ${l}` : l));
  child.stdout.on("data", cap);
  child.stderr.on("data", cap);
  child.exited = new Promise((r) => child.once("exit", (code, sig) => r({ code, sig })));
  return child;
}
export async function stopProc(child, signal = "SIGTERM") {
  if (!child || child.exitCode !== null) return;
  const gone = new Promise((resolve) => child.once("exit", resolve));
  try {
    process.kill(-child.pid, signal);
  } catch {
    return;
  }
  if ((await Promise.race([gone, sleep(15_000).then(() => "t")])) === "t") {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
    await gone;
  }
}
export function run(cmd, args, { cwd, env, note = () => {} }) {
  return new Promise((res, rej) => {
    const c = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const cap = (b) => {
      out += b;
      String(b).split("\n").filter(Boolean).forEach(note);
    };
    c.stdout.on("data", cap);
    c.stderr.on("data", cap);
    c.on("exit", (code) => (code === 0 ? res(out) : rej(Object.assign(new Error(`${cmd} ${args.join(" ")} exited ${code}`), { out, code }))));
  });
}
/** Как run, но не бросает: { code, out }. */
export function runAny(cmd, args, opts) {
  return run(cmd, args, opts).then((out) => ({ code: 0, out }), (e) => ({ code: e.code, out: e.out ?? String(e.message) }));
}

export async function prepareApp(sandbox) {
  const app = join(sandbox, "app");
  await mkdir(join(app, "data"), { recursive: true });
  for (const d of ["agent", "scripts", "patches", "vault-template", "bin", "deploy"]) await cp(join(ROOT, d), join(app, d), { recursive: true });
  for (const f of ["package.json", "package-lock.json", "tsconfig.json"]) await cp(join(ROOT, f), join(app, f));
  await symlink(join(ROOT, "node_modules"), join(app, "node_modules"), "dir");
  return app;
}

/** Каталог с поддельными systemctl / systemd-run: пишут вызовы в файл; systemctl restart блокируется, пока есть файл-флаг. */
export async function makeFakeBin(dir) {
  await mkdir(dir, { recursive: true });
  const calls = join(dir, "calls.log");
  const blockFlag = join(dir, "block-restart");
  const failFlag = join(dir, "fail-restart");
  await writeFile(
    join(dir, "systemctl"),
    `#!/bin/sh
echo "systemctl $*" >> "${calls}"
case "$*" in
  *restart*)
    if [ -f "${blockFlag}" ]; then sleep 30; fi
    if [ -f "${failFlag}" ]; then echo "Failed to connect to bus" >&2; exit 1; fi ;;
esac
exit 0
`,
  );
  await writeFile(join(dir, "systemd-run"), `#!/bin/sh\necho "systemd-run $*" >> "${calls}"\nexit 0\n`);
  await chmod(join(dir, "systemctl"), 0o755);
  await chmod(join(dir, "systemd-run"), 0o755);
  return { calls, blockFlag, failFlag };
}
