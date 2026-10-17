// Durable-очередь обработки входящих вложений (data/max/media-jobs.json, 0600).
//
// Зачем: скачивание, распознавание речи и анализ изображений занимают секунды, а вебхук MAX нужно
// подтвердить быстро. Порядок такой: событие проверено (секрет → allowlist → дедуп) → задание ЗАПИСАНО
// на диск → подтверждение 200 → обработка в фоне → send() в Eve.
//
// Гарантии (честно): at-least-once до записи задания, дальше — «обработать один раз или явно сообщить».
// Если процесс упал посреди обработки, при следующем старте задание НЕ выполняется молча заново (URL
// вложения мог устареть, а часть действий уже сделана): пользователь получает сообщение, что
// обработка прервана, и просит прислать файл ещё раз. Тихой потери нет.

import { join } from "node:path";
import type { MaxInboundAttachment, MaxLinkedContent } from "./max-updates.ts";
import { readJsonFile, writeJsonAtomic } from "./max-store.ts";

export interface MediaJob {
  key: string;
  userId: string;
  chatId: string | null;
  text: string;
  mid: string | null;
  attachments: MaxInboundAttachment[];
  linked: MaxLinkedContent | null;
  createdAt: number;
  state: "queued" | "processing";
}

interface JobsFile {
  jobs: Record<string, MediaJob>;
}

export interface MediaJobs {
  /** Записывает задание на диск; бросает, если записать нельзя (тогда подтверждать событие нельзя). */
  accept(job: Omit<MediaJob, "state" | "createdAt">): MediaJob;
  setProcessing(key: string): void;
  remove(key: string): void;
  list(): MediaJob[];
  health(): { corrupt: boolean; pending: number };
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
    setProcessing(key) {
      const j = data.jobs[key];
      if (!j || j.state === "processing") return;
      j.state = "processing";
      try {
        save();
      } catch (err) {
        log(`cannot persist job state: ${(err as Error).message}`);
      }
    },
    remove(key) {
      if (!(key in data.jobs)) return;
      delete data.jobs[key];
      try {
        save();
      } catch (err) {
        log(`cannot persist job removal: ${(err as Error).message}`);
      }
    },
    list: () => Object.values(data.jobs),
    health: () => ({ corrupt, pending: Object.keys(data.jobs).length }),
  };
}
