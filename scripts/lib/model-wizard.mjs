// Мастера /model и /think (выбор провайдера, модели и reasoning-усилия) — транспортно-независимая
// логика. Вынесено из scripts/telegram-poll.mjs без изменения поведения, чтобы тот же мастер
// работал и в Telegram-, и в MAX-мосте: всё, что зависит от транспорта (tg(method, params),
// отправка, systemctl, allowlist, определение «личного» чата), приходит параметрами фабрики.
//
// tg(method, params) -> { ok, result, description } — интерфейс Bot API (для MAX его даёт
// scripts/lib/max-tg.mjs). Состояние мастера живёт в общем session-store `flows` (tg-flow.mjs).
import { readEnvValues, upsertEnv } from "./env-file.mjs";
import {
  CATALOG,
  EFFORTS,
  fetchModelOptions,
  checkKey,
  providerSupportsReasoning,
} from "./model-catalog.mjs";
import { ModelValidationError, validateModelSelection } from "./model-validation.mjs";
import { getAccessToken, runDeviceCodeLogin } from "./codex-oauth.mjs";
import { getLang, tr } from "./i18n.mjs";

export function createModelWizard({
  tg,
  log = () => {},
  flows,
  envPath,
  dataDir,
  allowed,
  sc,
  reply,
  // Секреты (API-ключи) принимаем только в личном диалоге. Telegram: id личных чатов положительны.
  isPrivate = (st) => Number(st.chatId) > 0,
}) {
  // ── /model & /think wizard (out-of-band, inline keyboards) ─────────────────
  // State lives in memory keyed by `${chatId}:${userId}`; each flow edits ONE message
  // (like /update). A bridge restart loses state — stale button taps get "диалог устарел".
  // Config is always read fresh from .env: this process's env goes stale after writes.
  // Примитивы визарда вынесены в scripts/lib/tg-flow.mjs (createFlows): тот же слот на
  // пользователя делят /model, /think и /menu. Локальные алиасы сохраняют исходные call-sites —
  // дифф визарда минимальный, а стейт-семантика (ключ chatId:userId, TTL 15 мин, identity-replace,
  // edit-in-place) дословно та же.
  const getWizard = (chatId, userId) => flows.get(chatId, userId);
  const newWizard = (chatId, userId, flow, extra) => flows.start(chatId, userId, flow, extra);
  const wizScreen = (st, text, rows) => flows.screen(st, text, rows);
  const endWizard = (st, text, rows) => flows.end(st, text, rows);
  const wizardIsCurrent = (st) => flows.get(st.chatId, st.userId) === st;

  // A network result belongs to the wizard object that started it. The slot can be
  // replaced while the request is pending (Cancel, /menu, another /model), so both
  // success and error must be discarded before either path mutates or renders state.
  async function runWizardRequest(st, request, isCurrent = wizardIsCurrent) {
    try {
      const value = await request();
      return isCurrent(st) ? { ok: true, value } : { stale: true };
    } catch (error) {
      return isCurrent(st) ? { ok: false, error } : { stale: true };
    }
  }

  const EFFORT_SET = new Set(EFFORTS);
  // effortLabel — функция (tr на месте вызова): язык не замораживается в module-level const.
  const effortLabel = (v) => (v && EFFORT_SET.has(v) ? v : tr("not set", "не задан"));

  function isStaleWizard(st, messageId) {
    return !st || (st.msgId != null && messageId != null && st.msgId !== messageId);
  }

  function wizardActionAllowed(st, action) {
    if (!st || action === "cancel") return Boolean(st);
    if (action === "keep") return st.step === "intro" || st.step === "effort";
    if (action === "chg") return st.step === "intro";
    if (action.startsWith("prov:")) return st.step === "provider";
    if (action.startsWith("m:")) return st.step === "models";
    if (action.startsWith("eff:")) return st.step === "effort";
    if (action === "retry" || action === "back") return st.step === "model_error";
    if (action.startsWith("rs:")) return st.step === "saved";
    return false;
  }

  function selectWizardModel(st, rawIndex) {
    if (!/^(0|[1-9]\d*)$/.test(String(rawIndex))) return null;
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0) return null;
    const option = st.modelOptions?.[index];
    if (!option) return null;
    st.model = option.id;
    st.efforts = [...option.reasoningLevels];
    return option;
  }

  function selectWizardEffort(st, value) {
    if (value === "unset") {
      st.effort = null;
      return true;
    }
    if (!EFFORT_SET.has(value) || !st.efforts?.includes(value)) return false;
    st.effort = value;
    return true;
  }

  function selectableWizardOptions(options, current, limit = 30) {
    const live = Array.isArray(options) ? options : [];
    const currentOption = live.find((option) => option.id === current);
    return [
      ...(currentOption ? [currentOption] : []),
      ...live.filter((option) => option !== currentOption),
    ].slice(0, limit);
  }

  async function currentConfig() {
    const env = await readEnvValues(envPath);
    const provider = CATALOG[env.MODEL_PROVIDER] ? env.MODEL_PROVIDER : "ollama";
    const cat = CATALOG[provider];
    return {
      provider,
      model: env[cat.modelVar] || cat.def,
      effort: providerSupportsReasoning(provider) ? (env.THINKING_EFFORT ?? "").toLowerCase() : "",
    };
  }

  const btn = (text, callback_data) => ({ text, callback_data });
  // cancelRow/menuRow — функции (tr на месте вызова), не module-level const с переведённой строкой.
  const cancelRow = () => [btn(tr("Cancel", "Отмена"), "iva_model:cancel")];
  const retryBackRows = () => [[
    btn(tr("Retry", "Повторить"), "iva_model:retry"),
    btn(tr("‹ Back", "‹ Назад"), "iva_model:back"),
  ]];
  // Ряд «‹ Меню» на терминальных экранах визарда — возврат в /menu. r:o усыновляет
  // это сообщение даже без живого стейта (движок меню само-чинится после рестарта моста).
  const menuRow = () => [[btn(tr("‹ Menu", "‹ Меню"), "iva_menu:r:o")]];

  // Секреты (API-ключи) принимаем ТОЛЬКО в личке: в группе бот может не иметь прав удалить
  // сообщение с ключом (deleteMessage вернёт !ok), и его увидят все участники. Знак chatId
  // надёжен — id личных чатов положительны, групп/супергрупп отрицательны (та же isPrivate,
  // что в menu-экранах search.mjs). Гейтим ОБА пути к ключу: и голый /model, и хендофф из /menu.
  const isPrivateChat = (st) => isPrivate(st);
  const refuseSecretInGroup = (st) =>
    endWizard(st, tr(
      "API keys are secrets — open a private chat with me and set the key there.",
      "Ключи — это секрет. Открой личный чат со мной и введи ключ там.",
    ), menuRow());

  function effortRows(ns, withKeep, efforts) {
    const rows = [];
    for (let i = 0; i < efforts.length; i += 3) {
      rows.push(efforts.slice(i, i + 3).map((effort) => btn(effort, `${ns}:eff:${effort}`)));
    }
    rows.push([btn(tr("Don't set", "Не задавать"), `${ns}:eff:unset`), withKeep ? btn(tr("Keep", "Оставить"), `${ns}:keep`) : cancelRow()[0]]);
    return rows;
  }

  // {msgId} (опц.) — хендофф из /menu: визард заменяет flow-слот и рисует в ТО ЖЕ сообщение меню.
  async function handleModelCmd(chatId, from, { msgId } = {}) {
    const { provider, model, effort } = await currentConfig();
    const st = newWizard(chatId, from, "model");
    st.msgId = msgId ?? null;
    st.step = "intro";
    await wizScreen(st, tr(
      `Now: provider ${provider} · model ${model} · thinking: ${effortLabel(effort)}.`,
      `Сейчас: провайдер ${provider} · модель ${model} · размышления: ${effortLabel(effort)}.`,
    ), [
      [btn(tr("Change", "Сменить"), "iva_model:chg"), btn(tr("Keep", "Оставить"), "iva_model:keep")],
    ]);
  }

  async function handleThinkCmd(chatId, from, { msgId } = {}) {
    const { provider, model, effort } = await currentConfig();
    const st = newWizard(chatId, from, "think");
    st.provider = provider;
    st.model = model;
    st.msgId = msgId ?? null;
    if (!providerSupportsReasoning(provider)) {
      await endWizard(st, tr(
        `Adjustable thinking is unavailable for ${CATALOG[provider].label}. Choose a reasoning-capable provider via /model.`,
        `Настраиваемые размышления недоступны для ${CATALOG[provider].label}. Выбери провайдера с reasoning через /model.`,
      ), menuRow());
      return;
    }
    const cat = CATALOG[provider];
    const env = await readEnvValues(envPath);
    st.step = "loading";
    await wizScreen(st, tr(
      `Loading thinking levels for ${model}…`,
      `Загружаю уровни размышлений для ${model}…`,
    ), [cancelRow()]);
    if (!wizardIsCurrent(st)) return;
    const loaded = await runWizardRequest(
      st,
      () => fetchModelOptions(provider, cat.keyVar ? env[cat.keyVar] : undefined, { dataDir: dataDir }),
    );
    const options = await resolveThinkCatalogLoad(st, loaded);
    if (options === null) return;
    const option = options.find((candidate) => candidate.id === model);
    if (!option) return showModelValidationError(
      st,
      new ModelValidationError("model_unavailable", `${model} is not in the live catalog`),
    );
    st.modelOptions = [option];
    st.model = model;
    st.efforts = [...option.reasoningLevels];
    st.step = "effort";
    await wizScreen(st,
      tr(`Thinking level for ${model}: ${effortLabel(effort)}.`, `Уровень размышлений для ${model}: ${effortLabel(effort)}.`),
      effortRows("iva_think", true, st.efforts));
  }

  async function resolveThinkCatalogLoad(
    st,
    loaded,
    showErrorImpl = showModelValidationError,
  ) {
    if (loaded.stale) return null;
    if (!loaded.ok) {
      await showErrorImpl(st, loaded.error);
      return null;
    }
    return loaded.value;
  }

  async function showProviderScreen(st) {
    st.step = "provider";
    const rows = Object.entries(CATALOG).map(([id, c]) => [btn(c.label, `iva_model:prov:${id}`)]);
    rows.push(cancelRow());
    await wizScreen(st, tr("Pick a provider:", "Выбери провайдера:"), rows);
  }

  async function pickProvider(st, provider) {
    st.provider = provider;
    st.pendingKey = null;
    const cat = CATALOG[provider];
    if (cat.auth === "oauth") {
      st.step = "loading";
      await wizScreen(st, tr(
        "Checking the OpenAI subscription…",
        "Проверяю подписку OpenAI…",
      ), [cancelRow()]);
      if (!wizardIsCurrent(st)) return;
      // File presence is not enough — a revoked/expired refresh token would let the wizard
      // finish into a config that 401s every turn. getAccessToken refreshes a stale token
      // and throws when there is no usable auth → device-link login.
      const auth = await runWizardRequest(st, () => getAccessToken(dataDir));
      if (auth.stale) return;
      if (!auth.ok) return startCodexLogin(st);
      return showModelScreen(st);
    }
    const env = await readEnvValues(envPath);
    if (!wizardIsCurrent(st)) return;
    if (!env[cat.keyVar] || st.reenterKey === provider) {
      st.reenterKey = null;
      // В группе ключ вводить нельзя (его не удалить) — отказ до установки awaitText.
      if (!isPrivateChat(st)) return refuseSecretInGroup(st);
      // awaitText обобщает старый awaitKey (см. handleControl): диспатчер по pending.awaitText
      // отдаёт следующий текст этому визарду (handleKeyMessage), а не eve.
      st.awaitText = { kind: "apikey", secret: true, data: {} };
      st.step = "awaiting_key";
      await wizScreen(st,
        tr(
          `Need a ${cat.label} API key. Send it in the next message — I'll delete it from the chat right away.\n` +
          "If I don't confirm within a couple of seconds — don't resend, start over with /model.",
          `Нужен API-ключ ${cat.label}. Пришли его следующим сообщением — я сразу удалю его из чата.\n` +
          "Если через пару секунд не подтвержу получение — не отправляй повторно, начни заново с /model.",
        ),
        [cancelRow()]);
      return;
    }
    return showModelScreen(st);
  }

  async function showModelScreen(st) {
    const cat = CATALOG[st.provider];
    const env = await readEnvValues(envPath);
    if (!wizardIsCurrent(st)) return;
    st.step = "loading";
    await wizScreen(st, tr(
      `Loading models for ${cat.label}…`,
      `Загружаю модели ${cat.label}…`,
    ), [cancelRow()]);
    if (!wizardIsCurrent(st)) return;
    const loaded = await runWizardRequest(
      st,
      () => fetchModelOptions(
        st.provider,
        cat.keyVar ? (st.pendingKey ?? env[cat.keyVar]) : undefined,
        { dataDir: dataDir },
      ),
    );
    if (loaded.stale) return;
    if (!loaded.ok) {
      return showModelValidationError(st, loaded.error);
    }
    const options = loaded.value;
    const current = env[cat.modelVar];
    st.modelOptions = selectableWizardOptions(options, current);
    st.step = "models";
    const rows = st.modelOptions.map((option, i) => [btn(option.id, `iva_model:m:${i}`)]);
    rows.push(cancelRow());
    const currentLine = current
      ? tr(`Current (display only): ${current}.`, `Текущая (только для справки): ${current}.`)
      : "";
    await wizScreen(st, [
      currentLine,
      tr(`Choose a live model (${cat.label}):`, `Выбери модель из живого каталога (${cat.label}):`),
    ].filter(Boolean).join("\n"), rows);
  }

  async function showModelValidationError(st, error) {
    st.step = "model_error";
    if (error?.code === "auth_rejected" && CATALOG[st.provider]?.keyVar) {
      st.reenterKey = st.provider;
    }
    const reason = error instanceof ModelValidationError
      ? error.message
      : tr("provider validation failed", "проверка провайдера не прошла");
    await wizScreen(st, tr(
      `Couldn't validate the live model catalog: ${reason}. Your current configuration was not changed.`,
      `Не удалось проверить живой каталог моделей: ${reason}. Текущая конфигурация не изменена.`,
    ), retryBackRows());
  }

  // Codex device-link login. runDeviceCodeLogin polls up to 15 min — deliberately NOT
  // awaited, so the getUpdates loop keeps running; the continuation discards itself
  // when this state object is no longer the current wizard (cancelled/replaced).
  function startCodexLogin(st) {
    st.step = "login";
    // Serialize device-code log lines (link, one-time code) into ordered chat messages.
    let q = Promise.resolve();
    const tlog = (m) => { q = q.then(() => reply(st.chatId, String(m).trim())); };
    runDeviceCodeLogin({ dataDir: dataDir, lang: getLang(), log: tlog })
      .then(() => {
        // Identity-сверка: flows.get !== st истинно и когда слот заменён (другой /model,
        // /menu), и когда протух по TTL — осиротевшая континуация сама себя отбрасывает.
        if (flows.get(st.chatId, st.userId) !== st) return;
        return showModelScreen(st);
      })
      .catch((e) => {
        if (flows.get(st.chatId, st.userId) !== st) return;
        return endWizard(st, tr(
          "Login failed: " + e.message + "\nSend /model to try again.",
          "Вход не удался: " + e.message + "\nОтправь /model, чтобы попробовать снова.",
        ), menuRow());
      });
    return wizScreen(st, tr(
      "Waiting for the OpenAI subscription login — link and code below. The code lives 15 minutes.",
      "Жду вход по подписке OpenAI — ссылка и код ниже. Код живёт 15 минут.",
    ), [cancelRow()]);
  }

  // Plain-text message while the wizard awaits an API key. Deleted from the chat FIRST;
  // the key value must never reach eve, log(), reply() or any error text.
  async function handleKeyMessage(msg, st) {
    const chatId = msg.chat.id;
    const del = await tg("deleteMessage", { chat_id: chatId, message_id: msg.message_id });
    if (!wizardIsCurrent(st)) return true;
    if (!del.ok) {
      await reply(chatId, tr("Couldn't delete the message with the key — delete it manually.", "Не смог удалить сообщение с ключом — удали его вручную."));
      if (!wizardIsCurrent(st)) return true;
    }
    const key = msg.text.trim();
    // Not key-shaped (whitespace / too short) — most likely an ordinary message typed
    // while the prompt was pending. Don't store it; end the wait so the chat works again.
    if (!/^\S{8,}$/.test(key)) {
      await endWizard(st,
        tr(
          "That doesn't look like an API key — the wait is cleared, I deleted the message just in case.\n" +
          "If it was a question — send it again; come back for a key via /model.",
          "Это не похоже на API-ключ — ожидание снято, сообщение удалил на всякий случай.\n" +
          "Если это был вопрос — отправь его ещё раз; за ключом приходи через /model.",
        ), menuRow());
      return true;
    }
    const cat = CATALOG[st.provider];
    const checked = await runWizardRequest(st, () => checkKey(st.provider, key));
    if (checked.stale) return true;
    if (!checked.ok) {
      await endWizard(st, tr(
        "Couldn't validate the key. Start again with /model.",
        "Не удалось проверить ключ. Начни заново через /model.",
      ), menuRow());
      return true;
    }
    const err = checked.value;
    if (err) {
      await wizScreen(st, tr(`Key rejected (${err}). Send another key or tap «Cancel».`, `Ключ не принят (${err}). Пришли другой ключ или нажми «Отмена».`), [cancelRow()]);
      return true;
    }
    st.awaitText = null;
    st.pendingKey = key;
    if (!wizardIsCurrent(st)) return true;
    await showModelScreen(st);
    return true;
  }

  async function validateAndSaveWizard(st, {
    readEnv = () => readEnvValues(envPath),
    validate = validateModelSelection,
    write = (updates) => upsertEnv(envPath, updates),
  } = {}) {
    const env = await readEnv();
    const cat = CATALOG[st.provider];
    if (!cat || typeof st.model !== "string") {
      throw new ModelValidationError("invalid_selection", "invalid wizard selection");
    }
    const key = cat.keyVar ? (st.pendingKey ?? env[cat.keyVar]) : undefined;
    await validate({
      provider: st.provider,
      model: st.model,
      key,
      dataDir: dataDir,
    });
    const updates = { THINKING_EFFORT: st.effort }; // null ⇒ drop the line ("не задан")
    if (st.flow === "model") {
      updates.MODEL_PROVIDER = st.provider;
      updates[cat.modelVar] = st.model;
      if (cat.keyVar && st.pendingKey) updates[cat.keyVar] = st.pendingKey;
    }
    await write(updates);
  }

  const saveWizard = (st) => validateAndSaveWizard(st);

  async function showSaved(st) {
    const { provider, model, effort } = await currentConfig();
    if (!wizardIsCurrent(st)) return;
    let text = tr(`Saved: ${provider} · ${model} · thinking: ${effortLabel(effort)}.`, `Сохранил: ${provider} · ${model} · размышления: ${effortLabel(effort)}.`);
    text += tr("\nRestart the agent to apply?", "\nПерезапустить агента, чтобы применить?");
    st.step = "saved";
    await wizScreen(st, text, [[btn(tr("Restart now", "Перезапустить сейчас"), "iva_model:rs:now"), btn(tr("Later", "Позже"), "iva_model:rs:later")]]);
  }

  // Inline-button taps for /model and /think. Mirrors handleUpdateCallback: ack the
  // spinner first, swallow untrusted taps, then dispatch on the wizard state.
  async function handleWizardCallback(cq) {
    const from = String(cq.from?.id ?? "");
    const chatId = cq.message?.chat?.id;
    const messageId = cq.message?.message_id;
    await tg("answerCallbackQuery", { callback_query_id: cq.id });
    if (allowed.size === 0 || !allowed.has(from)) return true; // swallow untrusted taps
    const action = cq.data.replace(/^iva_(model|think):/, "");
    const st = getWizard(chatId, from);
    // No state (bridge restarted / TTL) or a tap on an older wizard message → stale.
    if (isStaleWizard(st, messageId)) {
      await tg("editMessageText", { chat_id: chatId, message_id: messageId, text: tr("This dialog has expired — send /model again.", "Диалог устарел — отправь /model заново.") });
      return true;
    }
    if (!wizardActionAllowed(st, action)) return true;
    if (action === "keep") {
      await endWizard(st, st.flow === "think" ? tr("Kept the current thinking level.", "Оставил текущий уровень размышлений.") : tr("Kept the current configuration.", "Оставил текущую конфигурацию."), menuRow());
      return true;
    }
    if (action === "cancel") {
      await endWizard(st, tr("Cancelled.", "Отменено."), menuRow());
      return true;
    }
    if (action === "chg") {
      await showProviderScreen(st);
      return true;
    }
    if (action.startsWith("prov:")) {
      const p = action.slice("prov:".length);
      if (CATALOG[p]) await pickProvider(st, p);
      return true;
    }
    if (action === "retry") {
      if (st.flow === "think") {
        await handleThinkCmd(st.chatId, st.userId, { msgId: st.msgId });
        return true;
      }
      await showModelScreen(st);
      return true;
    }
    if (action === "back") {
      if (st.flow === "think") {
        await endWizard(st, tr("Kept the current configuration.", "Оставил текущую конфигурацию."), menuRow());
        return true;
      }
      await showProviderScreen(st);
      return true;
    }
    if (action.startsWith("m:")) {
      const option = selectWizardModel(st, action.slice("m:".length));
      if (!option) return true;
      if (option.reasoningLevels.length === 0) {
        st.effort = null;
        try {
          await saveWizard(st);
        } catch (e) {
          if (!wizardIsCurrent(st)) return true;
          if (e instanceof ModelValidationError) {
            await showModelValidationError(st, e);
            return true;
          }
          await endWizard(st, tr("Couldn't save .env: " + e.message, "Не удалось сохранить .env: " + e.message), menuRow());
          return true;
        }
        if (!wizardIsCurrent(st)) return true;
        await showSaved(st);
        return true;
      }
      st.step = "effort";
      await wizScreen(st,
        tr(`Thinking level for ${option.id}:`, `Уровень размышлений для ${option.id}:`),
        effortRows("iva_model", false, st.efforts));
      return true;
    }
    if (action.startsWith("eff:")) {
      const v = action.slice("eff:".length);
      if (!selectWizardEffort(st, v)) return true;
      try {
        await saveWizard(st);
      } catch (e) {
        if (!wizardIsCurrent(st)) return true;
        if (e instanceof ModelValidationError) {
          await showModelValidationError(st, e);
          return true;
        }
        await endWizard(st, tr("Couldn't save .env: " + e.message, "Не удалось сохранить .env: " + e.message), menuRow());
        return true;
      }
      if (!wizardIsCurrent(st)) return true;
      await showSaved(st);
      return true;
    }
    if (action === "rs:later") {
      await endWizard(st, tr("Saved. It'll apply after a restart (/restart).", "Сохранил. Применится после перезапуска (/restart)."), menuRow());
      return true;
    }
    if (action === "rs:now") {
      await endWizard(st, tr("Restarting the agent… (~30s). The current conversation resumes after the restart.", "Перезапускаю агента… (~30 сек). Текущий диалог продолжится после перезапуска."), menuRow());
      // Plain restart: a config change is not a recovery — parked
      // conversations in .workflow-data survive and resume under the new model.
      const ok = await sc("restart", "iva.service");
      if (ok) {
        const { provider, model, effort } = await currentConfig();
        await reply(chatId, tr(`Done — the new configuration is active: ${provider} · ${model} · thinking: ${effortLabel(effort)}.`, `Готово — новая конфигурация активна: ${provider} · ${model} · размышления: ${effortLabel(effort)}.`));
      } else {
        await reply(chatId, tr("Couldn't restart (systemctl). Check the service on the server.", "Не удалось перезапустить (systemctl). Проверь сервис на сервере."));
      }
      return true;
    }
    return true;
  }


  return {
    getWizard,
    newWizard,
    wizScreen,
    endWizard,
    wizardIsCurrent,
    runWizardRequest,
    isStaleWizard,
    wizardActionAllowed,
    selectWizardModel,
    selectWizardEffort,
    selectableWizardOptions,
    handleModelCmd,
    handleThinkCmd,
    resolveThinkCatalogLoad,
    handleKeyMessage,
    validateAndSaveWizard,
    handleWizardCallback,
  };
}
