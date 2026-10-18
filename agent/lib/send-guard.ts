// Однократный вызов send() в Eve с честной обработкой тайм-аута.
//
// Promise.race() не отменяет исходный вызов: после тайм-аута send() может ещё завершиться успехом (workflow уже
// запущен). Поэтому тайм-аут — это НЕИЗВЕСТНЫЙ исход, а не отказ: вызывающий не должен повторять send() вслепую
// (иначе получится второй ход агента, вторая задача, второе напоминание). Исходная операция остаётся под наблюдением:
// `settled` разрешится её настоящим итогом, когда он появится.

export type SendOutcome =
  | { kind: "ok" }
  | { kind: "rejected"; error: Error }
  /** Не дождались ответа. Операция могла начаться и ещё идёт: повторять нельзя, итог придёт в `settled`. */
  | { kind: "timeout"; settled: Promise<{ ok: true } | { ok: false; error: Error }> };

export async function startSendOnce(fn: () => Promise<unknown>, timeoutMs: number): Promise<SendOutcome> {
  const original: Promise<{ ok: true } | { ok: false; error: Error }> = Promise.resolve()
    .then(fn)
    .then(
      () => ({ ok: true as const }),
      (e) => ({ ok: false as const, error: e instanceof Error ? e : new Error(String(e)) }),
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const first = await Promise.race([original, timeout]);
  clearTimeout(timer);
  if (first === "timeout") return { kind: "timeout", settled: original };
  return first.ok ? { kind: "ok" } : { kind: "rejected", error: first.error };
}
