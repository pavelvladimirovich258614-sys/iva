// Шаг мастера установки «MAX-бот»: токен → проверка GET /me → секрет → кто может писать боту.
// Весь ввод-вывод приходит параметрами (ask/askRequired/say), сеть — через MaxClient, поэтому шаг
// тестируется без терминала и без настоящего MAX. Ничего не пишет на диск: наполняет объект `out`.
import { randomBytes } from "node:crypto";
import { createMaxClient, resolveMaxBaseUrl } from "../../agent/lib/max-api.ts";

export const MAX_SECRET_RE = /^[A-Za-z0-9_-]{5,256}$/;

/** Публичный адрес webhook для MAX: HTTPS, порт 443, без учётных данных/query, не локальный хост. Бросает Error с причиной. */
export function validateWebhookUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("not a valid URL");
  }
  if (u.protocol !== "https:") throw new Error("MAX requires HTTPS");
  if (u.port && u.port !== "443") throw new Error("MAX requires port 443");
  if (u.username || u.password || u.search || u.hash) throw new Error("the URL must not contain credentials, a query or a fragment");
  if (/^(localhost|127\.|10\.|192\.168\.|0\.0\.0\.0|\[?::1)/i.test(u.hostname)) throw new Error("the host must be publicly reachable by MAX, not a local address");
  if (u.pathname.length < 2) throw new Error("the URL needs a path (e.g. /max/webhook)");
  return u.toString();
}
const ID_RE = /^\d+$/;

export function makeClient(token, env = process.env, fetchImpl) {
  return createMaxClient({
    token,
    baseUrl: resolveMaxBaseUrl(env.MAX_API_BASE_URL),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

/** GET /me: токен жив и принадлежит боту. { ok, username, userId } | { ok:false, error } */
export async function validateMaxToken(client) {
  try {
    const me = await client.getMe();
    if (!me.userId) return { ok: false, error: "unexpected /me response" };
    if (!me.isBot) return { ok: false, error: "this token does not belong to a bot" };
    return { ok: true, username: me.username ?? "", userId: me.userId };
  } catch (e) {
    return { ok: false, error: e?.status === 401 ? "token rejected (401)" : String(e?.message ?? e) };
  }
}

/** Кто недавно писал боту (без подтверждения апдейтов — маркер не передаётся, ничего не «съедается»). */
export async function peekMaxUsers(client, { timeoutSec = 3 } = {}) {
  const page = await client.getUpdates({ timeoutSec, limit: 100, types: ["message_created", "bot_started"] });
  const seen = new Map();
  for (const u of page.updates) {
    const sender = u?.update_type === "bot_started" ? u.user : u?.message?.sender;
    const dialog = u?.update_type === "bot_started" || u?.message?.recipient?.chat_type === "dialog";
    const id = sender?.user_id != null ? String(sender.user_id) : "";
    if (!dialog || !ID_RE.test(id) || sender?.is_bot === true || seen.has(id)) continue;
    const name = [sender.first_name, sender.last_name, sender.username ? `@${sender.username}` : ""].filter(Boolean).join(" ");
    seen.set(id, { id, name });
  }
  return [...seen.values()];
}

/**
 * @param io  { ask, askRequired, say, C, t }
 * @param existing  прежний .env;  @param out  объект, который станет новым .env
 * @returns { username, ids }
 */
export async function setupMaxChannel({ io, existing, out, env = process.env, fetchImpl }) {
  const { ask, askRequired, say, C, t } = io;
  say(`  ${t("Create a bot for MAX and copy its token:", "Создайте бота в MAX и скопируйте его токен:")}`);
  say(`    1) ${t("open the MAX bot platform", "откройте платформу ботов MAX")} ${C.c}https://business.max.ru${C.x} (${t("docs", "документация")}: ${C.c}https://dev.max.ru${C.x})`);
  say(`    2) ${t("create a bot and copy the access token", "создайте бота и скопируйте токен доступа")}`);
  say(`  ${C.y}${t("The token is a secret: it is stored only in .env (never in git) and sent only in the Authorization header.", "Токен — секрет: он хранится только в .env (не в git) и передаётся только в заголовке Authorization.")}${C.x}`);

  let me = null;
  out.MAX_BOT_TOKEN = await askRequired(`  ${t("Paste the MAX bot token", "Вставьте токен MAX-бота")}`, {
    existing: existing.MAX_BOT_TOKEN || "",
    validate: async (token) => {
      const r = await validateMaxToken(makeClient(token, env, fetchImpl));
      if (!r.ok) return t(`MAX rejected the token (${r.error}). Copy it again from the bot page.`, `MAX не принял токен (${r.error}). Скопируйте заново со страницы бота.`);
      me = r;
      return null;
    },
  });
  out.MAX_BOT_USERNAME = me?.username || existing.MAX_BOT_USERNAME || "";
  if (me?.username) say(`  → ${t("bot", "бот")}: ${C.g}@${me.username}${C.x}`);
  // Секрет webhook/внутренней связки мост↔агент: случайный, ≥5 символов [A-Za-z0-9_-] (требование MAX).
  out.MAX_WEBHOOK_SECRET = MAX_SECRET_RE.test(existing.MAX_WEBHOOK_SECRET || "") ? existing.MAX_WEBHOOK_SECRET : randomBytes(24).toString("hex");

  say(`\n  ${C.y}${t("IMPORTANT:", "ВАЖНО:")}${C.x} ${t("Iva answers ONLY trusted MAX user IDs.", "Iva отвечает ТОЛЬКО доверенным MAX user_id.")}`);
  say(`  ${t("Without at least one ID the bot stays silent to everyone (that's how your data is protected).", "Без хотя бы одного ID бот промолчит всем (так ваши данные защищены).")}`);
  const ids = new Set((existing.MAX_ALLOWED_USER_IDS || "").split(/[,\s]+/).map((s) => s.trim()).filter((s) => ID_RE.test(s)));
  const client = makeClient(out.MAX_BOT_TOKEN, env, fetchImpl);
  while (ids.size === 0) {
    say(`\n  ${t("Let's find your ID.", "Определим ваш ID.")} ${C.c}${t(`Open MAX, find the bot${me?.username ? ` @${me.username}` : ""}, press Start and send it any message`, `Откройте MAX, найдите бота${me?.username ? ` @${me.username}` : ""}, нажмите «Начать» и напишите любое сообщение`)}${C.x}.`);
    await ask(`  ${t("Done? press Enter", "Готово? нажмите Enter")}`);
    try {
      const found = await peekMaxUsers(client);
      if (found.length) {
        say(`  ${t("Found who messaged the bot:", "Нашёл, кто писал боту:")}`);
        found.forEach((u, i) => say(`   ${i + 1}. ${u.id}  ${u.name}`));
        const pick = await ask(`  ${t("Which IDs to add? numbers comma-separated (Enter — add all)", "Чьи ID добавить? номера через запятую (Enter — добавить всех)")}`, "");
        const chosen = pick ? pick.split(/[,\s]+/).map((n) => found[parseInt(n, 10) - 1]).filter(Boolean) : found;
        chosen.forEach((u) => ids.add(u.id));
      } else {
        say(`${C.y}  ${t("I see no messages to the bot. (If a webhook subscription is already active, polling returns nothing.)", "Не вижу сообщений боту. (Если уже стоит webhook-подписка, polling ничего не отдаёт.)")}${C.x}`);
      }
    } catch (e) {
      say(`${C.y}  ${t(`Couldn't fetch updates: ${e.message}`, `Не смог получить апдейты: ${e.message}`)}${C.x}`);
    }
    if (ids.size === 0) {
      const manual = await ask(`  ${t("Enter your MAX user ID manually (digits), or Enter — try again", "Введите свой MAX user_id вручную (цифры), или Enter — попробовать снова")}`, "");
      manual.split(/[,\s]+/).map((s) => s.trim()).filter((s) => ID_RE.test(s)).forEach((s) => ids.add(s));
    }
  }
  out.MAX_ALLOWED_USER_IDS = [...ids].join(",");
  say(`  → ${t("access granted to ID", "доступ разрешён ID")}: ${C.g}${out.MAX_ALLOWED_USER_IDS}${C.x}`);

  // Способ получения событий — после поиска id (polling-подглядывание работает, пока подписки нет).
  say(`\n  ${t("How should MAX deliver events to Iva?", "Как MAX будет доставлять события Иве?")}`);
  say(`    1) ${t("polling — works anywhere, no domain needed (MAX recommends it only for development/testing)", "polling — работает где угодно, домен не нужен (MAX рекомендует его лишь для разработки и тестов)")}`);
  say(`    2) ${t("webhook — recommended for permanent use; needs a domain with HTTPS on port 443", "webhook — рекомендуется для постоянной работы; нужен домен с HTTPS на порту 443")}`);
  const ingestChoice = (await ask(`  ${t("Delivery", "Доставка")} (1/2)`, existing.MAX_INGEST === "webhook" ? "2" : "1")).trim();
  if (ingestChoice === "2") {
    out.MAX_INGEST = "webhook";
    for (;;) {
      const url = (await ask(`  ${t("Public webhook URL (https://your.domain/max/webhook)", "Публичный адрес webhook (https://ваш.домен/max/webhook)")}`, existing.MAX_WEBHOOK_URL || "")).trim();
      try {
        out.MAX_WEBHOOK_URL = validateWebhookUrl(url);
        break;
      } catch (e) {
        say(`${C.y}  ⚠ ${t(`URL rejected: ${e.message}`, `Адрес не подошёл: ${e.message}`)}${C.x}`);
      }
    }
    say(`  ${C.y}${t(
      "The wizard does NOT register the webhook at MAX. After install: publish only /max/webhook through your reverse proxy (deploy/nginx-max-webhook.conf.example), then run:  iva max webhook set " + out.MAX_WEBHOOK_URL,
      "Мастер НЕ регистрирует webhook в MAX. После установки: опубликуйте через reverse proxy только /max/webhook (deploy/nginx-max-webhook.conf.example) и выполните:  iva max webhook set " + out.MAX_WEBHOOK_URL,
    )}${C.x}`);
  } else {
    out.MAX_INGEST = "poll";
    out.MAX_WEBHOOK_URL = "";
  }
  return { username: out.MAX_BOT_USERNAME, ids: [...ids], ingest: out.MAX_INGEST };
}
