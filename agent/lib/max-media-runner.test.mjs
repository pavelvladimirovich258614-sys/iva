// Fault injection для исполнителя медиа-заданий: тайм-аут send() (исход неизвестен), отказ outbox и диска
// при постановке уведомлений, падение процесса в каждом состоянии задания.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMediaJobs } from "./max-media-jobs.ts";
import { createMediaRunner } from "./max-media-runner.ts";
import { writeJsonAtomic } from "./max-store.ts";
import { startSendOnce } from "./send-guard.ts";

const quiet = () => {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, what, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(5);
  }
  throw new Error(`timeout waiting for: ${what}`);
};

const baseJob = (key = "msg:1") => ({ key, userId: "111", chatId: "500", text: "голосовое", mid: "1", attachments: [], linked: null });
const okResult = { outcomes: [], contextText: "[audio #1] transcript", userNotices: [], usable: true };

function rig({ result = okResult, runnerOpts = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "max-runner-"));
  const dir = join(root, "max");
  const disk = { failing: false };
  const io = { writeJson: (f, v) => { if (disk.failing) throw Object.assign(new Error("ENOSPC: no space left"), { code: "ENOSPC" }); writeJsonAtomic(f, v); } };
  const outbox = { failing: false, sent: [] };
  const reply = (u, t) => { if (outbox.failing) throw new Error("outbox.json: cannot persist (ENOSPC)"); outbox.sent.push([u, t]); };
  const jobs = createMediaJobs({ dir, log: quiet, io });
  const mk = (jobsInstance = jobs, extra = {}) =>
    createMediaRunner({ jobs: jobsInstance, processor: { process: async () => result }, reply, log: quiet, retryDelayMs: 0, sendTimeoutMs: 40, unknownGraceMs: 120, ...runnerOpts, ...extra });
  const onDisk = () => (existsSync(join(dir, "media-jobs.json")) ? JSON.parse(readFileSync(join(dir, "media-jobs.json"), "utf8")).jobs : {});
  return { root, dir, disk, io, outbox, jobs, mk, onDisk, reopen: () => createMediaJobs({ dir, log: quiet, io }), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const submit = (r, runner, send, key = "msg:1") => {
  const job = r.jobs.accept(baseJob(key));
  return runner.run(job, send);
};

// ───────────── 1. тайм-аут send(): исходный вызов не отменён → повторять нельзя ─────────────

test("startSendOnce: a timeout is an unknown outcome and exposes the ORIGINAL operation", async () => {
  let finish;
  const r = await startSendOnce(() => new Promise((res) => (finish = res)), 10);
  assert.equal(r.kind, "timeout");
  finish("done");
  assert.deepEqual(await r.settled, { ok: true });
  const bad = await startSendOnce(() => Promise.reject(new Error("x")), 50);
  assert.equal(bad.kind, "rejected");
  const sync = await startSendOnce(() => { throw new Error("sync"); }, 50);
  assert.equal(sync.kind, "rejected");
  assert.equal((await startSendOnce(async () => 1, 50)).kind, "ok");
});

test("REGRESSION: first send() outlives the timeout and then succeeds — exactly ONE execution, no second turn, no user alarm", async () => {
  const r = rig({ runnerOpts: { unknownGraceMs: 500 } });
  try {
    let calls = 0;
    const runner = r.mk();
    const send = () => { calls++; return sleep(120); }; // дольше тайм-аута (40 мс), но завершится успешно
    await submit(r, runner, send);
    assert.equal(calls, 1, "no retry was started while the first call was still running");
    assert.equal(r.onDisk()["msg:1"].state, "unknown", "the unknown outcome is durable while we wait");
    await until(() => r.jobs.list().length === 0, "job removed after the original call succeeded");
    await sleep(100);
    assert.equal(calls, 1, "still exactly one execution");
    assert.deepEqual(r.outbox.sent, [], "a fast late success needs no notice");
    assert.deepEqual(r.onDisk(), {});
  } finally { r.cleanup(); }
});

test("a send() that succeeds only AFTER the grace period: one 'unknown' notice, one follow-up, still one execution", async () => {
  const r = rig({ runnerOpts: { unknownGraceMs: 30 } });
  try {
    let calls = 0;
    await submit(r, r.mk(), () => { calls++; return sleep(150); });
    await until(() => r.outbox.sent.length === 1, "unknown notice");
    assert.match(r.outbox.sent[0][1], /Не знаю, получил ли агент|cannot tell whether/);
    assert.match(r.outbox.sent[0][1], /НЕ повторяла|did NOT repeat/);
    await until(() => r.jobs.list().length === 0, "job removed after late success");
    assert.equal(r.outbox.sent.length, 2);
    assert.match(r.outbox.sent[1][1], /всё-таки получил|did receive/);
    assert.equal(calls, 1);
  } finally { r.cleanup(); }
});

test("a send() that times out and later FAILS: one clear notice, no automatic re-run", async () => {
  const r = rig();
  try {
    let calls = 0;
    await submit(r, r.mk(), () => { calls++; return sleep(80).then(() => { throw new Error("workflow world unavailable"); }); });
    await until(() => r.jobs.list().length === 0, "job settled after late failure");
    assert.equal(calls, 1);
    assert.equal(r.outbox.sent.length, 1);
    assert.match(r.outbox.sent[0][1], /передать его агенту не удалось|could not hand it to the agent/);
  } finally { r.cleanup(); }
});

test("a send() that never answers: owner is told the outcome is unknown ONCE; restart neither repeats nor repeats the notice", async () => {
  const r = rig({ runnerOpts: { unknownGraceMs: 30 } });
  try {
    let calls = 0;
    await submit(r, r.mk(), () => { calls++; return new Promise(() => {}); });
    await until(() => r.outbox.sent.length === 1, "unknown notice");
    assert.equal(r.onDisk()["msg:1"].noticeSent, true);
    // «перезапуск»: новый процесс читает диск
    const again = r.reopen();
    const runner2 = r.mk(again);
    assert.equal(runner2.recover(), 1);
    assert.equal(again.list().length, 0, "job is closed — the owner already knows");
    assert.equal(r.outbox.sent.length, 1, "no second notice");
    assert.equal(calls, 1, "nothing was re-run");
  } finally { r.cleanup(); }
});

test("definite rejections (the run did not start) are retried a bounded number of times, then reported", async () => {
  const r = rig();
  try {
    let calls = 0;
    await submit(r, r.mk(), async () => { calls++; throw new Error("agent unavailable"); });
    assert.equal(calls, 3);
    assert.equal(r.outbox.sent.length, 1);
    assert.deepEqual(r.onDisk(), {});
    // успех со второй попытки — без уведомлений
    calls = 0;
    await submit(r, r.mk(), async () => { if (++calls < 2) throw new Error("blip"); }, "msg:2");
    assert.equal(calls, 2);
    assert.equal(r.outbox.sent.length, 1);
  } finally { r.cleanup(); }
});

// ───────────── 2. потеря задания и уведомления ─────────────

test("REGRESSION: hand-off failed AND the outbox is down — the job is NOT dropped; the notice is retried until it is queued", async () => {
  const r = rig();
  try {
    r.outbox.failing = true;
    const runner = r.mk();
    await submit(r, runner, async () => { throw new Error("agent down"); });
    const left = r.onDisk()["msg:1"];
    assert.ok(left, "the job survives on disk");
    assert.equal(left.state, "notify");
    assert.equal(left.pendingNotices.length, 1);
    assert.equal(r.outbox.sent.length, 0);
    // outbox всё ещё недоступен: повтор не теряет и не дублирует
    assert.equal(runner.flush(), 1);
    assert.equal(r.outbox.sent.length, 0);
    // outbox вернулся
    r.outbox.failing = false;
    assert.equal(runner.flush(), 0);
    assert.equal(r.outbox.sent.length, 1);
    assert.match(r.outbox.sent[0][1], /передать его агенту не удалось|could not hand it to the agent/);
    assert.deepEqual(r.onDisk(), {}, "removed only after the notice was queued");
    assert.equal(runner.flush(), 0);
    assert.equal(r.outbox.sent.length, 1, "delivered exactly once");
  } finally { r.cleanup(); }
});

test("the notice survives a process restart when the outbox was down", async () => {
  const r = rig();
  try {
    r.outbox.failing = true;
    await submit(r, r.mk(), async () => { throw new Error("agent down"); });
    // процесс умер; поднимается новый, outbox уже работает
    r.outbox.failing = false;
    const again = r.reopen();
    const runner2 = r.mk(again);
    runner2.recover();
    assert.equal(r.outbox.sent.length, 1);
    assert.deepEqual(r.onDisk(), {});
    assert.equal(again.list().length, 0);
  } finally { r.cleanup(); }
});

test("DISK failure while queueing the notice: job+notice kept in memory, delivered after the disk recovers, nothing lost", async () => {
  const r = rig();
  try {
    const runner = r.mk();
    // после принятия задания (оно уже на диске) диск и outbox отказывают
    const job = r.jobs.accept(baseJob());
    r.disk.failing = true;
    r.outbox.failing = true;
    await runner.run(job, async () => { throw new Error("agent down"); });
    assert.equal(r.jobs.list().length, 1, "still held in memory");
    assert.equal(r.jobs.list()[0].state, "notify");
    assert.equal(r.jobs.health().persistFailing, true, "the failure is visible in health");
    assert.equal(r.outbox.sent.length, 0);
    assert.equal(runner.flush(), 1);
    // всё починилось
    r.disk.failing = false;
    r.outbox.failing = false;
    assert.equal(runner.flush(), 0);
    assert.equal(r.outbox.sent.length, 1);
    assert.equal(r.jobs.list().length, 0);
    assert.deepEqual(r.onDisk(), {});
    assert.equal(r.jobs.health().persistFailing, false);
  } finally { r.cleanup(); }
});

test("the periodic flush timer delivers deferred notices on its own", async () => {
  const r = rig({ runnerOpts: { flushMs: 20 } });
  try {
    r.outbox.failing = true;
    const runner = r.mk();
    runner.start();
    await submit(r, runner, async () => { throw new Error("agent down"); });
    assert.equal(r.outbox.sent.length, 0);
    r.outbox.failing = false;
    await until(() => r.outbox.sent.length === 1, "timer-driven delivery");
    await until(() => r.jobs.list().length === 0, "job removed");
    runner.stop();
  } finally { r.cleanup(); }
});

test("partial notice delivery: only the undelivered ones are retried (no duplicates)", async () => {
  const result = { outcomes: [], contextText: "", userNotices: ["file A is broken", "file B is broken"], usable: false };
  const r = rig({ result });
  try {
    let n = 0;
    const flaky = (u, t) => { if (++n === 2) throw new Error("outbox hiccup"); r.outbox.sent.push([u, t]); };
    const runner = createMediaRunner({ jobs: r.jobs, processor: { process: async () => result }, reply: flaky, log: quiet, retryDelayMs: 0 });
    const job = r.jobs.accept({ ...baseJob(), text: "" });
    await runner.run(job, async () => { throw new Error("never called"); });
    assert.deepEqual(r.outbox.sent.map((x) => x[1]), ["⚠️ file A is broken"]);
    assert.deepEqual(r.onDisk()["msg:1"].pendingNotices, ["⚠️ file B is broken"]);
    runner.flush();
    assert.deepEqual(r.outbox.sent.map((x) => x[1]), ["⚠️ file A is broken", "⚠️ file B is broken"]);
    assert.deepEqual(r.onDisk(), {});
  } finally { r.cleanup(); }
});

test("if the 'sending' intent cannot be persisted, the agent is NOT called (it could not be recovered safely)", async () => {
  const r = rig();
  try {
    const runner = r.mk();
    const job = r.jobs.accept(baseJob());
    let calls = 0;
    // первая запись (processing) проходит, на «sending» диск отказывает
    let writes = 0;
    const flakyJobs = createMediaJobs({ dir: r.dir, log: quiet, io: { writeJson: (f, v) => { if (++writes > 1) throw new Error("EIO"); writeJsonAtomic(f, v); } } });
    flakyJobs.accept(baseJob("msg:x"));
    const runner2 = createMediaRunner({ jobs: flakyJobs, processor: { process: async () => okResult }, reply: (u, t) => r.outbox.sent.push([u, t]), log: quiet, retryDelayMs: 0 });
    await runner2.run(flakyJobs.list()[0], async () => { calls++; });
    assert.equal(calls, 0);
    assert.match(r.outbox.sent.at(-1)[1], /записать состояние|record the state/);
    void runner; void job;
  } finally { r.cleanup(); }
});

// ───────────── 3. падение процесса в каждом состоянии ─────────────

test("crash recovery wording depends on whether send() could already have happened; nothing is re-run", async () => {
  for (const [state, re, noReplay] of [
    ["queued", /НЕ передано агенту|NOT passed/, true],
    ["processing", /НЕ передано агенту|NOT passed/, true],
    ["sending", /Не знаю, получил ли агент|cannot tell whether/, true],
    ["unknown", /Не знаю, получил ли агент|cannot tell whether/, true],
  ]) {
    const r = rig();
    try {
      r.jobs.accept(baseJob());
      r.jobs.update("msg:1", { state });
      const again = r.reopen(); // новый процесс
      let sends = 0;
      const runner2 = createMediaRunner({ jobs: again, processor: { process: async () => { sends++; return okResult; } }, reply: (u, t) => r.outbox.sent.push([u, t]), log: quiet });
      assert.equal(runner2.recover(), 1, state);
      assert.equal(r.outbox.sent.length, 1, state);
      assert.match(r.outbox.sent[0][1], re, state);
      assert.equal(sends, 0, `${state}: not re-processed`);
      assert.equal(noReplay && again.list().length, 0, state);
      assert.equal(runner2.recover(), 0, `${state}: reported once`);
    } finally { r.cleanup(); }
  }
});

test("crash recovery with the outbox down keeps the notice for later instead of losing it", async () => {
  const r = rig();
  try {
    r.jobs.accept(baseJob());
    r.jobs.update("msg:1", { state: "sending" });
    const again = r.reopen();
    r.outbox.failing = true;
    const runner2 = r.mk(again);
    assert.equal(runner2.recover(), 1);
    assert.equal(again.list().length, 1);
    assert.equal(again.list()[0].state, "notify");
    assert.equal(r.outbox.sent.length, 0);
    r.outbox.failing = false;
    runner2.flush();
    assert.equal(r.outbox.sent.length, 1);
    assert.match(r.outbox.sent[0][1], /Не знаю|cannot tell/);
    assert.equal(again.list().length, 0);
  } finally { r.cleanup(); }
});
