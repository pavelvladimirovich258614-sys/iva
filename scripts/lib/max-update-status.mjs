// Репортёр прогресса `iva update` для MAX: тот же интерфейс, что у createTelegramUpdateReporter
// (start/done/fail/postCommitFailure/complete/dispose), но правит ОДНО сообщение через MAX Bot API.
// Задание (data/update-jobs/<id>.json) создаёт мост: { transport:"max", userId, chatId?, messageId, locale }.
import { modelSummary } from "./model-summary.mjs";
import { UPDATE_COPY } from "./telegram-status.mjs";

const LOADER = "◇";

export function createMaxUpdateReporter({ client, job, env } = {}) {
  if (!client || !job?.messageId || !job?.userId) return null;
  const lang = job.locale === "ru" ? "ru" : "en";
  const copy = UPDATE_COPY[lang];
  const target = { chatId: job.chatId ?? null, userId: String(job.userId) };
  let mid = String(job.messageId);
  let currentPhase = null;
  let lastText = "";
  let uiLost = false;

  async function edit(text) {
    if (!mid || text === lastText) return true;
    try {
      await client.editMessage(mid, text, { keyboard: [] });
      lastText = text;
      return true;
    } catch (error) {
      // 404/403 на правку — сообщение удалено или недоступно: дальше только итоговое новое.
      if (error?.status === 404 || error?.status === 403 || error?.status === 400) {
        mid = null;
        uiLost = true;
      }
      return false;
    }
  }

  async function finish(text) {
    if (await edit(text)) return;
    if (!uiLost) return;
    try {
      await client.sendOnce(target, text);
    } catch {}
  }

  return {
    async start(phase) {
      currentPhase = phase;
      if (!uiLost) await edit(`${LOADER} ${copy[phase][0]}`);
    },
    async done(phase) {
      if (currentPhase === phase) currentPhase = null;
    },
    async fail(phase, beforeVersion) {
      currentPhase = null;
      await finish(`⚠️ ${copy[phase][2]}\n\n${copy.failure(beforeVersion)}`);
    },
    async postCommitFailure(message) {
      currentPhase = null;
      await finish(`⚠️ ${copy.timerFailure}\n\n${message}`);
    },
    async complete({ beforeVersion, afterVersion }) {
      const model = modelSummary(env);
      await finish(
        [copy.final, "", `${beforeVersion} → ${afterVersion}`, `${lang === "ru" ? "Модель" : "Model"}: ${model.line}`, copy.preserved].join("\n"),
      );
    },
    dispose() {},
  };
}
