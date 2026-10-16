// Какие каналы связи включены в этой установке и какие systemd-сервисы им нужны.
//   IVA_CHANNELS=max | telegram | max,telegram   — явный выбор (его пишет мастер установки);
//   без него каналы выводятся из токенов (обратная совместимость со старыми установками).
// Telegram не обязателен: MAX-only установка не запускает ни telegram-poll, ни userbot.
// Если не настроено вообще ничего (свежий checkout до `iva config`), остаётся прежний
// по умолчанию набор — Telegram, чтобы поведение существующих установок не менялось.

export const BRIDGE_UNIT = {
  telegram: "iva-telegram-poll.service",
  max: "iva-max-bridge.service",
};

const nonEmpty = (v) => typeof v === "string" && v.trim() !== "";

export function configuredChannels(env = {}) {
  const explicit = String(env.IVA_CHANNELS ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s === "max" || s === "telegram");
  let telegram;
  let max;
  let inferred = false;
  if (explicit.length) {
    telegram = explicit.includes("telegram");
    max = explicit.includes("max");
  } else {
    telegram = nonEmpty(env.TELEGRAM_BOT_TOKEN);
    max = nonEmpty(env.MAX_BOT_TOKEN) && nonEmpty(env.MAX_WEBHOOK_SECRET);
    if (!telegram && !max) {
      telegram = true; // legacy default for an unconfigured checkout
      inferred = true;
    }
  }
  const maxIngest = String(env.MAX_INGEST ?? "poll").trim().toLowerCase() === "webhook" ? "webhook" : "poll";
  return { telegram, max, maxIngest, inferred };
}

/** Сервисы, которые должны работать: агент + мосты включённых каналов. */
export function channelServices(env = {}) {
  const c = configuredChannels(env);
  return [
    "iva.service",
    ...(c.telegram ? [BRIDGE_UNIT.telegram] : []),
    // Мост MAX — единая точка входа и управления в обоих режимах (polling и webhook).
    ...(c.max ? [BRIDGE_UNIT.max] : []),
  ];
}

/** Мосты, которые НЕ нужны в текущей конфигурации (их надо остановить и отключить). */
export function unusedBridgeUnits(env = {}) {
  const wanted = new Set(channelServices(env));
  return Object.values(BRIDGE_UNIT).filter((u) => !wanted.has(u));
}

/** Человекочитаемое имя набора: «MAX», «Telegram», «MAX + Telegram». */
export function channelLabel(env = {}) {
  const c = configuredChannels(env);
  return [c.max ? "MAX" : null, c.telegram ? "Telegram" : null].filter(Boolean).join(" + ") || "none";
}
