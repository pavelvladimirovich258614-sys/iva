// MAX: секреты не принимаются обычными сообщениями. Экраны меню и мастер модели должны вместо
// приглашения «пришли ключ» показывать локальную команду, не ставя ждущий ввод (awaitText).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import search from "./search.mjs";
import { createModelWizard } from "../model-wizard.mjs";
import { createFlows } from "../tg-flow.mjs";

function ctxFor({ secretsInChat, envPath }) {
  const shown = [];
  return {
    shown,
    ctx: {
      deps: { envPath, secretsInChat },
      flows: { screen: async (st, text, rows) => void shown.push(text), end: async (st, text) => void shown.push(text) },
      tr: (en) => en,
      btn: (text, data) => ({ text, callback_data: data }),
      backRow: () => [],
      show: async () => {},
      secretsInChat: () => secretsInChat !== false,
    },
  };
}

test("search key: with secretsInChat=false no input prompt is armed and the local command is shown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sp-"));
  const envPath = join(dir, ".env");
  writeFileSync(envPath, "SEARCH_PROVIDER=tavily\n");
  const off = ctxFor({ secretsInChat: false, envPath });
  const st = { chatId: 555, userId: "1", data: {} };
  await search.on("set", ["brave"], st, off.ctx);
  assert.equal(st.awaitText ?? null, null);
  assert.match(off.shown.at(-1), /iva secret set BRAVE_API_KEY/);
  assert.doesNotMatch(off.shown.at(-1), /next message/i);

  const on = ctxFor({ secretsInChat: true, envPath });
  const st2 = { chatId: 555, userId: "1", data: {} };
  await search.on("set", ["brave"], st2, on.ctx);
  assert.equal(st2.awaitText?.secret, true, "Telegram behaviour is unchanged");
});

test("model wizard: key missing + secretsInChat=false → CLI instruction, no key prompt, wizard ends", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sp-"));
  const envPath = join(dir, ".env");
  writeFileSync(envPath, "MODEL_PROVIDER=ollama\nOLLAMA_API_KEY=k\n"); // у OpenCode ключа нет
  const sent = [];
  const tg = async (method, params) => {
    sent.push({ method, params });
    return { ok: true, result: { message_id: "m1" } };
  };
  const flows = createFlows({ tg });
  const w = createModelWizard({ tg, flows, envPath, dataDir: dir, allowed: new Set(["1"]), sc: async () => true, reply: async () => ({}), isPrivate: () => true, secretsInChat: false });
  await w.handleModelCmd("1", "1");
  const st = flows.get("1", "1");
  // идём по кнопкам так же, как пользователь: Change → OpenCode
  await w.handleWizardCallback({ id: "c1", from: { id: "1" }, message: { message_id: "m1", chat: { id: "1" } }, data: "iva_model:chg" });
  await w.handleWizardCallback({ id: "c2", from: { id: "1" }, message: { message_id: "m1", chat: { id: "1" } }, data: "iva_model:prov:opencode" });
  const last = sent.filter((s) => s.method === "editMessageText" || s.method === "sendMessage").at(-1).params.text;
  assert.match(last, /iva secret set OPENCODE_API_KEY/);
  assert.equal(st.awaitText ?? null, null);
  assert.equal(flows.get("1", "1"), null, "wizard slot is released");
});
