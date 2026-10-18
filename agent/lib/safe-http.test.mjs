import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MediaFetchError, checkMediaUrl, downloadToFile, isPublicAddress, uploadFileMultipart } from "./safe-http.ts";
import { parseMultipart } from "../../scripts/lib/max-e2e-kit.mjs";

const dir = mkdtempSync(join(tmpdir(), "iva-safehttp-"));
const LOOP = { allowHttp: true, allowLoopback: true };

async function serve(handler) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

test("isPublicAddress: public addresses pass, every internal range is refused", () => {
  for (const ip of ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111", "1.1.1.1"]) assert.equal(isPublicAddress(ip), true, ip);
  for (const ip of [
    "127.0.0.1", "127.1.2.3", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1",
    "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:10.1.2.3", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "2001:db8::1", "not-an-ip", "999.1.1.1",
  ]) assert.equal(isPublicAddress(ip), false, ip);
});

test("checkMediaUrl: scheme, credentials, literal internal IPs and host allowlist", () => {
  assert.throws(() => checkMediaUrl("http://example.com/a", {}), (e) => e.code === "bad-scheme");
  assert.throws(() => checkMediaUrl("file:///etc/passwd", { allowHttp: true }), (e) => e.code === "bad-scheme");
  assert.throws(() => checkMediaUrl("ftp://example.com/a", {}), (e) => e.code === "bad-scheme");
  assert.throws(() => checkMediaUrl("https://user:pw@example.com/a", {}), (e) => e.code === "bad-url");
  assert.throws(() => checkMediaUrl("not a url", {}), (e) => e.code === "bad-url");
  assert.throws(() => checkMediaUrl("https://169.254.169.254/latest/meta-data", {}), (e) => e.code === "ssrf-blocked");
  assert.throws(() => checkMediaUrl("https://127.0.0.1/x", {}), (e) => e.code === "ssrf-blocked");
  assert.throws(() => checkMediaUrl("https://[::1]/x", {}), (e) => e.code === "ssrf-blocked");
  assert.throws(() => checkMediaUrl("https://[::ffff:10.0.0.1]/x", {}), (e) => e.code === "ssrf-blocked");
  assert.throws(() => checkMediaUrl("https://evil.example/x", { allowedHostSuffixes: [".okcdn.ru"] }), (e) => e.code === "host-not-allowed");
  assert.throws(() => checkMediaUrl("https://okcdn.ru.evil.example/x", { allowedHostSuffixes: ["okcdn.ru"] }), (e) => e.code === "host-not-allowed");
  assert.equal(checkMediaUrl("https://vu.okcdn.ru/x", { allowedHostSuffixes: [".okcdn.ru"] }).hostname, "vu.okcdn.ru");
  // loopback разрешён только явным флагом тестового режима, и только он: остальные внутренние сети закрыты всегда
  assert.equal(checkMediaUrl("http://127.0.0.1:9/x", LOOP).hostname, "127.0.0.1");
  assert.throws(() => checkMediaUrl("http://169.254.169.254/x", LOOP), (e) => e.code === "ssrf-blocked");
  assert.throws(() => checkMediaUrl("http://10.0.0.1/x", LOOP), (e) => e.code === "ssrf-blocked");
});

test("downloadToFile streams to disk and reports size and the server-declared type", async () => {
  const body = Buffer.alloc(300_000, 7);
  const s = await serve((req, res) => { res.writeHead(200, { "content-type": "Image/PNG; charset=x", "content-length": body.length }); res.end(body); });
  try {
    const dest = join(dir, "ok.bin");
    const r = await downloadToFile(`${s.url}/a`, dest, { ...LOOP, maxBytes: 1_000_000 });
    assert.equal(r.bytes, body.length);
    assert.equal(r.contentType, "image/png");
    assert.deepEqual(readFileSync(dest), body);
  } finally { await s.close(); }
});

test("downloadToFile refuses an oversized file by Content-Length and by actual bytes, leaving nothing behind", async () => {
  const big = Buffer.alloc(200_000, 1);
  const s = await serve((req, res) => {
    if (req.url === "/declared") { res.writeHead(200, { "content-length": big.length }); return res.end(big); }
    res.writeHead(200); // без Content-Length: chunked
    res.write(big.subarray(0, 100_000));
    setTimeout(() => res.end(big.subarray(100_000)), 20);
  });
  try {
    for (const p of ["declared", "chunked"]) {
      const dest = join(dir, `${p}.bin`);
      await assert.rejects(downloadToFile(`${s.url}/${p}`, dest, { ...LOOP, maxBytes: 150_000 }), (e) => e instanceof MediaFetchError && e.code === "too-large");
      assert.equal(existsSync(dest), false, `${p}: partial file removed`);
    }
  } finally { await s.close(); }
});

test("downloadToFile: expired link (410/404) is not retryable, 5xx is", async () => {
  const s = await serve((req, res) => { res.writeHead(Number(req.url.slice(1))); res.end(); });
  try {
    for (const [code, retryable] of [[410, false], [404, false], [403, false], [503, true], [429, true]]) {
      await assert.rejects(downloadToFile(`${s.url}/${code}`, join(dir, "x"), { ...LOOP, maxBytes: 10 }), (e) => e.code === "http-error" && e.status === code && e.retryable === retryable);
    }
  } finally { await s.close(); }
});

test("downloadToFile follows a bounded number of redirects and re-checks EVERY hop", async () => {
  const s = await serve((req, res) => {
    const n = req.url;
    if (n === "/ok") { res.writeHead(200); return res.end("fine"); }
    if (n === "/r1") { res.writeHead(302, { location: "/ok" }); return res.end(); }
    if (n === "/loop") { res.writeHead(302, { location: "/loop" }); return res.end(); }
    if (n === "/to-metadata") { res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }); return res.end(); }
    if (n === "/to-file") { res.writeHead(302, { location: "file:///etc/passwd" }); return res.end(); }
    if (n === "/to-private") { res.writeHead(302, { location: "http://10.0.0.1/x" }); return res.end(); }
    res.writeHead(404); res.end();
  });
  try {
    const dest = join(dir, "red.bin");
    assert.equal((await downloadToFile(`${s.url}/r1`, dest, { ...LOOP, maxBytes: 100 })).bytes, 4);
    await assert.rejects(downloadToFile(`${s.url}/loop`, dest, { ...LOOP, maxBytes: 100 }), (e) => e.code === "too-many-redirects");
    await assert.rejects(downloadToFile(`${s.url}/to-metadata`, dest, { ...LOOP, maxBytes: 100 }), (e) => e.code === "ssrf-blocked");
    await assert.rejects(downloadToFile(`${s.url}/to-file`, dest, { ...LOOP, maxBytes: 100 }), (e) => e.code === "bad-scheme");
    await assert.rejects(downloadToFile(`${s.url}/to-private`, dest, { ...LOOP, maxBytes: 100 }), (e) => e.code === "ssrf-blocked");
  } finally { await s.close(); }
});

test("downloadToFile: without the loopback flag even localhost is unreachable (DNS result is checked at connect time)", async () => {
  const s = await serve((req, res) => { res.writeHead(200); res.end("secret"); });
  try {
    // http запрещён по схеме; https к localhost — по адресу. В обоих случаях запрос не уходит.
    await assert.rejects(downloadToFile(`${s.url}/a`, join(dir, "no"), { maxBytes: 100 }), (e) => e.code === "bad-scheme");
    await assert.rejects(downloadToFile(`${s.url.replace("127.0.0.1", "localhost")}/a`, join(dir, "no"), { allowHttp: true, maxBytes: 100 }), (e) => e.code === "ssrf-blocked");
    await assert.rejects(downloadToFile(`${s.url}/a`, join(dir, "no"), { allowHttp: true, maxBytes: 100 }), (e) => e.code === "ssrf-blocked");
  } finally { await s.close(); }
});

test("downloadToFile: stalled server is cut by the timeout", async () => {
  const s = await serve((req, res) => { res.writeHead(200); res.write("x"); /* и молчит */ });
  try {
    await assert.rejects(downloadToFile(`${s.url}/a`, join(dir, "stall"), { ...LOOP, maxBytes: 100, timeoutMs: 600 }), (e) => e.code === "timeout" || e.code === "network");
  } finally { await s.close(); }
});

test("downloadToFile never sends an Authorization header", async () => {
  let seen;
  const s = await serve((req, res) => { seen = req.headers; res.writeHead(200); res.end("x"); });
  try {
    await downloadToFile(`${s.url}/a`, join(dir, "h"), { ...LOOP, maxBytes: 10 });
    assert.equal(seen.authorization, undefined);
    assert.equal(seen.cookie, undefined);
  } finally { await s.close(); }
});

test("uploadFileMultipart streams the file as multipart field `data` with a correct Content-Length", async () => {
  const payload = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
  const src = join(dir, "up.bin");
  (await import("node:fs")).writeFileSync(src, payload);
  let got;
  const s = await serve(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const buf = Buffer.concat(chunks);
    got = { len: Number(req.headers["content-length"]), actual: buf.length, part: parseMultipart(buf, req.headers["content-type"]) };
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"token":"t"}');
  });
  try {
    const r = await uploadFileMultipart(`${s.url}/u`, src, { ...LOOP, fileName: 'we"ird\r\nname.bin', mimeType: "application/octet-stream" });
    assert.deepEqual(JSON.parse(r.body), { token: "t" });
    assert.equal(got.len, got.actual);
    assert.equal(got.part.field, "data");
    assert.equal(got.part.fileName, "we_ird__name.bin"); // кавычки и переводы строк не ломают заголовок
    assert.deepEqual(got.part.bytes, payload);
    await assert.rejects(uploadFileMultipart("https://127.0.0.1/u", src, { fileName: "a" }), (e) => e.code === "ssrf-blocked");
    await assert.rejects(uploadFileMultipart("http://example.com/u", src, { fileName: "a" }), (e) => e.code === "bad-scheme");
  } finally { await s.close(); }
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
