// Надёжная доставка ответов в MAX: durable-очередь (max-store.ts) + воркер на диалог.
//  - порядок сохраняется: пока голова очереди пользователя ждёт backoff, следующие не идут;
//  - не больше одного запроса в полёте на диалог и интервал между стартами ≥ minIntervalMs
//    (лимит MAX — 2 сообщения/с на диалог);
//  - ретраи 429/5xx/сеть с экспоненциальным backoff (учитывается Retry-After), потолок попыток;
//    4xx (кроме 429) — сразу dead; dead остаются в outbox.json как диагностика (без текста);
//  - очередь переживает рестарт: start() возобновляет доставку.
// Семантика: at-least-once. Если ответ на POST потерян (таймаут), повтор может дать дубль.

import { MaxApiError, splitMaxText, type MaxClient } from "./max-api.ts";
import type { MaxStore } from "./max-store.ts";

export interface MaxOutbox {
  /** Режет на куски, ставит в очередь (бросает при невозможности сохранить) и запускает доставку. */
  enqueue(userId: string, text: string): number;
  /** Запустить доставку всего, что уже можно слать (используется таймером и тестами). */
  poke(): void;
  start(): void;
  stop(): void;
  /** Дождаться, пока всё, что можно доставить сейчас, обработано (для тестов и shutdown). */
  idle(): Promise<void>;
}

export interface MaxOutboxOptions {
  store: MaxStore;
  client: MaxClient;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  minIntervalMs?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  tickMs?: number;
  log?: (msg: string) => void;
}

export function createMaxOutbox(o: MaxOutboxOptions): MaxOutbox {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const minInterval = o.minIntervalMs ?? 550;
  const maxAttempts = o.maxAttempts ?? 8;
  const base = o.backoffBaseMs ?? 2000;
  const backoffMax = o.backoffMaxMs ?? 5 * 60_000;
  const log = o.log ?? ((m: string) => console.error(`[max] ${m}`));
  const running = new Map<string, Promise<void>>();
  const lastStart = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | null = null;
  const wakeups = new Set<ReturnType<typeof setTimeout>>();

  async function drain(userId: string) {
    for (;;) {
      const head = o.store.queuedFor(userId)[0];
      if (!head) return;
      const wait = head.nextAt - now();
      if (wait > 0) {
        // Голова ждёт backoff: позже ничего не отправляем (порядок), будим себя по таймеру.
        const t = setTimeout(() => {
          wakeups.delete(t);
          kick(userId);
        }, wait);
        t.unref?.();
        wakeups.add(t);
        return;
      }
      const gap = (lastStart.get(userId) ?? -Infinity) + minInterval - now();
      if (gap > 0) await sleep(gap);
      lastStart.set(userId, now());
      try {
        await o.client.sendOnce({ chatId: head.chatId, userId: head.userId }, head.text);
        o.store.complete(head.id);
      } catch (err) {
        const e = err as MaxApiError;
        const retryable = e instanceof MaxApiError ? e.retryable : true;
        const status = e instanceof MaxApiError ? e.status : null;
        const name = e instanceof MaxApiError ? (e.code ?? e.name) : ((err as Error)?.name ?? "Error");
        const attempt = head.attempts + 1;
        const giveUp = !retryable || attempt >= maxAttempts;
        const delay = Math.max(
          Math.min(base * 2 ** (attempt - 1), backoffMax),
          e instanceof MaxApiError ? (e.retryAfterMs ?? 0) : 0,
        );
        o.store.fail(head.id, { status, name }, giveUp ? null : now() + delay);
        if (giveUp) {
          log(
            `DELIVERY FAILED permanently item=${head.id} attempts=${attempt} status=${status ?? "network"} reason=${name}` +
              ` (reply of ${head.textLength} chars was NOT delivered)`,
          );
        } else {
          log(`delivery attempt ${attempt} failed item=${head.id} status=${status ?? "network"} reason=${name}; retry in ${Math.round(delay / 1000)}s`);
        }
      }
    }
  }

  function kick(userId: string) {
    if (running.has(userId)) return;
    const p = drain(userId)
      .catch((err) => log(`outbox worker error: ${(err as Error).message}`))
      .finally(() => {
        running.delete(userId);
      });
    running.set(userId, p);
  }

  function kickDue() {
    for (const item of o.store.due(now())) kick(item.userId);
  }

  return {
    enqueue(userId, text) {
      const chunks = splitMaxText(text);
      if (chunks.length === 0) return 0;
      o.store.enqueue(userId, chunks);
      kick(userId);
      return chunks.length;
    },
    poke: kickDue,
    start() {
      if (timer) return;
      timer = setInterval(kickDue, o.tickMs ?? 3000);
      timer.unref?.();
      kickDue(); // дослать то, что осталось от прошлого процесса
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      for (const t of wakeups) clearTimeout(t);
      wakeups.clear();
    },
    async idle() {
      while (running.size > 0) await Promise.all([...running.values()]);
    },
  };
}
