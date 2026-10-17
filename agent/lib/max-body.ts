// Ограниченное по байтам и времени чтение тела webhook. Лимит проверяется по мере поступления
// чанков (а не после полного чтения), поэтому ни фальшивый/отсутствующий Content-Length, ни
// chunked-поток без конца не заставят процесс буферизовать больше maxBytes.

export type BodyReadResult =
  | { ok: true; text: string }
  | { ok: false; status: 400 | 408 | 413; reason: "too-large" | "timeout" | "invalid-length" | "read-error" };

export async function readBodyLimited(
  request: Request,
  { maxBytes, timeoutMs }: { maxBytes: number; timeoutMs: number },
): Promise<BodyReadResult> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared.trim())) return { ok: false, status: 400, reason: "invalid-length" };
    if (Number(declared) > maxBytes) {
      await request.body?.cancel().catch(() => {});
      return { ok: false, status: 413, reason: "too-large" };
    }
  }
  if (!request.body) return { ok: true, text: "" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    reader.cancel().catch(() => {});
  }, timeoutMs);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (timedOut) return { ok: false, status: 408, reason: "timeout" };
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, status: 413, reason: "too-large" };
      }
      chunks.push(value);
    }
  } catch {
    return timedOut
      ? { ok: false, status: 408, reason: "timeout" }
      : { ok: false, status: 400, reason: "read-error" };
  } finally {
    clearTimeout(timer);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return { ok: true, text: new TextDecoder("utf-8").decode(buf) };
}
