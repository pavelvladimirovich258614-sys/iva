// Установка/эксплуатация в режиме MAX-only: сервисы, юниты, подтверждение и диагностика —
// без единой переменной TELEGRAM_*. Настоящий bin/iva.mjs, подменён только systemctl (как в
// systemd-control.test.mjs) и сеть (mock MAX API на 127.0.0.1).
import { strict as assert } from "node:assert";
import test from "node:test";
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile, access } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

const FAKE_SYSTEMCTL = `#!/bin/sh
printf "%s\\n" "$*" >> "$IVA_FAKE_SYSTEMCTL_CALLS"
[ "$1" = "--user" ] && shift
action="$1"; shift
case "$action" in
  enable) [ "\${1:-}" = "--now" ] && shift; : > "$IVA_FAKE_SYSTEMD_STATE/$1.enabled"; : > "$IVA_FAKE_SYSTEMD_STATE/$1.active" ;;
  restart) : > "$IVA_FAKE_SYSTEMD_STATE/$1.active" ;;
  stop) rm -f "$IVA_FAKE_SYSTEMD_STATE/$1.active" ;;
  disable) [ "\${1:-}" = "--now" ] && shift; rm -f "$IVA_FAKE_SYSTEMD_STATE/$1.enabled" "$IVA_FAKE_SYSTEMD_STATE/$1.active" ;;
  is-enabled) if [ -f "$IVA_FAKE_SYSTEMD_STATE/$1.enabled" ]; then echo enabled; else echo disabled; exit 1; fi ;;
  is-active) if [ -f "$IVA_FAKE_SYSTEMD_STATE/$1.active" ]; then echo active; else echo inactive; exit 3; fi ;;
  is-failed) echo inactive; exit 1 ;;
esac
`;

async function startMockMax() {
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const url = new URL(req.url, "http://x");
    seen.push({ method: req.method, path: url.pathname, query: url.search, auth: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    res.writeHead(200, { "content-type": "application/json" });
    if (url.pathname === "/me") return res.end(JSON.stringify({ user_id: 99, first_name: "Iva", username: "iva_bot", is_bot: true }));
    if (url.pathname === "/subscriptions") return res.end(JSON.stringify({ subscriptions: [] }));
    return res.end(JSON.stringify({ message: { body: { mid: "m1", seq: 1 } } }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

async function fixture(t, envText) {
  const dir = await mkdtemp(join(tmpdir(), "iva-max-only-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const project = join(dir, "iva");
  const home = join(dir, "home");
  const fakeBin = join(dir, "bin");
  const state = join(dir, "state");
  const calls = join(dir, "systemctl.calls");
  await mkdir(join(project, "bin"), { recursive: true });
  await mkdir(join(project, ".output/server"), { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await mkdir(state, { recursive: true });
  // Копия, а не симлинк: CLI вычисляет ROOT по реальному пути файла и иначе читал бы настоящий .env.
  await copyFile(join(ROOT, "bin/iva.mjs"), join(project, "bin/iva.mjs"));
  await symlink(join(ROOT, "scripts"), join(project, "scripts"));
  await symlink(join(ROOT, "deploy"), join(project, "deploy"));
  await symlink(join(ROOT, "agent"), join(project, "agent"));
  await symlink(join(ROOT, "node_modules"), join(project, "node_modules"));
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "iva", version: "0.0.0", type: "module" }));
  await writeFile(join(project, ".output/server/index.mjs"), "");
  await writeFile(join(project, ".env"), envText, { mode: 0o600 });
  const sc = join(fakeBin, "systemctl");
  await writeFile(sc, FAKE_SYSTEMCTL);
  await chmod(sc, 0o755);

  const run = (args, extraEnv = {}, input = "") =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [join(project, "bin/iva.mjs"), ...args], {
        env: {
          PATH: `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`,
          HOME: home,
          NO_COLOR: "1",
          IVA_FAKE_SYSTEMCTL_CALLS: calls,
          IVA_FAKE_SYSTEMD_STATE: state,
          ...extraEnv,
        },
      });
      child.stdin.end(input);
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("exit", (status) => resolve({ status, out }));
    });
  const callLog = async () => (await readFile(calls, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  const exists = (p) => access(p).then(() => true, () => false);
  return { project, home, state, run, callLog, exists, calls };
}

const MAX_ENV = (base = "") =>
  `MODEL_PROVIDER=ollama\nOLLAMA_API_KEY=k\nOLLAMA_MODEL=m\nASSISTANT_BEARER=${"a".repeat(48)}\nIVA_CHANNELS=max\nMAX_BOT_TOKEN=tok\nMAX_WEBHOOK_SECRET=sec_123456\nMAX_ALLOWED_USER_IDS=42\nTELEGRAM_BOT_TOKEN=\nTELEGRAM_ALLOWED_USER_IDS=\nTELEGRAM_DIGEST_CHAT_ID=\n${base}`;

test("MAX-only start enables the agent and the MAX bridge — and never telegram-poll", async (t) => {
  const f = await fixture(t, MAX_ENV());
  assert.equal((await f.run(["_install-units"])).status, 0); // what install.sh does first
  const r = await f.run(["_activate-units"]);
  assert.equal(r.status, 0, r.out);
  const calls = (await f.callLog()).join("\n");
  assert.match(calls, /enable --now iva\.service/);
  assert.match(calls, /enable --now iva-max-bridge\.service/);
  assert.doesNotMatch(calls, /(enable|restart) (--now )?iva-telegram-poll/);
  assert.doesNotMatch(calls, /telegram-userbot/);
  const unit = await readFile(join(f.home, ".config/systemd/user/iva-max-bridge.service"), "utf8");
  assert.match(unit, /ExecStart=.* --env-file=\.env scripts\/max-bridge\.mjs/);
  assert.match(unit, /UMask=0077/);
  assert.doesNotMatch(unit, /__PROJECT_DIR__|__NODE_BIN__/);
});

test("switching to MAX-only turns a leftover telegram-poll off", async (t) => {
  const f = await fixture(t, MAX_ENV());
  await writeFile(join(f.state, "iva-telegram-poll.service.enabled"), "");
  await writeFile(join(f.state, "iva-telegram-poll.service.active"), "");
  assert.equal((await f.run(["_install-units"])).status, 0); // the old unit file is on disk, as on a real upgrade
  const r = await f.run(["start"]);
  assert.equal(r.status, 0, r.out);
  assert.equal(await f.exists(join(f.state, "iva-telegram-poll.service.active")), false);
  assert.equal(await f.exists(join(f.state, "iva-telegram-poll.service.enabled")), false);
  assert.equal(await f.exists(join(f.state, "iva-max-bridge.service.active")), true);
});

test("restart touches only the agent and the MAX bridge", async (t) => {
  const f = await fixture(t, MAX_ENV());
  const r = await f.run(["restart"]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Restarted: iva \+ iva-max-bridge/);
  const restarts = (await f.callLog()).filter((l) => /restart/.test(l)).join("\n");
  assert.match(restarts, /iva\.service/);
  assert.match(restarts, /iva-max-bridge\.service/);
  assert.doesNotMatch(restarts, /telegram/);
});

test("Telegram-only and 'both' installs keep working (no regression)", async (t) => {
  const tg = await fixture(t, `MODEL_PROVIDER=ollama\nOLLAMA_API_KEY=k\nOLLAMA_MODEL=m\nASSISTANT_BEARER=${"a".repeat(48)}\nTELEGRAM_BOT_TOKEN=123:abc\nTELEGRAM_ALLOWED_USER_IDS=1\n`);
  assert.equal((await tg.run(["start"])).status, 0);
  const tgCalls = (await tg.callLog()).join("\n");
  assert.match(tgCalls, /enable --now iva-telegram-poll\.service/);
  assert.doesNotMatch(tgCalls, /enable --now iva-max-bridge/);

  const both = await fixture(t, MAX_ENV().replace("IVA_CHANNELS=max", "IVA_CHANNELS=max,telegram").replace("TELEGRAM_BOT_TOKEN=\n", "TELEGRAM_BOT_TOKEN=123:abc\n"));
  assert.equal((await both.run(["start"])).status, 0);
  const bothCalls = (await both.callLog()).join("\n");
  assert.match(bothCalls, /enable --now iva-telegram-poll\.service/);
  assert.match(bothCalls, /enable --now iva-max-bridge\.service/);
});

test("installer helpers: channel info and the 'installed' confirmation go through MAX (user_id), no Telegram", async (t) => {
  const mock = await startMockMax();
  t.after(() => mock.close());
  const f = await fixture(t, MAX_ENV(`MAX_API_BASE_URL=${mock.url}\n`));
  const info = await f.run(["_channel-info"]);
  assert.equal(info.out.trim(), "MAX|iva-max-bridge");

  const c = await f.run(["_confirm", "✅ Iva is online"]);
  assert.equal(c.status, 0, c.out);
  const sent = mock.seen.find((r) => r.method === "POST" && r.path === "/messages");
  assert.ok(sent, "confirmation was sent to MAX");
  assert.equal(sent.query, "?user_id=42");
  assert.equal(sent.auth, "tok");
  assert.equal(JSON.parse(sent.body).text, "✅ Iva is online");
  assert.ok(!mock.seen.some((r) => /telegram/.test(r.path)));
});

test("confirmation is silently skipped when no channel is configured (no errors)", async (t) => {
  const f = await fixture(t, `MODEL_PROVIDER=ollama\nASSISTANT_BEARER=${"a".repeat(48)}\nTELEGRAM_BOT_TOKEN=\n`);
  const c = await f.run(["_confirm", "hello"]);
  assert.equal(c.status, 0, c.out);
});

test("iva max check validates the token, allowlist and subscription state", async (t) => {
  const mock = await startMockMax();
  t.after(() => mock.close());
  const f = await fixture(t, MAX_ENV(`MAX_API_BASE_URL=${mock.url}\n`));
  const r = await f.run(["max", "check"]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /token valid — bot @iva_bot/);
  assert.match(r.out, /allowlist: 42/);
  assert.match(r.out, /no webhook subscription \(polling mode\)/);
  assert.ok(!r.out.includes("tok\n") && !/Authorization/i.test(r.out), "token never printed");
});

test("doctor treats MAX settings as required for a MAX install and Telegram ones as optional", async (t) => {
  const f = await fixture(t, MAX_ENV().replace("MAX_ALLOWED_USER_IDS=42\n", ""));
  const r = await f.run(["doctor"]);
  assert.match(r.out, /missing: [^\n]*MAX_ALLOWED_USER_IDS/);
  assert.doesNotMatch(r.out.split("\n").find((l) => /missing:/.test(l)) ?? "", /TELEGRAM|DEEPGRAM/);
});

test("iva secret set: value read from stdin, written to .env 0600, never echoed", async (t) => {
  const f = await fixture(t, MAX_ENV());
  const KEY = "sk-live-0123456789abcdef-SECRET";
  const r = await f.run(["secret", "set", "OLLAMA_API_KEY"], {}, `${KEY}\n`);
  assert.equal(r.status, 0, r.out);
  assert.ok(!r.out.includes(KEY), "the value must not appear in the output");
  assert.match(r.out, /OLLAMA_API_KEY saved to \.env/);
  const env = await readFile(join(f.project, ".env"), "utf8");
  assert.match(env, new RegExp(`^OLLAMA_API_KEY=${KEY}$`, "m"));
  assert.match(env, /^IVA_CHANNELS=max$/m, "other settings are preserved");
  const { statSync } = await import("node:fs");
  assert.equal(statSync(join(f.project, ".env")).mode & 0o077, 0, ".env stays private");
  // повторная установка заменяет значение, а не дублирует строку
  await f.run(["secret", "set", "OLLAMA_API_KEY"], {}, "another-value-123456\n");
  assert.equal((await readFile(join(f.project, ".env"), "utf8")).match(/^OLLAMA_API_KEY=/gm).length, 1);
});

test("iva secret set: refuses arbitrary names and malformed values, saving nothing", async (t) => {
  const f = await fixture(t, MAX_ENV());
  const before = await readFile(join(f.project, ".env"), "utf8");
  for (const [name, value] of [["ASSISTANT_BEARER", "x".repeat(40)], ["PATH", "/bin"], ["lowercase_api_key", "x".repeat(20)], ["OLLAMA_API_KEY", "short"], ["OLLAMA_API_KEY", "has space inside the value"], ["OLLAMA_API_KEY", ""]]) {
    const r = await f.run(["secret", "set", name], {}, `${value}\n`);
    assert.notEqual(r.status, 0, `${name}=${JSON.stringify(value)} must be rejected`);
  }
  assert.equal(await readFile(join(f.project, ".env"), "utf8"), before);
});

test("iva secret set MAX_BOT_TOKEN is verified with GET /me before it is saved", async (t) => {
  const mock = await startMockMax();
  t.after(() => mock.close());
  const f = await fixture(t, MAX_ENV(`MAX_API_BASE_URL=${mock.url}\n`));
  const GOOD = "tok"; // mock принимает только токен «tok»
  const ok = await f.run(["secret", "set", "MAX_BOT_TOKEN", "--no-verify"], {}, "brand-new-token-123456\n");
  assert.equal(ok.status, 0, ok.out);
  assert.match(await readFile(join(f.project, ".env"), "utf8"), /^MAX_BOT_TOKEN=brand-new-token-123456$/m);
  assert.ok(!mock.seen.some((r) => r.path === "/me"), "--no-verify skips the API call");
  const accepted = await f.run(["secret", "set", "MAX_BOT_TOKEN"], {}, `${GOOD}-valid-token\n`);
  // mock отвечает на /me для любого токена 200 — проверяем сам факт проверки и вывод без значения
  assert.equal(accepted.status, 0, accepted.out);
  assert.ok(mock.seen.some((r) => r.path === "/me" && r.auth === `${GOOD}-valid-token`));
  assert.ok(!accepted.out.includes(`${GOOD}-valid-token`));
});
