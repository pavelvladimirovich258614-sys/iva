// Экран «Userbot» меню (/menu → 📡). Статус личного userbot-прокси (Telegram) + подключение.
// Общая CLI/Telegram-проба проверяет systemd, health endpoint и авторизацию Telethon.
// Общий таймаут 1.5с: getUpdates-цикл нельзя блокировать дольше.
// Наличие creds — булевы TELEGRAM_API_ID/TELEGRAM_API_HASH из .env (значения не показываем).
//
// Секреты (api_id/api_hash) принимаются только в личке; сообщение с ними удаляет движок
// (secret:true) до texts.ubcred. Значения не попадают в лог/eve/текст. Пишем через upsertEnv.
// Включение — отсоединённый `iva userbot setup` (сборка venv медленная, до 3 мин): не ждём
// синхронно, показываем заглушку и перерисовываем экран по завершении.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { readEnvValues, upsertEnv } from "../env-file.mjs";
import { probeUserbotHealth } from "../userbot-health.mjs";

const SID = "ub";
const PARENT = "r";
const SVC = "iva-telegram-userbot.service";

const isPrivate = (st) => Number(st.chatId) > 0;

function run(cmd, args, timeout = 1500) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, encoding: "utf8" }, (err, stdout = "") =>
      resolve({ failed: Boolean(err), code: typeof err?.code === "number" ? err.code : err ? 1 : 0, stdout: String(stdout) }),
    );
  });
}

export function runSetupCommand(bin, { exec = execFile, timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    exec(process.execPath, [bin, "userbot", "setup"], { timeout: timeoutMs, encoding: "utf8" }, (error) => {
      if (error) {
        const code = typeof error.code === "number" ? error.code : 1;
        reject(new Error(`userbot setup failed (exit ${code})`));
        return;
      }
      resolve();
    });
  });
}

async function probeStatus(ctx, env) {
  const probe = ctx.deps.probeUserbotHealth || probeUserbotHealth;
  return probe({ root: ctx.deps.root, port: env.TELEGRAM_MCP_PORT || "8724" });
}

// Единая сборка карты — используется и render(), и async-перерисовкой после setup.
async function buildScreen(st, ctx) {
  const T = ctx.tr;
  const env = await readEnvValues(ctx.deps.envPath);
  const hasCreds = Boolean(env.TELEGRAM_API_ID && env.TELEGRAM_API_HASH);
  const status = await probeStatus(ctx, env);
  const head = T("📡 Telegram userbot", "📡 Telegram-userbot");
  const beta = T(
    "🧪 Beta: personal-account automation can misbehave and carries account-ban risk.",
    "🧪 Бета: автоматизация личного аккаунта может сбоить и несёт риск блокировки.",
  );
  const stateLabel = {
    off: T("off", "выкл"),
    starting: T("starting", "запускается"),
    unreachable: T("unreachable", "недоступен"),
    unauthorized: T("login required", "нужен вход"),
    ready: T("ready", "готов"),
  }[status.state] || T("unreachable", "недоступен");
  const statusLine = `${T("Status", "Статус")}: ${stateLabel}`;

  if (!hasCreds) {
    const text = [
      head,
      "",
      beta,
      "",
      statusLine,
      "",
      T(
        "No API credentials yet. Create an app at https://my.telegram.org (API development tools) — you'll get api_id and api_hash.",
        "Ключей ещё нет. Создай приложение на https://my.telegram.org (API development tools) — получишь api_id и api_hash.",
      ),
    ].join("\n");
    return { text, rows: [[ctx.btn(T("Enter credentials", "Ввести ключи"), `iva_menu:${SID}:do:creds`)], ctx.backRow(PARENT)] };
  }

  if (status.state === "off") {
    const text = [
      head,
      "",
      beta,
      "",
      statusLine,
      "",
      T("Credentials are set. Turn the proxy on — it builds a venv (up to ~3 min).", "Ключи заданы. Включи прокси — соберётся venv (до ~3 мин)."),
    ].join("\n");
    return {
      text,
      rows: [
        [ctx.btn(T("Turn on", "Включить"), `iva_menu:${SID}:do:setup`)],
        [ctx.btn(T("🔄 Refresh", "🔄 Обновить"), `iva_menu:${SID}:rf`)],
        ctx.backRow(PARENT),
      ],
    };
  }

  if (status.state === "starting") {
    return {
      text: [
        head,
        "",
        beta,
        "",
        statusLine,
        "",
        T("The proxy service is still starting. Refresh in a moment.", "Прокси ещё запускается. Обнови через несколько секунд."),
      ].join("\n"),
      rows: [
        [ctx.btn(T("Turn off", "Выключить"), `iva_menu:${SID}:do:off`), ctx.btn(T("🔄 Refresh", "🔄 Обновить"), `iva_menu:${SID}:rf`)],
        ctx.backRow(PARENT),
      ],
    };
  }

  if (status.state === "unreachable") {
    return {
      text: [
        head,
        "",
        beta,
        "",
        statusLine,
        "",
        T(
          "The service is active, but its health endpoint did not answer. Run `iva userbot diagnose --json` for the fixed diagnostic.",
          "Сервис активен, но health endpoint не ответил. Запусти `iva userbot diagnose --json` для точной диагностики.",
        ),
      ].join("\n"),
      rows: [
        [ctx.btn(T("Turn off", "Выключить"), `iva_menu:${SID}:do:off`), ctx.btn(T("🔄 Refresh", "🔄 Обновить"), `iva_menu:${SID}:rf`)],
        ctx.backRow(PARENT),
      ],
    };
  }

  const accountHint = status.state === "unauthorized"
    ? T(
      "Proxy is on, but the Telegram account is not connected. Message the bot: «connect my telegram» to scan a QR.",
      "Прокси включён, но аккаунт Telegram не подключён. Напиши боту: «подключи мой телеграм», чтобы отсканировать QR.",
    )
    : T(
      "Proxy and Telegram account are ready.",
      "Прокси и аккаунт Telegram готовы.",
    );
  const text = [
    head,
    "",
    beta,
    "",
    statusLine,
    "",
    accountHint,
  ].join("\n");
  return {
    text,
    rows: [
      [ctx.btn(T("Turn off", "Выключить"), `iva_menu:${SID}:do:off`), ctx.btn(T("🔄 Refresh", "🔄 Обновить"), `iva_menu:${SID}:rf`)],
      ctx.backRow(PARENT),
    ],
  };
}

// Приглашение ввести api_id или api_hash (двухшаговый секретный приём).
function promptCred(st, ctx, step) {
  st.awaitText = { kind: "ubcred", secret: true, data: { step } };
  const text = step === "api_id"
    ? ctx.tr("Send your api_id (a number). I'll delete the message right away.", "Пришли api_id (число). Сообщение сразу удалю.")
    : ctx.tr("Now send your api_hash. I'll delete the message right away.", "Теперь пришли api_hash. Сообщение сразу удалю.");
  return ctx.flows.screen(st, text, [[ctx.btn(ctx.tr("Cancel", "Отмена"), `iva_menu:${SID}:o`)]]);
}

export default {
  parent: PARENT,

  render(st, ctx) {
    return buildScreen(st, ctx);
  },

  async on(verb, args, st, ctx) {
    if (verb !== "do") return ctx.show(st, SID);
    const step = args[0];

    if (step === "creds") {
      if (!isPrivate(st)) {
        st.awaitText = null;
        return ctx.flows.screen(
          st,
          ctx.tr("Credentials are secrets — open a private chat and enter them there.", "Ключи — это секрет. Открой личный чат и введи их там."),
          [ctx.backRow(PARENT)],
        );
      }
      if (ctx.secretsInChat && !ctx.secretsInChat()) {
        st.awaitText = null;
        return ctx.flows.screen(
          st,
          ctx.tr("Credentials are NOT entered in chat. On the server run:  iva userbot creds", "Ключи в чат не вводятся. На сервере выполни:  iva userbot creds"),
          [ctx.backRow(PARENT)],
        );
      }
      st.data.ub = {};
      return promptCred(st, ctx, "api_id");
    }

    if (step === "setup") {
      const bin = join(ctx.deps.root, "bin/iva.mjs");
      // Отсоединённо: НЕ ждём (venv-сборка до 3 мин заблокировала бы poll-цикл). Перерисуем
      // экран по завершении — только если пользователь всё ещё на нём.
      const setup = ctx.deps.runUserbotSetup || (() => runSetupCommand(bin));
      setup()
        .then(async () => {
          if (ctx.flows.get(st.chatId, st.userId) === st && st.screen === SID) {
            const v = await buildScreen(st, ctx);
            await ctx.flows.screen(st, v.text, v.rows);
          }
        })
        .catch(async () => {
          ctx.deps.log?.("userbot setup failed");
          if (ctx.flows.get(st.chatId, st.userId) === st && st.screen === SID) {
            await ctx.flows.screen(
              st,
              ctx.tr(
                "🧪 Beta\n\nSetup failed. Check the service logs, then try again.",
                "🧪 Бета\n\nНастройка завершилась с ошибкой. Проверь логи сервиса и повтори.",
              ),
              [
                [ctx.btn(ctx.tr("Try again", "Повторить"), `iva_menu:${SID}:do:setup`)],
                ctx.backRow(PARENT),
              ],
            );
          }
        });
      return ctx.flows.screen(
        st,
        ctx.tr(
          "🧪 Beta\n\n◇ Setting up the userbot proxy…",
          "🧪 Бета\n\n◇ Собираю userbot-прокси…",
        ),
        [ctx.backRow(PARENT)],
      );
    }

    if (step === "off") {
      await run("systemctl", ["--user", "disable", "--now", SVC]);
      return ctx.show(st, SID);
    }
    return ctx.show(st, SID);
  },

  texts: {
    // Двухшаговый приём: сначала api_id (число), затем api_hash. Сообщения уже удалены движком.
    async ubcred(text, msg, st, ctx) {
      const value = String(text).trim();
      const step = st.awaitText?.data?.step;
      if (step === "api_id") {
        if (!/^\d+$/.test(value)) {
          return ctx.flows.screen(
            st,
            ctx.tr("api_id must be a number. Send it again or cancel.", "api_id должен быть числом. Пришли ещё раз или отмени."),
            [[ctx.btn(ctx.tr("Cancel", "Отмена"), `iva_menu:${SID}:o`)]],
          );
        }
        st.data.ub = { apiId: value };
        return promptCred(st, ctx, "api_hash");
      }
      // api_hash: у Telegram это 32 hex-символа; принимаем непустой токен без пробелов.
      if (!/^\S{8,}$/.test(value)) {
        return ctx.flows.screen(
          st,
          ctx.tr("That doesn't look like an api_hash. Send it again or cancel.", "Это не похоже на api_hash. Пришли ещё раз или отмени."),
          [[ctx.btn(ctx.tr("Cancel", "Отмена"), `iva_menu:${SID}:o`)]],
        );
      }
      const apiId = st.data.ub?.apiId;
      st.awaitText = null;
      st.data.ub = null;
      try {
        await upsertEnv(ctx.deps.envPath, { TELEGRAM_API_ID: apiId, TELEGRAM_API_HASH: value });
      } catch (e) {
        return ctx.flows.screen(
          st,
          ctx.tr(`Couldn't write .env: ${e.message}`, `Не удалось записать .env: ${e.message}`),
          [ctx.backRow(PARENT)],
        );
      }
      // Ключи есть — экран покажет [Включить].
      return ctx.show(st, SID);
    },
  },
};
