// Устойчивое к рестарту состояние канала MAX под data/ (untracked, 0600):
//   state.json  — принятые события (дедуп) и последний известный chat_id диалога пользователя;
//   outbox.json — ответы, ожидающие доставки (очередь с retry/backoff и диагностикой).
// Запись атомарная (tmp + rename). Процесс — единственный владелец файлов; параллельный запуск
// двух экземпляров на одном data/ не поддерживается. Внутри процесса все операции синхронные,
// поэтому гонок между async-обработчиками нет.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const ACCEPTED_TTL_MS = 7 * 24 * 60 * 60_000;
export const ACCEPTED_MAX = 20_000;
export const DEAD_KEEP = 100;

export type InboxClaim = "new" | "in_flight" | "done";

export interface OutboxItem {
  id: string;
  userId: string;
  /** Последний известный chat_id на момент постановки; null → адресуем по user_id. */
  chatId: string | null;
  seq: number;
  /** Текст куска. У dead-записей очищается (диагностика без пользовательского контента). */
  text: string;
  textLength: number;
  state: "queued" | "dead";
  attempts: number;
  createdAt: number;
  nextAt: number;
  lastError?: { at: number; status: number | null; name: string };
}

interface StateFile {
  accepted: Record<string, number>;
  dialogs: Record<string, string>;
}
interface OutboxFile {
  seq: number;
  items: OutboxItem[];
}

export interface MaxStore {
  claim(key: string): InboxClaim;
  commit(key: string): void;
  abort(key: string): void;
  rememberDialog(userId: string, chatId: string | null): void;
  dialogChatId(userId: string): string | null;
  enqueue(userId: string, chunks: string[]): OutboxItem[];
  due(now?: number): OutboxItem[];
  /** Все queued-элементы пользователя по порядку постановки. */
  queuedFor(userId: string): OutboxItem[];
  complete(id: string): void;
  fail(id: string, error: { status: number | null; name: string }, nextAt: number | null): OutboxItem | null;
  stats(): { accepted: number; queued: number; dead: number; oldestQueuedAt: number | null; deadItems: OutboxItem[] };
}

function readJson<T>(file: string, fallback: T, log: (m: string) => void): T {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Битый файл не затираем молча: откладываем в сторону и стартуем с пустого.
    const aside = `${file}.corrupt-${Date.now()}`;
    try {
      renameSync(file, aside);
    } catch {
      /* best-effort */
    }
    log(`state file was corrupt, moved to ${aside}`);
    return fallback;
  }
}

function writeJsonAtomic(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, file);
}

export function maxDataDir(env: Record<string, string | undefined> = process.env): string {
  const raw = env.ASSISTANT_DATA_DIR ?? "data";
  return join(raw.startsWith("/") ? raw : join(process.cwd(), raw), "max");
}

export function createMaxStore({
  dir,
  now = Date.now,
  log = (m: string) => console.error(`[max] ${m}`),
}: {
  dir: string;
  now?: () => number;
  log?: (m: string) => void;
}): MaxStore {
  const stateFile = join(dir, "state.json");
  const outboxFile = join(dir, "outbox.json");
  const state = readJson<StateFile>(stateFile, { accepted: {}, dialogs: {} }, log);
  state.accepted ??= {};
  state.dialogs ??= {};
  const outbox = readJson<OutboxFile>(outboxFile, { seq: 0, items: [] }, log);
  outbox.items ??= [];
  // pending живёт только в памяти: после рестарта обработчиков в полёте нет.
  const pending = new Set<string>();

  const saveState = () => {
    try {
      writeJsonAtomic(stateFile, state);
    } catch (err) {
      log(`cannot persist state.json: ${(err as Error).message}`);
    }
  };
  const saveOutbox = () => writeJsonAtomic(outboxFile, outbox); // сбой записи outbox наружу: ответ нельзя считать принятым

  function pruneAccepted() {
    const t = now();
    const keys = Object.keys(state.accepted);
    for (const k of keys) if (t - state.accepted[k]! > ACCEPTED_TTL_MS) delete state.accepted[k];
    const left = Object.entries(state.accepted);
    if (left.length > ACCEPTED_MAX) {
      left.sort((a, b) => a[1] - b[1]);
      for (const [k] of left.slice(0, left.length - ACCEPTED_MAX)) delete state.accepted[k];
    }
  }

  function trimDead() {
    const dead = outbox.items.filter((i) => i.state === "dead");
    if (dead.length > DEAD_KEEP) {
      const drop = new Set(dead.slice(0, dead.length - DEAD_KEEP).map((i) => i.id));
      outbox.items = outbox.items.filter((i) => !drop.has(i.id));
    }
  }

  return {
    claim(key) {
      if (key in state.accepted) return "done";
      if (pending.has(key)) return "in_flight";
      pending.add(key);
      return "new";
    },
    commit(key) {
      pending.delete(key);
      state.accepted[key] = now();
      pruneAccepted();
      saveState();
    },
    abort(key) {
      pending.delete(key);
    },
    rememberDialog(userId, chatId) {
      if (!chatId || state.dialogs[userId] === chatId) return;
      state.dialogs[userId] = chatId;
      saveState();
    },
    dialogChatId: (userId) => state.dialogs[userId] ?? null,
    enqueue(userId, chunks) {
      const chatId = state.dialogs[userId] ?? null;
      const t = now();
      const items = chunks.map<OutboxItem>((text) => ({
        id: `${t.toString(36)}-${++outbox.seq}`,
        userId,
        chatId,
        seq: outbox.seq,
        text,
        textLength: text.length,
        state: "queued",
        attempts: 0,
        createdAt: t,
        nextAt: t,
      }));
      outbox.items.push(...items);
      try {
        saveOutbox();
      } catch (err) {
        outbox.items.splice(outbox.items.length - items.length, items.length);
        throw err;
      }
      return items;
    },
    due(at = now()) {
      return outbox.items.filter((i) => i.state === "queued" && i.nextAt <= at);
    },
    queuedFor: (userId) => outbox.items.filter((i) => i.state === "queued" && i.userId === userId),
    complete(id) {
      outbox.items = outbox.items.filter((i) => i.id !== id);
      saveOutbox();
    },
    fail(id, error, nextAt) {
      const item = outbox.items.find((i) => i.id === id);
      if (!item) return null;
      item.attempts += 1;
      item.lastError = { at: now(), ...error };
      if (nextAt === null) {
        item.state = "dead";
        item.text = "";
      } else {
        item.nextAt = nextAt;
      }
      trimDead();
      saveOutbox();
      return item;
    },
    stats() {
      const queued = outbox.items.filter((i) => i.state === "queued");
      const deadItems = outbox.items.filter((i) => i.state === "dead");
      return {
        accepted: Object.keys(state.accepted).length,
        queued: queued.length,
        dead: deadItems.length,
        oldestQueuedAt: queued.length ? Math.min(...queued.map((i) => i.createdAt)) : null,
        deadItems,
      };
    },
  };
}
