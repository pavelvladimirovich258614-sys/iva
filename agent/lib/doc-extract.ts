// Извлечение текста из присланных документов БЕЗ внешних зависимостей и без исполнения содержимого.
//   txt/csv/md/json… — декодирование (UTF-8, при невалидности windows-1251);
//   docx — абзацы и таблицы (word/document.xml);
//   xlsx — листы, значения и формулы ячеек (sharedStrings + sheetN.xml), структура сохраняется;
//   pptx — текст слайдов;
//   pdf  — системный `pdftotext` (poppler), если установлен. Пустой результат НЕ выдаётся за успех:
//          problem="no-text-layer" (скан) → вызывающий отправляет страницы в vision-модель.
// Результат ограничен maxChars (полный файл остаётся на диске — агент дочитывает его инструментами).
// Ошибки (битый файл, зашифрованный, архив-бомба) возвращаются как problem, а не как пустой текст.

import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { promisify } from "node:util";
import type { Sniffed } from "./media-sniff.ts";
import { ZipError, openZip } from "./zip-lite.ts";

const execFileAsync = promisify(execFile);

export type ExtractProblem = "empty" | "no-text-layer" | "encrypted" | "corrupt" | "unsupported" | "too-large" | "tool-missing";

export interface Extraction {
  kind: string;
  text: string;
  chars: number; // полная длина извлечённого текста (до усечения)
  truncated: boolean;
  problem?: ExtractProblem;
  note?: string;
  /** Структура: листы xlsx / число страниц pdf / слайдов pptx. */
  structure?: { sheets?: Array<{ name: string; rows: number; cols: number }>; pages?: number; slides?: number; lines?: number };
}

const XML_ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decodeXml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1]!.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return XML_ENT[e.toLowerCase()] ?? m;
  });

function finish(kind: string, text: string, maxChars: number, extra: Partial<Extraction> = {}): Extraction {
  const clean = text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
  const truncated = clean.length > maxChars;
  return { kind, text: truncated ? clean.slice(0, maxChars) : clean, chars: clean.length, truncated, ...extra };
}

function decodeText(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder("utf-16be").decode(buf.subarray(2));
  const body = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return new TextDecoder("windows-1251").decode(body);
  }
}

function colIndex(ref: string): number {
  const m = /^([A-Z]+)/.exec(ref);
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]!) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function extractDocx(path: string, maxChars: number): Extraction {
  const zip = openZip(path);
  try {
    const xml = zip.read("word/document.xml").toString("utf8");
    const out: string[] = [];
    // Таблицы: строки → ячейки через " | ", остальное — абзацы. Идём по верхнеуровневым <w:p>/<w:tbl>.
    const tokenRe = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g;
    const paraText = (p: string) => {
      let s = "";
      for (const m of p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>|<w:cr\/>/g)) {
        s += m[1] !== undefined ? m[1] : m[0] === "<w:tab/>" ? "\t" : "\n";
      }
      return decodeXml(s);
    };
    let tables = 0;
    for (const m of xml.matchAll(tokenRe)) {
      const chunk = m[0];
      if (chunk.startsWith("<w:tbl>")) {
        tables++;
        const rows = [...chunk.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map((r) =>
          [...r[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)]
            .map((c) =>
              [...c[0].matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)]
                .map((p) => paraText(p[0]).trim())
                .filter(Boolean)
                .join(" / "),
            )
            .join(" | "),
        );
        out.push(rows.join("\n"));
      } else {
        out.push(paraText(chunk));
      }
    }
    const text = out.join("\n");
    const r = finish("docx", text, maxChars, { note: tables ? `${tables} table(s); cells are separated by " | "` : undefined });
    if (!r.text) return { ...r, problem: "empty", note: "the DOCX contains no text (images only?)" };
    return r;
  } finally {
    zip.close();
  }
}

function extractXlsx(path: string, maxChars: number, maxRowsPerSheet: number): Extraction {
  const zip = openZip(path);
  try {
    const wb = zip.read("xl/workbook.xml").toString("utf8");
    const rels = zip.has("xl/_rels/workbook.xml.rels") ? zip.read("xl/_rels/workbook.xml.rels").toString("utf8") : "";
    const relTarget = new Map<string, string>();
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      const id = /\bId="([^"]+)"/.exec(m[0])?.[1];
      const target = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
      if (id && target) relTarget.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
    }
    const shared: string[] = [];
    if (zip.has("xl/sharedStrings.xml")) {
      const ss = zip.read("xl/sharedStrings.xml").toString("utf8");
      for (const si of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
        shared.push(decodeXml([...si[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")));
      }
    }
    const sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m, i) => ({
      name: decodeXml(/\bname="([^"]*)"/.exec(m[0])?.[1] ?? `Sheet${i + 1}`),
      rid: /\br:id="([^"]+)"/.exec(m[0])?.[1] ?? "",
    }));
    if (sheets.length === 0) return finish("xlsx", "", maxChars, { problem: "empty", note: "the workbook has no sheets" });
    const blocks: string[] = [];
    const structure: NonNullable<Extraction["structure"]>["sheets"] = [];
    for (const [i, sh] of sheets.entries()) {
      const target = relTarget.get(sh.rid) ?? `xl/worksheets/sheet${i + 1}.xml`;
      if (!zip.has(target)) continue;
      const xml = zip.read(target).toString("utf8");
      const rows: string[] = [];
      let totalRows = 0;
      let maxCol = 0;
      for (const r of xml.matchAll(/<row\b[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g)) {
        totalRows++;
        const rowNum = /\br="(\d+)"/.exec(r[0])?.[1] ?? String(totalRows);
        const cells: string[] = [];
        for (const c of r[0].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const attrs = c[1]!;
          const inner = c[2] ?? "";
          const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? "";
          const t = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? "n";
          const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
          const f = /<f[^>]*>([\s\S]*?)<\/f>/.exec(inner)?.[1];
          let value = "";
          if (t === "s" && v !== undefined) value = shared[Number(v)] ?? "";
          else if (t === "inlineStr") value = decodeXml([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(""));
          else if (t === "b" && v !== undefined) value = v === "1" ? "TRUE" : "FALSE";
          else if (v !== undefined) value = decodeXml(v);
          if (value === "" && f === undefined) continue;
          const col = ref ? colIndex(ref) : cells.length;
          if (col + 1 > maxCol) maxCol = col + 1;
          cells.push(`${ref || `#${cells.length + 1}`}=${value}${f !== undefined ? ` [formula: =${decodeXml(f)}]` : ""}`);
        }
        if (cells.length && rows.length < maxRowsPerSheet) rows.push(`row ${rowNum}: ${cells.join(" | ")}`);
      }
      structure.push({ name: sh.name, rows: totalRows, cols: maxCol });
      const more = totalRows > rows.length ? `\n… ${totalRows - rows.length} more row(s) not shown (open the saved file for all rows)` : "";
      blocks.push(`### Sheet "${sh.name}" (${totalRows} rows × ${maxCol} cols)\n${rows.join("\n") || "(no cell values)"}${more}`);
    }
    const r = finish("xlsx", blocks.join("\n\n"), maxChars, { structure: { sheets: structure } });
    if (structure.every((s) => s.rows === 0)) return { ...r, problem: "empty", note: "all sheets are empty" };
    return r;
  } finally {
    zip.close();
  }
}

function extractPptx(path: string, maxChars: number): Extraction {
  const zip = openZip(path);
  try {
    const slides = zip.entries
      .map((e) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(e.name))
      .filter((m): m is RegExpExecArray => !!m)
      .sort((a, b) => Number(a[1]) - Number(b[1]));
    const blocks = slides.map((m) => {
      const xml = zip.read(m[0]).toString("utf8");
      const paras = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)]
        .map((p) => decodeXml([...p[1]!.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => t[1]).join("")))
        .filter(Boolean);
      return `### Slide ${m[1]}\n${paras.join("\n")}`;
    });
    const r = finish("pptx", blocks.join("\n\n"), maxChars, { structure: { slides: slides.length } });
    return r.text ? r : { ...r, problem: "empty", note: "no text on slides" };
  } finally {
    zip.close();
  }
}

async function extractPdf(path: string, maxChars: number): Promise<Extraction> {
  let pages: number | undefined;
  try {
    const info = await execFileAsync("pdfinfo", [path], { timeout: 15_000, maxBuffer: 1024 * 1024 });
    const m = /^Pages:\s+(\d+)/m.exec(info.stdout);
    if (m) pages = Number(m[1]);
    if (/^Encrypted:\s+yes/m.test(info.stdout)) {
      return { kind: "pdf", text: "", chars: 0, truncated: false, problem: "encrypted", note: "the PDF is encrypted/password-protected", structure: { pages } };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "pdf", text: "", chars: 0, truncated: false, problem: "tool-missing", note: "pdftotext (poppler-utils) is not installed on the host" };
    }
    return { kind: "pdf", text: "", chars: 0, truncated: false, problem: "corrupt", note: "the PDF cannot be read (damaged file?)" };
  }
  try {
    const { stdout } = await execFileAsync("pdftotext", ["-layout", "-enc", "UTF-8", "-nopgbrk", path, "-"], {
      timeout: 45_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const r = finish("pdf", stdout, maxChars, { structure: { pages } });
    // «Пустое» извлечение — не успех: у скана нет текстового слоя.
    if (r.chars < 20) return { ...r, problem: "no-text-layer", note: "no text layer found — most likely a scanned document" };
    return r;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "pdf", text: "", chars: 0, truncated: false, problem: "tool-missing", note: "pdftotext (poppler-utils) is not installed on the host" };
    }
    return { kind: "pdf", text: "", chars: 0, truncated: false, problem: "corrupt", note: "text extraction from the PDF failed" };
  }
}

const TEXT_READ_LIMIT = 4 * 1024 * 1024;

export async function extractDocument(
  path: string,
  sniffed: Pick<Sniffed, "kind" | "family">,
  { maxChars = 20_000, maxRowsPerSheet = 200 }: { maxChars?: number; maxRowsPerSheet?: number } = {},
): Promise<Extraction> {
  try {
    switch (sniffed.kind) {
      case "text": {
        const size = statSync(path).size;
        const buf = readFileSync(path).subarray(0, TEXT_READ_LIMIT);
        const text = decodeText(buf);
        const lines = text.split("\n").length;
        const r = finish("text", text, maxChars, { structure: { lines }, note: size > TEXT_READ_LIMIT ? `only the first ${TEXT_READ_LIMIT} bytes were read` : undefined });
        return r.text ? r : { ...r, problem: "empty", note: "the file has no text" };
      }
      case "docx":
        return extractDocx(path, maxChars);
      case "xlsx":
        return extractXlsx(path, maxChars, maxRowsPerSheet);
      case "pptx":
        return extractPptx(path, maxChars);
      case "pdf":
        return await extractPdf(path, maxChars);
      case "ole":
        return { kind: "ole", text: "", chars: 0, truncated: false, problem: "unsupported", note: "legacy .doc/.xls/.ppt binary format: convert it first (for example with LibreOffice headless) or ask for a .docx/.xlsx" };
      case "rtf":
        return { kind: "rtf", text: "", chars: 0, truncated: false, problem: "unsupported", note: "RTF is not parsed automatically" };
      default:
        return { kind: sniffed.kind, text: "", chars: 0, truncated: false, problem: "unsupported", note: "this file type is not read automatically" };
    }
  } catch (err) {
    if (err instanceof ZipError) {
      const encrypted = err.code === "unsupported" && /encrypt/i.test(err.message);
      return { kind: sniffed.kind, text: "", chars: 0, truncated: false, problem: encrypted ? "encrypted" : err.code === "bomb" ? "too-large" : "corrupt", note: `unsafe or damaged archive container: ${err.message}` };
    }
    return { kind: sniffed.kind, text: "", chars: 0, truncated: false, problem: "corrupt", note: `the file could not be parsed (${(err as Error).name})` };
  }
}
