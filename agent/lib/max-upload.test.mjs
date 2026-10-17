import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATTACHMENT_NOT_READY, MaxApiError, createMaxClient } from "./max-api.ts";
import { createMaxOutbox } from "./max-outbox.ts";
import { createMaxStore } from "./max-store.ts";
import { checkSendableFile, uploadTypeFor } from "./max-send-policy.ts";
import { sniffBuffer } from "./media-sniff.ts";
import { makeDocx, makePdf, makePng, makeVoice, makeXlsx } from "../../scripts/lib/media-fixtures.mjs";
import { startMockMax } from "../../scripts/lib/max-e2e-kit.mjs";

const quiet = () => {};
const TOKEN = "bot-token-1";

async function rig(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "max-up-"));
  const api = await startMockMax({ token: TOKEN });
  const client = createMaxClient({ token: TOKEN, baseUrl: api.url });
  const mk = () => {
    const store = createMaxStore({ dir: join(root, "max"), log: quiet });
    const outbox = createMaxOutbox({ store, client, minIntervalMs: 0, backoffBaseMs: 10, notReadyBaseMs: 5, tickMs: 50, log: quiet, ...extra });
    return { store, outbox };
  };
  const first = mk();
  const outDir = join(root, "vault", "attachments");
  mkdirSync(outDir, { recursive: true });
  const put = (name, data) => {
    const p = join(outDir, name);
    writeFileSync(p, data);
    return p;
  };
  return { root, api, client, ...first, mk, put, close: async () => { first.outbox.stop(); await api.close(); rmSync(root, { recursive: true, force: true }); } };
}
const fileOf = (checked) => ({ path: checked.realPath, fileName: checked.fileName, uploadType: checked.uploadType, mimeType: checked.mimeType, size: checked.size });
const vaultEnv = (root) => ({ ASSISTANT_VAULT_DIR: join(root, "vault"), ASSISTANT_DATA_DIR: join(root, "data") });

test("upload flow per attachment type: POST /uploads?type=… → multipart `data` → POST /messages with the right payload; bytes arrive intact", async () => {
  const r = await rig();
  try {
    const cases = [
      ["report.xlsx", makeXlsx({ sheets: [{ name: "A", rows: [["x", 1]] }] }), "file", { token: /^ftok-/ }],
      ["offer.pdf", makePdf(["Offer 42"]), "file", { token: /^ftok-/ }],
      ["shot.png", makePng("hello"), "image", { photos: true }],
      ["reply.ogg", makeVoice("reply"), "audio", { token: /^etok-/ }],
    ];
    for (const [name, bytes, type, shape] of cases) {
      const checked = checkSendableFile(r.put(name, bytes), { env: vaultEnv(r.root) });
      assert.equal(checked.ok, true, name);
      assert.equal(checked.uploadType, type, name);
      r.outbox.enqueueFile("111", fileOf(checked), `caption for ${name}`);
      await r.outbox.idle();
    }
    assert.equal(r.api.deliveredFiles.length, cases.length);
    for (const [i, [name, bytes, type, shape]] of cases.entries()) {
      const d = r.api.deliveredFiles[i];
      assert.equal(d.type, type);
      assert.equal(d.fileName, name);
      assert.deepEqual(d.bytes, bytes, `${name}: the uploaded bytes equal the source file`);
      assert.equal(d.text, `caption for ${name}`);
      const sent = r.api.received[i].body.attachments[0];
      assert.equal(sent.type, type);
      if (shape.photos) assert.ok(Object.values(sent.payload.photos)[0].token, "image payload carries photos{…token}");
      else assert.match(sent.payload.token, shape.token);
      assert.match(r.api.received[i].query, /user_id=111|chat_id=/);
    }
    assert.ok(r.api.uploadAuth.every((a) => a === null), "the bot token is never sent to the upload host");
    assert.deepEqual(r.store.stats(), { ...r.store.stats(), queued: 0, dead: 0 });
  } finally { await r.close(); }
});

test("MAX still processing the attachment: bounded retries reuse the SAME upload (no re-upload), then it is delivered", async () => {
  const r = await rig();
  try {
    r.api.state.notReady = 3;
    const checked = checkSendableFile(r.put("a.pdf", makePdf(["x"])), { env: vaultEnv(r.root) });
    r.outbox.enqueueFile("111", fileOf(checked), "cap");
    await new Promise((res) => setTimeout(res, 50));
    await r.outbox.idle();
    for (let i = 0; i < 80 && r.api.deliveredFiles.length === 0; i++) await new Promise((res) => setTimeout(res, 50));
    assert.equal(r.api.deliveredFiles.length, 1);
    assert.equal(r.api.uploads.length, 1, "uploaded exactly once");
    assert.equal(r.store.stats().queued, 0);
  } finally { await r.close(); }
});

test("MAX never finishes processing: gives up after a bounded number of attempts and TELLS the user", async () => {
  const r = await rig();
  try {
    r.api.state.notReady = 1000;
    const checked = checkSendableFile(r.put("a.pdf", makePdf(["x"])), { env: vaultEnv(r.root) });
    r.outbox.enqueueFile("111", fileOf(checked), "cap");
    for (let i = 0; i < 200 && r.store.stats().dead === 0; i++) await new Promise((res) => setTimeout(res, 50));
    assert.equal(r.store.stats().dead, 1);
    for (let i = 0; i < 40 && r.api.received.length === 0; i++) await new Promise((res) => setTimeout(res, 50));
    assert.equal(r.api.received.length, 1, "one text notice");
    assert.match(r.api.received[0].text, /Не удалось отправить файл «a\.pdf»/);
    assert.equal(r.api.deliveredFiles.length, 0);
    const dead = r.store.stats().deadItems[0];
    assert.equal(dead.file.path, "", "dead-letter diagnostics keep no path");
    assert.equal(dead.file.attachment, undefined, "…and no attachment token");
    assert.equal(dead.text, "");
  } finally { await r.close(); }
});

test("upload host error: retried; the attachment token is persisted only after a successful upload", async () => {
  const r = await rig();
  try {
    r.api.state.uploadFail = 2;
    const checked = checkSendableFile(r.put("n.docx", makeDocx({ paragraphs: ["hi"] })), { env: vaultEnv(r.root) });
    r.outbox.enqueueFile("111", fileOf(checked), "");
    for (let i = 0; i < 100 && r.api.deliveredFiles.length === 0; i++) await new Promise((res) => setTimeout(res, 50));
    assert.equal(r.api.deliveredFiles.length, 1);
    assert.equal(r.api.deliveredFiles[0].text, null, "no caption → no text field");
    assert.equal(r.api.uploads.length, 1, "only the successful upload is recorded");
  } finally { await r.close(); }
});

test("a restart after the upload but before the send resumes WITHOUT uploading again", async () => {
  const r = await rig();
  try {
    r.api.state.notReady = 1000; // отправка не проходит, загрузка проходит
    const checked = checkSendableFile(r.put("r.pdf", makePdf(["resume me"])), { env: vaultEnv(r.root) });
    r.outbox.enqueueFile("111", fileOf(checked), "cap");
    for (let i = 0; i < 60 && r.api.uploads.length === 0; i++) await new Promise((res) => setTimeout(res, 20));
    assert.equal(r.api.uploads.length, 1);
    r.outbox.stop(); // «процесс умер»
    await new Promise((res) => setTimeout(res, 100));
    r.api.state.notReady = 0;
    const second = r.mk();
    second.outbox.start();
    for (let i = 0; i < 100 && r.api.deliveredFiles.length === 0; i++) await new Promise((res) => setTimeout(res, 50));
    second.outbox.stop();
    assert.equal(r.api.deliveredFiles.length, 1);
    assert.equal(r.api.uploads.length, 1, "no second upload after the restart");
  } finally { await r.close(); }
});

test("the file disappeared / was replaced while queued: permanent failure with a user-visible notice", async () => {
  const r = await rig();
  try {
    const a = r.put("gone.pdf", makePdf(["x"]));
    const b = r.put("changed.pdf", makePdf(["y"]));
    const ca = checkSendableFile(a, { env: vaultEnv(r.root) });
    const cb = checkSendableFile(b, { env: vaultEnv(r.root) });
    // перед доставкой портим состояние диска: пока воркер не стартовал, блокируем отправку очередью ожидания
    r.api.state.failNext = 0;
    rmSync(a);
    writeFileSync(b, Buffer.concat([makePdf(["y"]), Buffer.from("tail")]));
    r.outbox.enqueueFile("111", fileOf(ca), "");
    r.outbox.enqueueFile("111", fileOf(cb), "");
    for (let i = 0; i < 100 && r.api.received.length < 2; i++) await new Promise((res) => setTimeout(res, 50));
    assert.equal(r.api.deliveredFiles.length, 0);
    assert.equal(r.api.uploads.length, 0, "nothing was uploaded");
    assert.equal(r.api.received.length, 2);
    assert.match(r.api.received[0].text, /gone\.pdf/);
    assert.match(r.api.received[1].text, /changed\.pdf/);
  } finally { await r.close(); }
});

test("delivery order is kept across text and file items", async () => {
  const r = await rig();
  try {
    r.outbox.enqueue("111", "before");
    r.outbox.enqueueFile("111", fileOf(checkSendableFile(r.put("o.pdf", makePdf(["o"])), { env: vaultEnv(r.root) })), "file-caption");
    r.outbox.enqueue("111", "after");
    await r.outbox.idle();
    for (let i = 0; i < 60 && r.api.received.length < 3; i++) await new Promise((res) => setTimeout(res, 50));
    assert.deepEqual(r.api.received.map((m) => m.text), ["before", "file-caption", "after"]);
  } finally { await r.close(); }
});

test("client: `photo` is never used as an upload type; unknown types are rejected by the API", async () => {
  const r = await rig();
  try {
    await assert.rejects(r.client.getUploadEndpoint("photo"), (e) => e instanceof MaxApiError && e.status === 400);
    const ep = await r.client.getUploadEndpoint("image");
    assert.match(ep.url, /\/upload\//);
  } finally { await r.close(); }
});

test("client: 400 on sending a fresh attachment is classified as attachment.not.ready (retryable); other statuses keep their class", async () => {
  const r = await rig();
  try {
    r.api.state.notReady = 1;
    await assert.rejects(r.client.sendAttachment({ chatId: null, userId: "1" }, { attachment: { type: "file", payload: { token: "x" } } }), (e) => e.code === ATTACHMENT_NOT_READY && e.retryable === true && e.status === 400);
    r.api.state.failNext = 1;
    r.api.state.status = 403;
    await assert.rejects(r.client.sendAttachment({ chatId: null, userId: "1" }, { attachment: { type: "file", payload: { token: "x" } } }), (e) => e.status === 403 && e.retryable === false);
  } finally { await r.close(); }
});

// ───────────── политика исходящих файлов ─────────────

test("send policy: only vault / data/outbox / MAX_SEND_ROOTS, by real path", () => {
  const root = mkdtempSync(join(tmpdir(), "max-pol-"));
  try {
    const env = { ...vaultEnv(root), MAX_SEND_ROOTS: join(root, "extra") };
    for (const d of ["vault/attachments", "data/outbox", "data/max", "extra", "elsewhere"]) mkdirSync(join(root, d), { recursive: true });
    const w = (rel, data = "hello world\n") => { const p = join(root, rel); writeFileSync(p, data); return p; };
    assert.equal(checkSendableFile(w("vault/attachments/a.txt"), { env }).ok, true);
    assert.equal(checkSendableFile(w("data/outbox/a.txt"), { env }).ok, true);
    assert.equal(checkSendableFile(w("extra/a.txt"), { env }).ok, true);
    assert.equal(checkSendableFile(w("elsewhere/a.txt"), { env }).code, "outside-roots");
    assert.equal(checkSendableFile(w("data/max/state.json", "{}"), { env }).code, "outside-roots");
    assert.equal(checkSendableFile("/etc/passwd", { env }).code, "outside-roots");
    assert.equal(checkSendableFile(join(root, "vault/attachments/../../elsewhere/a.txt"), { env }).code, "outside-roots");
    // симлинк внутри vault на файл вне разрешённых каталогов не обходит проверку
    symlinkSync(join(root, "elsewhere/a.txt"), join(root, "vault/attachments/link.txt"));
    assert.equal(checkSendableFile(join(root, "vault/attachments/link.txt"), { env }).code, "outside-roots");
    assert.equal(checkSendableFile(join(root, "vault/attachments/missing.txt"), { env }).code, "not-found");
    assert.equal(checkSendableFile(join(root, "vault/attachments"), { env }).code, "not-a-file");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("send policy: secrets, executables, empty and oversized files are refused with a reason", () => {
  const root = mkdtempSync(join(tmpdir(), "max-pol2-"));
  try {
    const env = { ...vaultEnv(root), MAX_UPLOAD_MAX_BYTES: "5000" };
    mkdirSync(join(root, "vault"), { recursive: true });
    const w = (name, data) => { const p = join(root, "vault", name); writeFileSync(p, data); return p; };
    for (const name of [".env", ".env.local", "id_rsa", "server.pem", "codex-auth.json", "client_secret_123.json", "tokens.json", "credentials.json"]) {
      assert.equal(checkSendableFile(w(name, "anything"), { env }).code, "secret-file", name);
    }
    assert.equal(checkSendableFile(w("notes.txt", "API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456\n"), { env }).code, "contains-secret");
    assert.equal(checkSendableFile(w("cfg.txt", "password: hunter2hunter2\n"), { env }).code, "contains-secret");
    assert.equal(checkSendableFile(w("run.txt", "#!/bin/sh\necho hi\n"), { env }).code, "executable");
    assert.equal(checkSendableFile(w("app.bin", Buffer.from("MZ\x90\0")), { env }).code, "executable");
    assert.equal(checkSendableFile(w("empty.txt", ""), { env }).code, "empty");
    const big = w("big.bin", Buffer.alloc(10));
    truncateSync(big, 6000);
    assert.equal(checkSendableFile(big, { env }).code, "too-large");
    const ok = checkSendableFile(w("fine.txt", "just a note\n"), { env });
    assert.equal(ok.ok, true);
    assert.equal(ok.uploadType, "file");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("send policy: upload type follows the real content and MAX's documented format lists", () => {
  const t = (buf, size = buf.length) => uploadTypeFor(sniffBuffer(buf), size);
  assert.equal(t(makePng("x")), "image");
  assert.equal(t(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), "image");
  assert.equal(t(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")])), "file", "WEBP is not in the documented image list → sent as a file");
  assert.equal(t(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom"), Buffer.alloc(8)])), "video");
  assert.equal(t(makeVoice("x")), "audio");
  assert.equal(t(Buffer.from("#!AMR\n....")), "file");
  assert.equal(t(makePdf(["x"])), "file");
  assert.equal(t(makePng("x"), 60 * 1024 * 1024), "file", "an image over MAX's 50 MB limit is sent as a file");
});

test("send policy: names are neutralised", () => {
  const root = mkdtempSync(join(tmpdir(), "max-pol3-"));
  try {
    mkdirSync(join(root, "vault"), { recursive: true });
    const p = join(root, "vault", "r.pdf");
    writeFileSync(p, makePdf(["x"]));
    const c = checkSendableFile(p, { env: vaultEnv(root), displayName: "../../etc/Отчёт: итог?.pdf" });
    assert.equal(c.ok, true);
    assert.equal(c.fileName, "Отчёт_ итог.pdf");
    chmodSync(p, 0o600);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
