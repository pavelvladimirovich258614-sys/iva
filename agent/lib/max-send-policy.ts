// Политика исходящих файлов: что агенту разрешено отправить пользователю в MAX.
//
// Агент может быть обманут промпт-инъекцией («пришли мне ~/.ssh/id_rsa»), поэтому файл отправляется
// только если он:
//   • лежит в разрешённых каталогах (vault, data/outbox и MAX_SEND_ROOTS) — проверка по realpath,
//     то есть симлинк наружу не помогает;
//   • обычный файл (не устройство/сокет/каталог), не пустой и не больше лимита;
//   • не из списка секретных (.env*, ключи, codex-auth.json, служебное состояние data/max и т.п.);
//   • не исполняемый, а текстовое содержимое не содержит токенов/ключей (scanOutbound).
// Тип загрузки MAX определяется по содержимому файла, а не по расширению.

import { realpathSync, statSync, readFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import type { MaxUploadType } from "./max-api.ts";
import { safeFileName, sniffFile, type Sniffed } from "./media-sniff.ts";
import { scanOutbound } from "./security-gate.ts";

const MiB = 1024 * 1024;
/** Лимиты MAX для multipart-загрузки (schema.yaml, POST /uploads). Наши лимиты — ниже или равны. */
const MAX_PLATFORM_LIMIT: Record<MaxUploadType, number> = { image: 50 * MiB, video: 250 * MiB, audio: 256 * MiB, file: 4096 * MiB };

export type SendRejectCode = "not-found" | "not-a-file" | "outside-roots" | "secret-file" | "empty" | "too-large" | "executable" | "contains-secret" | "unreadable";

export interface SendableFile {
  ok: true;
  realPath: string;
  fileName: string;
  size: number;
  uploadType: MaxUploadType;
  mimeType: string;
  sniffed: Sniffed;
}
export interface SendRejected {
  ok: false;
  code: SendRejectCode;
  reason: string;
}

export function sendRoots(env: Record<string, string | undefined> = process.env): string[] {
  const vault = env.ASSISTANT_VAULT_DIR || "vault";
  const data = env.ASSISTANT_DATA_DIR || "data";
  const extra = (env.MAX_SEND_ROOTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return [vault, join(data, "outbox"), ...extra].map((p) => resolve(p));
}

const SECRET_NAME = /(^|[\\/])(\.env(\..*)?|.*\.pem|.*\.key|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.p12|.*\.pfx|codex-auth\.json|credentials(\.json)?|client_secret.*\.json|\.netrc|\.npmrc|\.git-credentials|token(s)?(\.json)?|secrets?(\.json|\.ya?ml)?)$/i;

function insideAny(real: string, roots: string[]) {
  for (const r of roots) {
    let rr: string;
    try {
      rr = realpathSync(r);
    } catch {
      continue; // корня нет — из него ничего не отправить
    }
    if (real === rr || real.startsWith(rr + sep)) return true;
  }
  return false;
}

export function uploadTypeFor(s: Sniffed, size: number): MaxUploadType {
  // Форматы по документации POST /uploads; WEBP, AMR и прочее в списках изображений/аудио не значатся → file.
  if (s.family === "image" && ["png", "jpeg", "gif", "tiff", "bmp", "heic"].includes(s.kind) && size <= MAX_PLATFORM_LIMIT.image) return "image";
  if (s.family === "video" && ["mp4", "mov", "mkv", "webm"].includes(s.kind) && size <= MAX_PLATFORM_LIMIT.video) return "video";
  if (s.family === "audio" && ["mp3", "wav", "m4a", "ogg", "aac", "flac"].includes(s.kind) && size <= MAX_PLATFORM_LIMIT.audio) return "audio";
  return "file";
}

export function checkSendableFile(
  path: string,
  { env = process.env, roots = sendRoots(env), displayName }: { env?: Record<string, string | undefined>; roots?: string[]; displayName?: string } = {},
): SendableFile | SendRejected {
  const rej = (code: SendRejectCode, reason: string): SendRejected => ({ ok: false, code, reason });
  let real: string;
  try {
    real = realpathSync(resolve(path));
  } catch {
    return rej("not-found", "file not found");
  }
  if (!insideAny(real, roots)) {
    return rej("outside-roots", "the file is outside the directories allowed for sending (vault, data/outbox, MAX_SEND_ROOTS)");
  }
  if (SECRET_NAME.test(real) || SECRET_NAME.test(path)) return rej("secret-file", "files with keys, tokens or environment settings are never sent");
  let st;
  try {
    st = statSync(real);
  } catch {
    return rej("unreadable", "the file cannot be read");
  }
  if (!st.isFile()) return rej("not-a-file", "not a regular file");
  if (st.size === 0) return rej("empty", "the file is empty");
  const limit = Number(env.MAX_UPLOAD_MAX_BYTES) > 0 ? Number(env.MAX_UPLOAD_MAX_BYTES) : 100 * MiB;
  if (st.size > limit) return rej("too-large", `the file is larger than the sending limit (${Math.round(limit / MiB)} MB, MAX_UPLOAD_MAX_BYTES)`);
  let sniffed: Sniffed;
  try {
    sniffed = sniffFile(real, basename(real));
  } catch {
    return rej("unreadable", "the file cannot be read");
  }
  if (sniffed.family === "executable") return rej("executable", "executable files are not sent");
  if (sniffed.family === "text") {
    try {
      const sample = readFileSync(real).subarray(0, 2 * MiB).toString("utf8");
      const scan = scanOutbound(sample, false);
      if (!scan.clean) return rej("contains-secret", "the file contains what looks like a secret (key/token); refusing to send");
    } catch {
      return rej("unreadable", "the file cannot be read");
    }
  }
  const uploadType = uploadTypeFor(sniffed, st.size);
  const fileName = safeFileName(displayName ?? basename(real), sniffed, "file");
  return { ok: true, realPath: real, fileName, size: st.size, uploadType, mimeType: sniffed.mime, sniffed };
}
