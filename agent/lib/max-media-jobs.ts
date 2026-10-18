// Durable-очередь обработки входящих вложений (data/max/media-jobs.json, 0600).
//
// Зачем: скачивание, распознавание речи и анализ изображений занимают секунды, а вебхук MAX нужно
// подтвердить быстро. Порядок такой: событие проверено (секрет → allowlist → дедуп) → задание ЗАПИСАНО
// на диск → подтверждение 200 → обработка в фоне → send() в Eve.
//
// Гарантии (честно): at-least-once до записи задания, дальше — «передать агенту не более одного раза или явно
// сообщить». Вызов send() в Eve неидемпотентен (второй вызов = второй ход, вторая задача), поэтому после тайм-аута
// или падения процесса он автоматически НЕ повторяется; пользователь получает точное сообщение (не передано /
// исход неизвестен). Задание удаляется только после принятия агентом либо надёжной постановки уведомления в outbox.

import { join } from "node:path";
import type { MaxInboundAttachment, MaxLinkedContent } from "./max-updates.ts";
import { readJsonFile, writeJsonAtomic } from "./max-store.ts";

/**
 * Жизненный цикл задания (каждое изменение пишется на диск ДО следующего шага):
 *   queued → processing → sending → (удалено)      — агент принял сообщение;
 *   sending → unknown                              — вызов send() завис/упал в неизвестный момент: исход НЕИЗВЕСТЕН,
 *                                                    автоматически не повторяется;
 *   * → notify                                     — осталось доставить уведомление (outbox был недоступен).
 * Задание удаляется только когда результат принят агентом или все нужные уведомления надёжно поставлены в очередь.
 */
export type MediaJobState = "queued" | "processing" | "sending" | "unknown" | "notify";

export interface MediaJob {
  key: string;
  userId: string;
  chatId: string | null;
  text: string;
  mid: string | null;
  attachments: MaxInboundAttachment[];
  linked: MaxLinkedContent | null;
  createdAt: number;
  state: MediaJobState;
  /** Уведомления пользователю, которые не удалось поставить в outbox (повторяются, пока не уйдут). */
  pendingNotices?: string[];
  /** Пользователь уже предупреждён, что исход неизвестен (второй раз не говорим). */
  noticeSent?: boolean;
}

interface JobsFile {
  jobs: Record<string, MediaJob>;
}

export interface MediaJobs {
  /** Записывает задание на диск; бросает, если записать нельзя (тогда подтверждать событие нельзя). */
  accept(job: Omit<MediaJob, "state" | "createdAt">): MediaJob;
  /**
   * Применяет изменение и пишет на диск. Возвращает false, если записать не удалось: изменение остаётся в памяти
   * (для повторной попытки доставки уведомлений), но вызывающий не вправе считать его долговечным.
   */
  update(key: string, patch: Partial<Pick<MediaJob, "state" | "pendingNotices" | "noticeSent">>): boolean;
  remove(key: string): void;
  list(): MediaJob[];
  health(): { corrupt: boolean; pending: number; persistFailing: boolean };
}

export function createMediaJobs({
  dir,
  now = Date.now,
  log = (m: string) => console.error(`[max] ${m}`),
  io = { writeJson: writeJsonAtomic },
}: {
  dir: string;
  now?: () => number;
  log?: (m: string) => void;
  io?: { writeJson(file: string, value: unknown): void };
}): MediaJobs {
  const file = join(dir, "media-jobs.json");
  let corrupt = false;
  let persistFailing = false;
  const data = readJsonFile<JobsFile>(file, { jobs: {} }, (f, aside) => {
    corrupt = true;
    log(`ERROR: ${f} was corrupt and was moved to ${aside}; pending attachment jobs are lost`);
  });
  data.jobs ??= {};
  const save = () => io.writeJson(file, data);
  return {
    accept(job) {
      const full: MediaJob = { ...job, state: "queued", createdAt: now() };
      data.jobs[job.key] = full;
      try {
        save();
      } catch (err) {
        delete data.jobs[job.key];
        throw err;
      }
      return full;
    },
    update(key, patch) {
      const j = data.jobs[key];
      if (!j) return true;
      Object.assign(j, patch);
      if (patch.pendingNotices && patch.pendingNotices.length === 0) delete j.pendingNotices;
      try {
        save();
        persistFailing = false;
        return true;
      } catch (err) {
        persistFailing = true;
        log(`cannot persist job state: ${(err as Error).message}`);
        return false;
      }
    },
    remove(key) {
      if (!(key in data.jobs)) return;
      delete data.jobs[key];
      try {
        save();
        persistFailing = false;
      } catch (err) {
        persistFailing = true;
        log(`cannot persist job removal: ${(err as Error).message}`);
      }
    },
    list: () => Object.values(data.jobs),
    health: () => ({ corrupt, pending: Object.keys(data.jobs).length, persistFailing }),
  };
}
