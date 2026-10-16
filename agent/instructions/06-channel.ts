import { defineDynamic, defineInstructions } from "eve/instructions";

// Через какие мессенджеры владелец общается с Ивой: от этого зависит, какие приёмы доставки
// отчётов доступны (rich-сообщения — только Telegram). Логика продублирована инлайн, а НЕ
// импортом scripts/lib/channels.mjs: инструкции самодостаточны (см. 05-language.ts).
// Читается каждый турн — смена канала в `iva config` подхватывается без правок кода.
function channels(): { telegram: boolean; max: boolean } {
  const env = process.env;
  const explicit = (env.IVA_CHANNELS ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s === "max" || s === "telegram");
  if (explicit.length) return { telegram: explicit.includes("telegram"), max: explicit.includes("max") };
  const telegram = Boolean((env.TELEGRAM_BOT_TOKEN ?? "").trim());
  const max = Boolean((env.MAX_BOT_TOKEN ?? "").trim() && (env.MAX_WEBHOOK_SECRET ?? "").trim());
  return telegram || max ? { telegram, max } : { telegram: true, max: false };
}

function channelMarkdown(): string {
  const c = channels();
  if (c.max && !c.telegram) {
    return [
      "## Канал связи: MAX",
      "Владелец общается с тобой ТОЛЬКО через мессенджер MAX (Telegram не используется и не подключён).",
      "- Красная строка про rich-сообщения НЕ действует: `rich-post` и `send_rich.py` — Telegram-инструменты, " +
        "здесь они не работают. Отчёты, сводки и дайджесты отправляй обычным ответом.",
      "- Формат: короткие абзацы, **жирный**, `код`, простые списки. Без Markdown-таблиц и HTML — MAX их не рендерит.",
      "- Сообщение длиннее 4000 символов делится автоматически; держи ответы компактными.",
      "- Команды чата: /help, /menu, /new, /stop, /usage, /task, /tasks, /digest, /model, /think, /restart, /update.",
      "- Скиллы и инструменты для Telegram (userbot, rich-post) не предлагай.",
    ].join("\n");
  }
  if (c.max && c.telegram) {
    return [
      "## Каналы связи: MAX и Telegram",
      "Владелец может писать из MAX и из Telegram. Rich-сообщения (`rich-post`) работают только в Telegram — " +
        "если текущий диалог идёт из MAX, отчёты отправляй обычным ответом (markdown без таблиц).",
    ].join("\n");
  }
  return "";
}

export default defineDynamic({
  events: {
    "turn.started": () => defineInstructions({ markdown: channelMarkdown() }),
  },
});
