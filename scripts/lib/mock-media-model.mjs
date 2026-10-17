// Сценарная «модель» для media e2e: ведёт себя как агент, который ЧИТАЕТ то, что ему передали, и вызывает
// настоящие инструменты Ивы (tasks, write_card, memory_search, write_file, max_send_file). Все ответы
// строятся из данных, пришедших в запросе (расшифровка голоса, описание картинки, текст документа), поэтому
// тест проверяет не «модель вызвана», а «до модели дошли правильные данные».
import { createHash } from "node:crypto";
import { readPngVisibleText } from "./media-fixtures.mjs";

export const sha256 = (b) => createHash("sha256").update(b).digest("hex");

function partText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join(" ");
  return "";
}

/** Картинки (data URL) из последнего user-сообщения запроса к vision-модели. */
export function imagesOf(body) {
  const out = [];
  for (const m of body?.messages ?? []) {
    if (!Array.isArray(m?.content)) continue;
    for (const p of m.content) {
      const url = p?.image_url?.url ?? (typeof p?.image_url === "string" ? p.image_url : null);
      const mm = typeof url === "string" ? /^data:([^;]+);base64,(.*)$/s.exec(url) : null;
      if (mm) out.push({ mime: mm[1], bytes: Buffer.from(mm[2], "base64") });
    }
    // AI SDK file-part (codex-путь) в e2e не используется
  }
  return out;
}

export function mediaBehavior({ vaultDir, dataDir, appDir, log = () => {} }) {
  return function behave(body) {
    const messages = body?.messages ?? [];
    // ── vision-запрос: «читаем» текст, зашитый в PNG тестовой фикстурой ──
    const imgs = imagesOf(body);
    if (imgs.length) {
      const texts = imgs.map((i) => readPngVisibleText(i.bytes));
      log(`vision request: ${imgs.length} image(s) ${imgs.map((i) => sha256(i.bytes).slice(0, 8)).join(",")}`);
      return { text: texts.map((t) => `Image text: ${t ?? "(no text)"}`).join("\n") };
    }
    const last = messages.at(-1);
    let user = "";
    let userIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === "user") { user = partText(messages[i].content); userIdx = i; break; }
    const toolsSinceUser = messages.slice(userIdx + 1).filter((m) => m?.role === "tool").length;
    const afterTool = last?.role === "tool";
    const toolResult = afterTool ? partText(last.content) : "";
    const toolNames = (body?.tools ?? []).map((t) => t?.function?.name ?? t?.name);

    // ── голос → задача ──
    if (/напомни/.test(user) && /<<<TRANSCRIPT/.test(user)) {
      const spoken = /<<<TRANSCRIPT\n([\s\S]*?)\nTRANSCRIPT>>>/.exec(user)?.[1] ?? "";
      const what = /напомни\s+(.+?)\s*$/s.exec(spoken)?.[1] ?? "";
      const task = what.charAt(0).toUpperCase() + what.slice(1);
      if (!afterTool) return { toolCalls: [{ name: "tasks", args: { action: "add", text: task, due: "завтра 10:00", priority: "high" } }] };
      return { text: `Задача создана: ${task} (срок: завтра 10:00). Напомню в MAX.` };
    }
    // ── скриншот ошибки ──
    if (/Посмотри на эту ошибку/.test(user)) {
      const seen = [...user.matchAll(/Image text: (.+)/g)].map((m) => m[1]);
      return { text: `Причина по скриншоту: ${seen.join(" | ") || "изображение не распознано"}. Предлагаю проверить поле user_id и перезапустить сервис.` };
    }
    if (/Сравни две картинки/.test(user)) {
      const seen = [...user.matchAll(/Image text: (.+)/g)].map((m) => m[1]);
      return { text: `Картинок: ${seen.length}. ${seen.map((s, i) => `#${i + 1}: ${s}`).join("; ")}` };
    }
    // ── документ → память ──
    if (/запомни важную информацию/.test(user)) {
      const content = /<<<CONTENT\n([\s\S]*?)\nCONTENT>>>/.exec(user)?.[1] ?? "";
      const facts = content.split("\n").filter((l) => /Срок|Штраф|Аванс/.test(l)).join("\n");
      if (!afterTool) {
        return { toolCalls: [{ name: "write_card", args: { type: "note", title: "Договор поставки e2e", description: "Основные условия договора поставки", tags: ["dogovor", "e2e"], body: facts || "нет данных" } }] };
      }
      return { text: `Запомнила условия договора:\n${facts}\n(карточка: ${/"file":"([^"]+)"/.exec(toolResult)?.[1] ?? "?"})` };
    }
    if (/Какие условия по договору/.test(user)) {
      if (!afterTool) return { toolCalls: [{ name: "memory_search", args: { query: "договор поставки штраф срок" } }] };
      return { text: `Нашла в памяти: ${toolResult.replace(/\s+/g, " ").slice(0, 1500)}` };
    }
    // ── Excel → анализ по реальным значениям ──
    if (/посчитай итог по таблице/.test(user)) {
      const firstSheet = user.split(/### Sheet /)[1] ?? "";
      const nums = [...firstSheet.matchAll(/\bB(?:[2-9]|\d{2,})=(\d+(?:\.\d+)?)(?![\d.]| \[formula)/g)].map((m) => Number(m[1]));
      const sheet = /Sheet "([^"]+)"/.exec(user)?.[1] ?? "?";
      return { text: `Лист «${sheet}»: сумма B = ${nums.reduce((a, b) => a + b, 0)} (значений: ${nums.length})` };
    }
    // ── создание файла и отправка ──
    if (/Excel-отчёт/.test(user)) {
      const path = `${vaultDir}/attachments/report-e2e.csv`;
      const stage = toolsSinceUser;
      if (stage === 0) return { toolCalls: [{ name: "write_file", args: { path, content: "item,qty,price\nwidget,3,9.50\ngadget,2,20.00\n" } }] };
      if (stage === 1) return { toolCalls: [{ name: "max_send_file", args: { path, caption: "Отчёт готов", name: "report.csv" } }] };
      return { text: `Файл отправлен: ${toolResult.replace(/\s+/g, " ").slice(0, 300)}` };
    }
    const send = /пришли файл (\S+)/.exec(user);
    if (send) {
      const name = send[1];
      const path = name.startsWith("/") ? name : `${dataDir}/outbox/${name}`;
      if (!afterTool) return { toolCalls: [{ name: "max_send_file", args: { path } }] };
      return { text: `Результат отправки ${name}: ${toolResult.replace(/\s+/g, " ").slice(0, 400)}` };
    }
    if (/пришли секреты/.test(user)) {
      const path = `${appDir}/.env`;
      if (!afterTool) return { toolCalls: [{ name: "max_send_file", args: { path } }] };
      return { text: `Не отправила: ${toolResult.replace(/\s+/g, " ").slice(0, 400)}` };
    }
    // ── обычный путь: что именно агент получил (для проверки передачи вложений) ──
    if (/Что ты получила/.test(user)) return { text: `Получено: ${user.slice(0, 1200)}` };
    return null;
  };
}
