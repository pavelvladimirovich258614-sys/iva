import { defineTool } from "eve/tools";
import { z } from "zod";

// Отправка файла пользователю в MAX как настоящего вложения (документ, изображение, аудио, видео).
// Тип загрузки (image/video/audio/file) определяется автоматически по содержимому файла.
//
// Самодостаточный инструмент: файл не читается здесь. Запрос уходит в канал MAX того же процесса
// (loopback, тот же секрет, что у webhook): канал проверяет получателя по allowlist и сам файл
// (разрешённые каталоги, секреты, размер), ставит его в durable-очередь, загружает через MAX Upload API
// и отправляет. Ответ «queued» означает «принято к доставке», а не «уже доставлено»: при окончательной
// неудаче пользователь получит отдельное сообщение об ошибке.
//
// Куда складывать создаваемые файлы: <vault>/attachments/… или data/outbox/ (другие каталоги не разрешены).

export default defineTool({
  description:
    "Отправить файл пользователю в MAX как вложение (PDF, Excel, Word, изображение, аудио, видео, текст). " +
    "Используй, когда пользователь просит ПРИСЛАТЬ готовый файл («сделай отчёт и пришли»). Сначала создай файл " +
    "в каталоге vault/attachments/ или data/outbox/ (другие пути не разрешены), затем вызови этот инструмент с " +
    "абсолютным или относительным путём. Секретные файлы (.env, ключи, токены) не отправляются. " +
    "Возвращает { ok, queued }: queued=true значит принято к доставке, а не доставлено. " +
    "Если ok=false — объясни пользователю причину из поля error, ничего не выдумывай.",
  inputSchema: z.object({
    path: z.string().min(1).describe("Путь к существующему файлу в vault/ или data/outbox/"),
    caption: z.string().max(1000).optional().describe("Подпись к файлу (необязательно)"),
    name: z.string().max(120).optional().describe("Имя файла для пользователя (по умолчанию — имя на диске)"),
  }),
  async execute({ path, caption, name }, ctx) {
    const secret = process.env.MAX_WEBHOOK_SECRET?.trim();
    if (!secret || !process.env.MAX_BOT_TOKEN?.trim()) {
      return { ok: false, error: "MAX is not configured on this installation (MAX_BOT_TOKEN / MAX_WEBHOOK_SECRET)" };
    }
    const principal = String((ctx as { session?: { auth?: { principalId?: string } | null } })?.session?.auth?.principalId ?? "");
    // Адресат — тот, кто ведёт этот диалог в MAX; для фоновых сессий (расписание) канал подставит единственного владельца.
    const userId = principal.startsWith("max:") ? principal.slice(4) : "";
    const port = process.env.IVA_PORT ?? process.env.PORT ?? "8723";
    const host = (process.env.ASSISTANT_HOST ?? `http://127.0.0.1:${port}`).replace(/\/$/, "");
    let res: Response;
    try {
      res = await fetch(`${host}/eve/v1/max/send-file`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-max-bot-api-secret": secret },
        body: JSON.stringify({ userId, path, caption, name }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      return { ok: false, error: `the MAX channel is unreachable (${(err as Error).name})` };
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || !body?.ok) {
      return { ok: false, error: String(body?.error ?? `HTTP ${res.status}`), code: body?.code };
    }
    return { ok: true, queued: true, fileName: body.fileName, type: body.uploadType, bytes: body.size, note: "accepted for delivery; the user will be told if delivery finally fails" };
  },
});
