// Управление Ивой из MAX, не зависящее от способа доставки Update (long polling или webhook).
// Один вход — process(update) — и явный итог обработки:
//
//   { status: "ok",    action }  обработано (или безопасно проигнорировано/уже было сделано);
//   { status: "error", action }  команда выполнена с ошибкой, пользователь об этом уведомлён —
//                                событие «потреблено», повторять его не нужно (ack / маркер вперёд);
//   { status: "retry", reason }  временный сбой (агент недоступен, нельзя записать журнал,
//                                нельзя сообщить пользователю): НЕ подтверждать, доставить заново.
//
// action ∈ forwarded | handled | denied | ignored | duplicate | unknown-outcome.
//
// Что делает сам мост (нужны локальные права: .env, systemctl --user, systemd-run --user):
//   /menu, /model, /think, /restart, /update, нажатия кнопок (iva_menu:*, iva_model:*, iva_think:*,
//   iva_update:*) и перехват ввода, пока меню/мастер ждёт текст. Всё остальное (текст, /new, /stop,
//   /help, /usage, /task, /tasks, /digest, bot_started) уходит в канал агента POST /eve/v1/max
//   (allowlist, дедуп, sanitize, outbox) — второй пайплайн и второй агент не создаются.
//
// Повторная доставка: каждая управляющая команда/кнопка имеет ключ (mid / callback_id) в журнале
// (agent/lib/max-ledger.ts). Безопасные команды (навигация, открытие меню) можно выполнить заново;
// опасные (/restart, /update, подтверждение обновления, перезапуск после смены модели, любые
// действия меню, меняющие систему) фиксируются «started» на диск ДО запуска и при повторе не
// выполняются вторично: либо «уже сделано», либо «исход неизвестен» (процесс упал посреди).
import { AsyncLocalStorage } from "node:async_hooks";
import { scanOutbound } from "../../agent/lib/security-gate.ts";
import { tr } from "./i18n.mjs";

const idOf = (v) => (v === undefined || v === null ? "" : String(v));

/** Telegram-подобная форма сообщения для движков меню/мастера. chat.id == user_id (см. max-tg.mjs). */
export function toMsg(update) {
  const m = update?.message;
  const userId = idOf(m?.sender?.user_id);
  const rec = m?.recipient;
  if (!userId || rec?.chat_type !== "dialog" || m?.sender?.is_bot === true) return null;
  const text = typeof m?.body?.text === "string" ? m.body.text : "";
  return {
    message_id: idOf(m?.body?.mid),
    chat: { id: userId, type: "private" },
    from: { id: userId },
    text,
    _chatId: rec?.chat_id == null ? null : idOf(rec.chat_id),
  };
}

export function toCallback(update) {
  const cb = update?.callback;
  const userId = idOf(cb?.user?.user_id);
  if (!cb?.callback_id || !userId) return null;
  return {
    id: String(cb.callback_id),
    from: { id: userId },
    data: typeof cb.payload === "string" ? cb.payload : "",
    message: {
      message_id: idOf(update?.message?.body?.mid),
      chat: { id: userId, type: "private" },
    },
    _chatId: update?.message?.recipient?.chat_id == null ? null : idOf(update.message.recipient.chat_id),
  };
}

export const LOCAL_COMMANDS = new Set(["/menu", "/model", "/think", "/restart", "/update"]);
const SAFE_COMMANDS = new Set(["/menu", "/model", "/think"]); // открывают экран; повтор безвреден

/** Кнопка безопасна для повторного выполнения только если это чистая навигация/отмена. */
export function isIdempotentCallback(data) {
  if (/^iva_menu:[a-z]+:(o|pg|rf|x)(:|$)/.test(data) || data === "iva_menu:mdl" || data === "iva_menu:thk") return true;
  if (/^iva_(model|think):(cancel|back|retry|keep|chg|rs:later)$/.test(data)) return true;
  if (/^iva_(model|think):(prov|m|eff):/.test(data)) return true; // выбор шага мастера, запись одного и того же значения
  if (data === "iva_update:skip") return true;
  return false; // iva_update:do, iva_model:rs:now, любые действия меню (set/apply/do/go/…): не повторять вслепую
}

/** Счётчик сбоев MAX API при показе результата пользователю — на время одной обработки. */
export function createFailureTracker() {
  const als = new AsyncLocalStorage();
  return {
    run: (fn) => als.run({ transient: 0, permanent: 0 }, fn),
    snapshot: () => als.getStore() ?? { transient: 0, permanent: 0 },
    /** Оборачивает tg(): неудачные sendMessage/editMessageText запоминаются. */
    wrap(tg) {
      return async (method, params) => {
        const r = await tg(method, params);
        if (r && r.ok === false && (method === "sendMessage" || method === "editMessageText")) {
          const st = als.getStore();
          if (st) r.retryable ? st.transient++ : st.permanent++;
        }
        return r;
      };
    },
  };
}

function safeReason(err) {
  const raw = String(err?.message ?? err ?? "unknown error").split("\n")[0].slice(0, 200);
  return scanOutbound(raw).text; // ни токен, ни ключ не должны попасть в чат
}

export function createMaxBridge({
  allowed,
  forward, // async (update) => void; бросает при неуспехе (мост повторит)
  tg,
  reply, // async (chatId, text) => result|null
  menu,
  wizard,
  flows,
  handleUpdate: onUpdateCallback, // iva_update:* (кнопки обновления)
  handleUpdateCheck,
  restartAgent, // async (userId) => void
  ledger,
  tracker = createFailureTracker(),
  rememberDialog = () => {},
  log = () => {},
}) {
  const isAllowed = (userId) => allowed.size > 0 && allowed.has(userId);
  const retry = (reason) => ({ status: "retry", reason });
  const ok = (action) => ({ status: "ok", action });

  // Последовательность обработки на пользователя: порядок и отсутствие гонок на ledger/flows.
  const chains = new Map();
  function serialize(key, fn) {
    const prev = chains.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    const tail = next.catch(() => {});
    chains.set(key, tail);
    void tail.then(() => chains.get(key) === tail && chains.delete(key));
    return next;
  }

  async function tryNotify(userId, text) {
    try {
      const r = await reply(userId, text);
      return r !== null && r !== undefined && r !== false;
    } catch {
      return false;
    }
  }

  /**
   * Выполняет команду под защитой журнала.
   * @param spec { key, userId, idempotent, run: async () => void, label }
   */
  async function runLedgered({ key, userId, idempotent, run, label }) {
    let decision;
    try {
      decision = ledger.begin(key, { idempotent });
    } catch (e) {
      // Намерение не удалось записать — опасную команду НЕ запускаем.
      log(`ledger unavailable, command not started (${label}):`, e.message);
      return retry("ledger-unavailable");
    }
    if (decision.kind === "busy") return retry("in-flight");
    if (decision.kind === "skip") {
      if (decision.state === "failed" && !decision.notified) {
        const sent = await tryNotify(
          userId,
          tr(
            `⚠️ I couldn't show the result of ${label} earlier. I did NOT run it again — check /menu → Status.`,
            `⚠️ Результат ${label} раньше показать не удалось. Повторно я его НЕ запускала — проверь /menu → Статус.`,
          ),
        );
        if (!sent) return retry("notify-failed");
        ledger.markNotified(key);
        return { status: "error", action: "duplicate" };
      }
      return { status: decision.state === "failed" ? "error" : "ok", action: "duplicate" };
    }
    if (decision.kind === "unknown") {
      const sent = await tryNotify(
        userId,
        tr(
          `⚠️ The earlier attempt of ${label} was interrupted, so I can't tell whether it finished. I did NOT run it again — check /menu → Status and repeat it yourself if needed.`,
          `⚠️ Прошлая попытка ${label} оборвалась, поэтому я не знаю, завершилась ли она. Повторно я её НЕ запускала — проверь /menu → Статус и при необходимости повтори сам.`,
        ),
      );
      if (!sent) return retry("notify-failed");
      ledger.resolveUnknown(key);
      return ok("unknown-outcome");
    }

    // decision.kind === "run"
    let failure = null;
    const seen = await tracker.run(async () => {
      try {
        await run();
      } catch (e) {
        failure = e;
      }
      return tracker.snapshot();
    });

    if (failure) {
      log(`${label} failed:`, failure.message);
      const sent = await tryNotify(userId, tr(`⚠️ ${label} failed: ${safeReason(failure)}`, `⚠️ ${label}: ошибка — ${safeReason(failure)}`));
      if (idempotent) {
        ledger.release(key);
        return sent ? { status: "error", action: "handled" } : retry("notify-failed");
      }
      ledger.fail(key, sent);
      return sent ? { status: "error", action: "handled" } : retry("notify-failed");
    }
    if (seen.transient > 0) {
      // Команда отработала, но ответ пользователю не дошёл из-за временной недоступности MAX API.
      if (idempotent) {
        ledger.release(key);
        return retry("reply-not-delivered");
      }
      ledger.fail(key, false); // выполнено, показать результат не смогли: повторно не запускать, только уведомить
      return retry("reply-not-delivered");
    }
    ledger.finish(key);
    return ok("handled");
  }

  async function handleCallback(update) {
    const cq = toCallback(update);
    if (!cq) return ok("ignored");
    if (cq._chatId) rememberDialog(cq.from.id, cq._chatId);
    if (!isAllowed(cq.from.id)) {
      await tg("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});
      return ok("denied");
    }
    const d = cq.data;
    const known = d.startsWith("iva_update:") || d.startsWith("iva_model:") || d.startsWith("iva_think:") || d.startsWith("iva_menu:");
    if (!known) {
      await tg("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});
      return ok("ignored");
    }
    const idempotent = isIdempotentCallback(d);
    const res = await runLedgered({
      key: `cb:${cq.id}`,
      userId: cq.from.id,
      idempotent,
      label: tr("the button action", "действие кнопки"),
      run: async () => {
        if (d.startsWith("iva_update:")) await onUpdateCallback(cq);
        else if (d.startsWith("iva_model:") || d.startsWith("iva_think:")) await wizard.handleWizardCallback(cq);
        else await menu.onCallback(cq);
      },
    });
    // Дубль/ошибка/неизвестный исход: гасим спиннер кнопки, чтобы интерфейс не «висел».
    if (res.action === "duplicate" || res.action === "unknown-outcome" || res.status !== "ok") {
      await tg("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});
    }
    return res;
  }

  async function handleMessage(update) {
    const msg = toMsg(update);
    if (!msg) return null; // не диалог/без отправителя: канал сам решит (и проигнорирует)
    if (!isAllowed(msg.from.id)) return ok("denied"); // чужим молчим, в агента не пускаем
    if (msg._chatId) rememberDialog(msg.from.id, msg._chatId);
    const text = msg.text.trim();
    const key = `msg:${msg.message_id || `${msg.from.id}:${update.timestamp}`}`;
    const userId = msg.from.id;

    // Ждущий ввод меню/мастера забирает следующее сообщение пользователя, команда снимает ожидание.
    const pending = flows.get(msg.chat.id, userId);
    const a = pending?.awaitText;
    if (a) {
      if (text.startsWith("/")) {
        await flows.end(pending, tr("Cancelled — no longer waiting for input.", "Отменено — ожидание ввода снято.")).catch(() => {});
      } else if (text) {
        return runLedgered({
          key,
          userId,
          idempotent: false,
          label: tr("input handling", "обработку ввода"),
          run: async () => {
            if (pending.flow === "menu") await menu.onText(msg, pending);
            else await wizard.handleKeyMessage(msg, pending);
          },
        });
      } else if (a.secret || a.file) {
        // Вложение вместо секрета: удаляем и просим текстом, в агента не отдаём.
        return runLedgered({
          key,
          userId,
          idempotent: true,
          label: tr("input handling", "обработку ввода"),
          run: async () => {
            await tg("deleteMessage", { chat_id: msg.chat.id, message_id: msg.message_id }).catch(() => {});
            await reply(msg.chat.id, tr("Send it as text, please.", "Пришли это, пожалуйста, текстом."));
          },
        });
      }
    }

    if (!text.startsWith("/")) return null;
    const cmd = text.split(/\s+/, 1)[0].toLowerCase();
    if (!LOCAL_COMMANDS.has(cmd)) return null;
    const chat = msg.chat.id;
    return runLedgered({
      key,
      userId,
      idempotent: SAFE_COMMANDS.has(cmd),
      label: cmd,
      run: async () => {
        if (cmd === "/menu") await menu.open(chat, userId);
        else if (cmd === "/model") await wizard.handleModelCmd(chat, userId);
        else if (cmd === "/think") await wizard.handleThinkCmd(chat, userId);
        else if (cmd === "/update") await handleUpdateCheck(chat);
        else if (cmd === "/restart") await restartAgent(userId);
      },
    });
  }

  async function dispatch(update) {
    const type = update?.update_type;
    if (type === "message_callback") return handleCallback(update);
    if (type === "message_created") {
      const r = await handleMessage(update);
      if (r) return r;
    } else if (type !== "bot_started") {
      return ok("ignored");
    }
    try {
      await forward(update);
    } catch (e) {
      log("forward to the agent failed:", e.message);
      return e?.consumed ? { status: "error", action: "forwarded" } : retry("agent-unavailable");
    }
    return ok("forwarded");
  }

  /** Единый вход. Не бросает: любой сбой превращается в явный статус. */
  async function process(update) {
    const user = idOf(update?.callback?.user?.user_id ?? update?.message?.sender?.user_id ?? update?.user?.user_id) || "anon";
    try {
      return await serialize(user, () => dispatch(update));
    } catch (e) {
      log("unexpected failure while processing an update:", e.message);
      return retry("internal-error");
    }
  }

  return { process };
}
