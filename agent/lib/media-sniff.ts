// Определение РЕАЛЬНОГО типа файла по содержимому (magic bytes), а не по имени/расширению/Content-Type.
// Расширение, присланное отправителем, — лишь подсказка для текстовых форматов (csv/md/json/…).
// Здесь же — безопасное имя файла для сохранения в vault.

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { extname } from "node:path";
import { ZipError, openZip } from "./zip-lite.ts";

export type MediaFamily = "image" | "audio" | "video" | "document" | "text" | "archive" | "executable" | "unknown";

export interface Sniffed {
  kind: string; // png | jpeg | gif | webp | bmp | tiff | heic | pdf | docx | xlsx | pptx | ole | ogg | mp3 | wav | m4a | aac | flac | amr | webm | mp4 | mov | mkv | text | zip | executable | empty | unknown
  family: MediaFamily;
  mime: string;
  ext: string;
  /** Для text: csv | md | json | txt | html | xml | … (по расширению, содержимое — валидный текст). */
  textKind?: string;
  /** Пояснение для ошибок и диагностики. */
  note?: string;
  /** Контейнер заявляет формат, но не читается (обрезанный/повреждённый архив). */
  damaged?: boolean;
}

const HEAD_BYTES = 64 * 1024;

function readHead(path: string): Buffer {
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const buf = Buffer.alloc(Math.min(size, HEAD_BYTES));
    let done = 0;
    while (done < buf.length) {
      const n = readSync(fd, buf, done, buf.length - done, done);
      if (n === 0) break;
      done += n;
    }
    return buf.subarray(0, done);
  } finally {
    closeSync(fd);
  }
}

const startsWith = (b: Buffer, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);
const ascii = (b: Buffer, from: number, to: number) => b.subarray(from, to).toString("latin1");

const TEXT_EXT = new Set(["txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "yaml", "yml", "xml", "html", "htm", "log", "ini", "toml", "rtf", "srt", "vtt", "tex", "sql", "py", "js", "ts", "sh"]);

function looksLikeText(b: Buffer): boolean {
  if (b.length === 0) return false;
  // UTF-16 BOM
  if ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) return true;
  let ctrl = 0;
  for (let i = 0; i < b.length; i++) {
    const c = b[i]!;
    if (c === 0) return false;
    if (c < 9 || (c > 13 && c < 32)) ctrl++;
  }
  if (ctrl / b.length > 0.02) return false;
  // Допускаем «обрезанное» окончание многобайтного символа, поэтому ослабляем проверку на хвосте.
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(0, b.length > 4 ? b.length - 3 : b.length));
    return true;
  } catch {
    // Не UTF-8: возможен windows-1251 (частый для csv из Excel в РФ) — принимаем, если нет управляющих.
    return ctrl === 0;
  }
}

export function sniffBuffer(head: Buffer, fileName?: string): Sniffed {
  const hint = (extname(fileName ?? "").slice(1) || "").toLowerCase();
  const mk = (kind: string, family: MediaFamily, mime: string, ext: string, extra: Partial<Sniffed> = {}): Sniffed => ({ kind, family, mime, ext, ...extra });
  if (head.length === 0) return mk("empty", "unknown", "application/octet-stream", "bin", { note: "the file is empty" });

  // Изображения
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return mk("png", "image", "image/png", "png");
  if (startsWith(head, [0xff, 0xd8, 0xff])) return mk("jpeg", "image", "image/jpeg", "jpg");
  if (ascii(head, 0, 4) === "GIF8") return mk("gif", "image", "image/gif", "gif");
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP") return mk("webp", "image", "image/webp", "webp");
  if (ascii(head, 0, 2) === "BM" && head.length > 14 && head.readUInt32LE(10) < head.length + 1e9) return mk("bmp", "image", "image/bmp", "bmp");
  if (startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a])) return mk("tiff", "image", "image/tiff", "tiff");

  // ISO BMFF (ftyp): heic / m4a / mp4 / mov
  if (ascii(head, 4, 8) === "ftyp") {
    const brand = ascii(head, 8, 12);
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return mk("heic", "image", "image/heic", "heic");
    if (/^(M4A |M4B |M4P )$/.test(brand)) return mk("m4a", "audio", "audio/mp4", "m4a");
    if (brand === "qt  ") return mk("mov", "video", "video/quicktime", "mov");
    return mk("mp4", "video", "video/mp4", "mp4");
  }

  // Документы
  if (ascii(head, 0, Math.min(head.length, 1024)).includes("%PDF-")) return mk("pdf", "document", "application/pdf", "pdf");
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return mk("ole", "document", "application/x-ole-storage", hint === "xls" || hint === "doc" || hint === "ppt" ? hint : "doc", {
      note: "legacy Office binary format (doc/xls/ppt)",
    });
  }
  if (ascii(head, 0, 5) === "{\\rtf") return mk("rtf", "document", "application/rtf", "rtf");

  // Аудио/видео
  if (ascii(head, 0, 4) === "OggS") return mk("ogg", "audio", "audio/ogg", "ogg");
  if (ascii(head, 0, 3) === "ID3" || (head[0] === 0xff && (head[1]! & 0xe6) === 0xe2 && (head[1]! & 0x18) !== 0x08)) return mk("mp3", "audio", "audio/mpeg", "mp3");
  if (head[0] === 0xff && (head[1] === 0xf1 || head[1] === 0xf9)) return mk("aac", "audio", "audio/aac", "aac");
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WAVE") return mk("wav", "audio", "audio/wav", "wav");
  if (ascii(head, 0, 4) === "fLaC") return mk("flac", "audio", "audio/flac", "flac");
  if (ascii(head, 0, 6) === "#!AMR\n" || ascii(head, 0, 9) === "#!AMR-WB\n") return mk("amr", "audio", "audio/amr", "amr");
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) {
    const doc = ascii(head, 0, Math.min(head.length, 64));
    return doc.includes("webm") ? mk("webm", "video", "video/webm", "webm") : mk("mkv", "video", "video/x-matroska", "mkv");
  }

  // Исполняемые — не принимаем
  if (ascii(head, 0, 2) === "MZ" || startsWith(head, [0x7f, 0x45, 0x4c, 0x46]) || startsWith(head, [0xcf, 0xfa, 0xed, 0xfe]) || ascii(head, 0, 2) === "#!") {
    return mk("executable", "executable", "application/octet-stream", "bin", { note: "executable files are not accepted" });
  }

  if (ascii(head, 0, 2) === "PK" && (head[2] === 3 || head[2] === 5) ) {
    // Подробности (docx/xlsx/…) определяет sniffFile — для буфера без файла отдаём zip.
    return mk("zip", "archive", "application/zip", "zip");
  }

  if (looksLikeText(head)) {
    const textKind = TEXT_EXT.has(hint) ? hint : "txt";
    return mk("text", "text", textKind === "csv" ? "text/csv" : textKind === "md" || textKind === "markdown" ? "text/markdown" : "text/plain", textKind === "markdown" ? "md" : textKind, { textKind });
  }
  return mk("unknown", "unknown", "application/octet-stream", "bin", { note: "unrecognised binary content" });
}

/** Определяет тип файла на диске; для ZIP различает docx/xlsx/pptx по структуре OOXML. */
export function sniffFile(path: string, fileName?: string): Sniffed {
  const head = readHead(path);
  const s = sniffBuffer(head, fileName ?? path);
  if (s.kind !== "zip") return s;
  try {
    const zip = openZip(path);
    try {
      if (zip.has("[Content_Types].xml")) {
        if (zip.has("word/document.xml")) return { kind: "docx", family: "document", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx" };
        if (zip.has("xl/workbook.xml")) return { kind: "xlsx", family: "document", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx" };
        if (zip.has("ppt/presentation.xml")) return { kind: "pptx", family: "document", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: "pptx" };
      }
    } finally {
      zip.close();
    }
    return { ...s, note: "ZIP archive (archives are not unpacked automatically)" };
  } catch (err) {
    if (err instanceof ZipError) {
      return { ...s, kind: "zip", family: "archive", damaged: err.code === "not-zip" || err.code === "corrupt", note: `ZIP archive rejected: ${err.message}` };
    }
    throw err;
  }
}

/** Безопасное имя для сохранения: без путей, управляющих символов, с расширением по реальному типу. */
export function safeFileName(original: string | undefined, sniffed: Pick<Sniffed, "ext" | "kind">, fallbackBase: string): string {
  let base = (original ?? "").normalize("NFC");
  base = base.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  let stem = dot > 0 ? base.slice(0, dot) : base;
  let ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  stem = stem.replace(/[^\p{L}\p{N}._ -]+/gu, "_").replace(/\s+/g, " ").replace(/^[._ -]+|[._ -]+$/g, "").slice(0, 80);
  ext = ext.replace(/[^a-z0-9]/g, "").slice(0, 8);
  // Текстовые форматы наследуют расширение от имени; бинарные — только реальное.
  const realExt = sniffed.kind === "text" ? (ext && TEXT_EXT.has(ext) ? ext : sniffed.ext) : sniffed.ext;
  if (!stem) stem = fallbackBase;
  return `${stem}.${realExt}`;
}
