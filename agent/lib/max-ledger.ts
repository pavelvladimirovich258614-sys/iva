// Журнал выполнения управляющих команд моста (data/max/control.json): защита от повторного запуска
// опасных действий (/restart, /update, перезапуск после смены модели…) при повторной доставке
// события — как polling-маркера, так и webhook-ретрая MAX.
//
//   begin(key, {idempotent})  решает, что делать с событием:
//     run      — выполнять (для не-идемпотентных запись «started» СНАЧАЛА надёжно сохраняется;
//                если сохранить нельзя — begin бросает, команда НЕ выполняется);
//     skip     — уже выполнено или завершилось ошибкой (повтор не исполняется заново);
//     unknown  — прошлая попытка не-идемпотентной команды оборвалась (процесс упал посреди):
//                исход неизвестен, повторять вслепую нельзя — пользователь решает сам;
//     busy     — это же событие сейчас выполняется в этом процессе.
//   finish/fail  фиксируют итог. Сбой их записи не опасен: «started» уже на диске, значит повтор
//                даст `unknown`, а не второй запуск.
import { readJsonFile, writeJsonAtomic } from "./max-store.ts";
import { join } from "node:path";

export const LEDGER_TTL_MS = 7 * 24 * 60 * 60_000;
export const LEDGER_MAX = 5000;

export type LedgerEntry = { state: "started" | "done" | "failed"; at: number; notified?: boolean; note?: string };
export type LedgerDecision =
  | { kind: "run" }
  | { kind: "skip"; state: "done" | "failed"; notified: boolean }
  | { kind: "unknown" }
  | { kind: "busy" };

export interface Ledger {
  begin(key: string, opts: { idempotent: boolean }): LedgerDecision;
  finish(key: string): void;
  fail(key: string, notified: boolean): void;
  markNotified(key: string): void;
  /** Исход неизвестной команды сообщён пользователю — закрываем запись, чтобы цикл не повторялся. */
  resolveUnknown(key: string): void;
  /** Освободить ключ без записи итога (идемпотентная команда будет безопасно выполнена заново). */
  release(key: string): void;
  health(): { persistFailing: boolean; corrupt: string[] };
}

export function createLedger({
  dir,
  now = Date.now,
  log = (m: string) => console.error(`[max-control] ${m}`),
  io = { writeJson: writeJsonAtomic },
}: {
  dir: string;
  now?: () => number;
  log?: (m: string) => void;
  io?: { writeJson(file: string, value: unknown): void };
}): Ledger {
  const file = join(dir, "control.json");
  const corrupt: string[] = [];
  const data = readJsonFile<{ entries: Record<string, LedgerEntry> }>(file, { entries: {} }, (f, aside) => {
    corrupt.push(f);
    log(`ERROR: ${f} was corrupt and moved to ${aside}; command history is lost`);
  });
  data.entries ??= {};
  const inFlight = new Set<string>();
  let dirty = false;

  const prune = () => {
    const t = now();
    for (const [k, e] of Object.entries(data.entries)) if (t - e.at > LEDGER_TTL_MS) delete data.entries[k];
    const left = Object.entries(data.entries);
    if (left.length > LEDGER_MAX) {
      left.sort((a, b) => a[1].at - b[1].at);
      for (const [k] of left.slice(0, left.length - LEDGER_MAX)) delete data.entries[k];
    }
  };
  const flush = () => {
    io.writeJson(file, data);
    dirty = false;
  };
  const flushQuietly = () => {
    try {
      flush();
    } catch (err) {
      dirty = true;
      log(`cannot persist control.json: ${(err as Error).message}`);
    }
  };

  return {
    begin(key, { idempotent }) {
      const e = data.entries[key];
      if (e?.state === "done") return { kind: "skip", state: "done", notified: true };
      if (e?.state === "failed") return { kind: "skip", state: "failed", notified: e.notified === true };
      if (inFlight.has(key)) return { kind: "busy" };
      if (e?.state === "started" && !idempotent) return { kind: "unknown" };
      if (!idempotent) {
        data.entries[key] = { state: "started", at: now() };
        prune();
        try {
          flush(); // намерение должно быть на диске ДО выполнения
        } catch (err) {
          delete data.entries[key];
          throw err;
        }
      }
      inFlight.add(key);
      return { kind: "run" };
    },
    finish(key) {
      inFlight.delete(key);
      if (!data.entries[key]) return; // идемпотентная команда: записи нет и не нужно
      data.entries[key] = { state: "done", at: now() };
      flushQuietly();
    },
    fail(key, notified) {
      inFlight.delete(key);
      data.entries[key] = { state: "failed", at: now(), notified };
      flushQuietly();
    },
    markNotified(key) {
      const e = data.entries[key];
      if (e) data.entries[key] = { ...e, notified: true };
      flushQuietly();
    },
    resolveUnknown(key) {
      data.entries[key] = { state: "done", at: now(), note: "outcome-unknown" };
      flushQuietly();
    },
    release(key) {
      inFlight.delete(key);
      if (data.entries[key]?.state === "started") delete data.entries[key];
    },
    health: () => ({ persistFailing: dirty, corrupt: [...corrupt] }),
  };
}
