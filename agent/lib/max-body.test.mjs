import test from "node:test";
import assert from "node:assert/strict";
import { readBodyLimited } from "./max-body.ts";

const enc = new TextEncoder();
const reqOf = (body, headers = {}) =>
  new Request("http://x/", { method: "POST", body, headers, duplex: "half" });

test("reads a normal body", async () => {
  const r = await readBodyLimited(reqOf('{"a":"привет"}'), { maxBytes: 1000, timeoutMs: 1000 });
  assert.deepEqual(r, { ok: true, text: '{"a":"привет"}' });
});

test("declared Content-Length above limit is rejected without reading", async () => {
  let pulled = 0;
  const body = new ReadableStream({ pull(c) { pulled++; c.enqueue(enc.encode("x")); } });
  const r = await readBodyLimited(reqOf(body, { "content-length": "5000" }), { maxBytes: 100, timeoutMs: 1000 });
  assert.equal(r.status, 413);
  assert.ok(pulled <= 1);
});

test("stream larger than limit with NO Content-Length stops early and cancels the source", async () => {
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(c) { pulled++; c.enqueue(enc.encode("x".repeat(1024))); },
    cancel() { cancelled = true; },
  });
  const r = await readBodyLimited(reqOf(body), { maxBytes: 4096, timeoutMs: 1000 });
  assert.equal(r.status, 413);
  assert.equal(r.reason, "too-large");
  assert.ok(pulled < 20, `pulled ${pulled} chunks`); // ограничено, а не бесконечно
  assert.equal(cancelled, true);
});

test("lying (too small) Content-Length does not bypass the byte limit", async () => {
  const body = new ReadableStream({
    pull(c) { c.enqueue(enc.encode("y".repeat(512))); },
  });
  const r = await readBodyLimited(reqOf(body, { "content-length": "10" }), { maxBytes: 2048, timeoutMs: 1000 });
  assert.equal(r.status, 413);
});

test("slow / stalled stream is cut off by the time limit", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(c) { c.enqueue(enc.encode("{")); },
    pull() { return new Promise(() => {}); }, // никогда не отдаёт данные
    cancel() { cancelled = true; },
  });
  const t0 = Date.now();
  const r = await readBodyLimited(reqOf(body), { maxBytes: 1000, timeoutMs: 100 });
  assert.equal(r.status, 408);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(cancelled, true);
});

test("garbage Content-Length → 400", async () => {
  const r = await readBodyLimited(reqOf("{}", { "content-length": "abc" }), { maxBytes: 100, timeoutMs: 100 });
  assert.equal(r.status, 400);
});
