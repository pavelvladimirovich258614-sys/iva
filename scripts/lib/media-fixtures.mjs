// Тестовые файлы с ЗАРАНЕЕ ИЗВЕСТНЫМ содержимым: PDF, DOCX, XLSX, CSV, PNG, «голосовое». Нужны юнит-тестам
// и e2e: проверяем не факт вызова модели, а то, какие именно данные до неё дошли.
// Все форматы — настоящие контейнеры (zip с корректными CRC, PDF с xref), которые читают реальные парсеры.
import { deflateRawSync } from "node:zlib";

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** entries: [{ name, data: Buffer|string, store?: boolean }] → Buffer ZIP. */
export function makeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, "utf8");
    const method = e.store ? 0 : 8;
    const comp = method === 0 ? raw : deflateRawSync(raw);
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const CONTENT_TYPES = (extra) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${extra}</Types>`;

/** DOCX: абзацы и (необязательно) таблица rows: string[][]. */
export function makeDocx({ paragraphs = [], table = null }) {
  const p = (t) => `<w:p><w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`;
  const tbl = table
    ? `<w:tbl>${table.map((row) => `<w:tr>${row.map((c) => `<w:tc>${p(c)}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`
    : "";
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map(p).join("")}${tbl}</w:body></w:document>`;
  return makeZip([
    { name: "[Content_Types].xml", data: CONTENT_TYPES('<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>') },
    { name: "_rels/.rels", data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: "word/document.xml", data: doc },
  ]);
}

const colName = (i) => String.fromCharCode(65 + i);

/**
 * XLSX: sheets = [{ name, rows: [[value | {f: "SUM(A1:A2)", v: 3}]] }]. Строки хранятся через sharedStrings,
 * числа — как числа, формулы — с кэшированным значением (как в настоящем Excel).
 */
export function makeXlsx({ sheets }) {
  const shared = [];
  const si = (s) => {
    let i = shared.indexOf(s);
    if (i < 0) i = shared.push(s) - 1;
    return i;
  };
  const sheetXml = sheets.map((sh) => {
    const rows = sh.rows
      .map((row, r) => {
        const cells = row
          .map((v, c) => {
            const ref = `${colName(c)}${r + 1}`;
            if (v === null || v === undefined || v === "") return "";
            if (typeof v === "object" && v.f) return `<c r="${ref}"><f>${esc(v.f)}</f><v>${v.v}</v></c>`;
            if (typeof v === "number") return `<c r="${ref}"><v>${v}</v></c>`;
            return `<c r="${ref}" t="s"><v>${si(String(v))}</v></c>`;
          })
          .join("");
        return `<row r="${r + 1}">${cells}</row>`;
      })
      .join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  });
  const wb = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`;
  const rels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`;
  const ss = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared.map((s) => `<si><t>${esc(s)}</t></si>`).join("")}</sst>`;
  return makeZip([
    { name: "[Content_Types].xml", data: CONTENT_TYPES('<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>') },
    { name: "_rels/.rels", data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", data: wb },
    { name: "xl/_rels/workbook.xml.rels", data: rels },
    { name: "xl/sharedStrings.xml", data: ss },
    ...sheetXml.map((x, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: x })),
  ]);
}

/** Настоящий PDF с текстовым слоем (Helvetica, латиница): xref с точными смещениями. */
export function makePdf(lines) {
  const stream = `BT /F1 12 Tf 72 740 Td 16 TL ${lines.map((l) => `(${l.replace(/[\\()]/g, "\\$&")}) Tj T*`).join(" ")} ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** PDF без текстового слоя («скан»): страница без шрифта и текста. */
export function makeScanPdf() {
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>"];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/**
 * Настоящий PNG 1×1 с текстовым чанком iTXt/tEXt: mock-vision «читает» этот текст, что даёт детерминированный
 * «OCR» без настоящей модели. visibleText — то, что «написано на картинке».
 */
export function makePng(visibleText) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const idat = deflateSync1x1();
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("tEXt", Buffer.from(`IvaVisibleText\0${visibleText}`, "utf8")),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
import { deflateSync } from "node:zlib";
function deflateSync1x1() {
  return deflateSync(Buffer.from([0, 0x20, 0x40, 0x60]));
}
/** Достаёт «написанное на картинке» из PNG, созданного makePng (для mock-vision). */
export function readPngVisibleText(buf) {
  const marker = Buffer.from("IvaVisibleText\0", "utf8");
  const i = buf.indexOf(marker);
  if (i < 0) return null;
  const start = i + marker.length;
  const end = buf.indexOf(Buffer.from("IDAT", "ascii"), start);
  // перед IDAT идут 4 байта CRC чанка tEXt и 4 байта длины IDAT
  return buf.subarray(start, end - 8).toString("utf8");
}

/**
 * «Голосовое»: контейнер OGG (сигнатура OggS) с полезной нагрузкой SPEECH:<текст>. Настоящий STT его не
 * распознает — в тестах работает mock-Deepgram, который достаёт текст из нагрузки и тем самым доказывает,
 * что до STT дошли ИМЕННО эти байты.
 */
export function makeVoice(spokenText) {
  return Buffer.concat([Buffer.from("OggS\0\x02", "latin1"), Buffer.alloc(20), Buffer.from(`SPEECH:${spokenText}`, "utf8")]);
}
export function readVoiceText(buf) {
  const s = buf.toString("utf8");
  const i = s.indexOf("SPEECH:");
  return i < 0 ? null : s.slice(i + 7);
}
/** Запись без речи (тишина/шум). */
export function makeSilence() {
  return Buffer.concat([Buffer.from("OggS\0\x02", "latin1"), Buffer.alloc(64)]);
}

export const csvFixture = "item,qty,price\nwidget,3,9.50\ngadget,2,20.00\n";
