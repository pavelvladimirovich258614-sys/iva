import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { deflateRawSync } from "node:zlib";
import { safeFileName, sniffBuffer, sniffFile } from "./media-sniff.ts";
import { extractDocument } from "./doc-extract.ts";
import { ZipError, openZip } from "./zip-lite.ts";
import { csvFixture, makeDocx, makePdf, makePng, makeScanPdf, makeSilence, makeVoice, makeXlsx, makeZip } from "../../scripts/lib/media-fixtures.mjs";

const dir = mkdtempSync(join(tmpdir(), "iva-docs-"));
const put = (name, data) => {
  const p = join(dir, name);
  writeFileSync(p, data);
  return p;
};
const hasPoppler = (() => { try { execFileSync("pdftotext", ["-v"], { stdio: "ignore" }); return true; } catch { return false; } })();

test("sniff: real type comes from the content, not from the name or declared type", () => {
  assert.equal(sniffBuffer(makePng("x")).kind, "png");
  assert.equal(sniffBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])).kind, "jpeg");
  assert.equal(sniffBuffer(Buffer.from("GIF89a....")).kind, "gif");
  assert.equal(sniffBuffer(makePdf(["hi"])).kind, "pdf");
  assert.equal(sniffBuffer(makeVoice("привет")).kind, "ogg");
  assert.equal(sniffBuffer(makeVoice("привет")).family, "audio");
  assert.equal(sniffBuffer(Buffer.from("ID3\x04\0\0\0\0\0\0")).kind, "mp3");
  assert.equal(sniffBuffer(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")])).kind, "wav");
  assert.equal(sniffBuffer(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypM4A "), Buffer.alloc(8)])).kind, "m4a");
  assert.equal(sniffBuffer(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom"), Buffer.alloc(8)])).kind, "mp4");
  assert.equal(sniffBuffer(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypheic"), Buffer.alloc(8)])).kind, "heic");
  assert.equal(sniffBuffer(Buffer.from("MZ\x90\0")).family, "executable");
  assert.equal(sniffBuffer(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])).family, "executable");
  assert.equal(sniffBuffer(Buffer.from("#!/bin/sh\nrm -rf /\n")).family, "executable");
  assert.equal(sniffBuffer(Buffer.alloc(0)).kind, "empty");
  assert.equal(sniffBuffer(Buffer.from([0, 1, 2, 3, 0, 255, 0, 9, 0, 0, 0, 1])).family, "unknown");
  // «report.pdf», которое на деле исполняемый файл, остаётся исполняемым
  assert.equal(sniffBuffer(Buffer.from("MZ\x90\0"), "report.pdf").family, "executable");
  // а «photo.jpg» с текстом внутри — текст
  assert.equal(sniffBuffer(Buffer.from("just words\n"), "photo.jpg").family, "text");
  const csv = sniffBuffer(Buffer.from(csvFixture), "data.csv");
  assert.equal(csv.kind, "text");
  assert.equal(csv.textKind, "csv");
});

test("sniff: OOXML containers are told apart by their structure; plain zip stays an archive", () => {
  assert.equal(sniffFile(put("a.bin", makeDocx({ paragraphs: ["x"] }))).kind, "docx");
  assert.equal(sniffFile(put("b.bin", makeXlsx({ sheets: [{ name: "S", rows: [["a"]] }] }))).kind, "xlsx");
  const zip = sniffFile(put("c.docx", makeZip([{ name: "readme.txt", data: "hello" }])));
  assert.equal(zip.kind, "zip");
  assert.equal(zip.family, "archive"); // расширение .docx ничего не значит
});

test("safeFileName: no paths, no traversal, extension follows the real type", () => {
  const png = { ext: "png", kind: "png" };
  assert.equal(safeFileName("../../etc/passwd", png, "image-1"), "passwd.png");
  assert.equal(safeFileName("..\\..\\win\\evil.exe", png, "image-1"), "evil.png");
  assert.equal(safeFileName("отчёт за квартал (v2).pdf", { ext: "pdf", kind: "pdf" }, "d"), "отчёт за квартал _v2.pdf");
  assert.equal(safeFileName("", png, "image-120305"), "image-120305.png");
  assert.equal(safeFileName("\u0000‮.png", png, "fb"), "fb.png");
  assert.equal(safeFileName("data.csv", { ext: "txt", kind: "text" }, "f"), "data.csv");
  assert.equal(safeFileName("run.sh", { ext: "bin", kind: "unknown" }, "f"), "run.bin"); // расширение берётся из реального типа
  assert.ok(safeFileName("a".repeat(500) + ".txt", { ext: "txt", kind: "text" }, "f").length <= 90);
});

test("zip-lite: reads real archives; refuses traversal, bombs, encryption, truncation and ZIP64", () => {
  const p = put("ok.zip", makeZip([{ name: "a.txt", data: "alpha" }, { name: "b/c.txt", data: "beta", store: true }]));
  const z = openZip(p);
  assert.equal(z.read("a.txt").toString(), "alpha");
  assert.equal(z.read("b/c.txt").toString(), "beta");
  z.close();
  assert.throws(() => openZip(put("trav.zip", makeZip([{ name: "../../evil.txt", data: "x" }]))), (e) => e instanceof ZipError && e.code === "traversal");
  assert.throws(() => openZip(put("abs.zip", makeZip([{ name: "/etc/passwd", data: "x" }]))), (e) => e instanceof ZipError && e.code === "traversal");
  assert.throws(() => openZip(put("junk.zip", Buffer.from("PK\x03\x04 definitely not a zip, long enough to scan for eocd......"))), (e) => e instanceof ZipError && e.code === "not-zip");
  // bomb: 20 МБ нулей сжимаются в ~20 КБ (коэффициент > лимита)
  const bomb = put("bomb.zip", makeZip([{ name: "big.xml", data: Buffer.alloc(20 * 1024 * 1024) }]));
  const zb = openZip(bomb);
  assert.throws(() => zb.read("big.xml"), (e) => e instanceof ZipError && e.code === "bomb");
  zb.close();
  // зашифрованная запись
  const enc = makeZip([{ name: "s.txt", data: "secret" }]);
  const cd = enc.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  enc.writeUInt16LE(1, cd + 8);
  const ze = openZip(put("enc.zip", enc));
  assert.throws(() => ze.read("s.txt"), (e) => e instanceof ZipError && e.code === "unsupported");
  ze.close();
  // обрезанный архив
  const full = makeZip([{ name: "a.txt", data: "alpha".repeat(1000) }]);
  assert.throws(() => openZip(put("cut.zip", full.subarray(0, full.length - 30))), ZipError);
  // заявленный размер не совпадает с распакованным: inflate с maxOutputLength не раздувается
  const lying = makeZip([{ name: "x.bin", data: Buffer.alloc(2_000_000, 1) }]);
  const lcd = lying.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  lying.writeUInt32LE(10, lcd + 24); // «размер 10 байт»
  const zl = openZip(put("lying.zip", lying));
  assert.throws(() => zl.read("x.bin"), ZipError);
  zl.close();
  void deflateRawSync;
});

test("extract: text, csv and markdown keep their content; windows-1251 is decoded", async () => {
  const t = await extractDocument(put("n.md", "# Заголовок\n\nУсловие: оплата в течение 14 дней.\n"), { kind: "text", family: "text" });
  assert.match(t.text, /оплата в течение 14 дней/);
  assert.equal(t.truncated, false);
  const c = await extractDocument(put("d.csv", csvFixture), { kind: "text", family: "text" });
  assert.equal(c.text, csvFixture.trim());
  assert.equal(c.structure.lines, 4);
  const cp1251 = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]); // «Привет»
  assert.equal((await extractDocument(put("w.txt", cp1251), { kind: "text", family: "text" })).text, "Привет");
  const long = await extractDocument(put("long.txt", "x".repeat(50_000)), { kind: "text", family: "text" }, { maxChars: 1000 });
  assert.equal(long.text.length, 1000);
  assert.equal(long.truncated, true);
  assert.equal(long.chars, 50_000);
});

test("extract: DOCX paragraphs and tables with known content", async () => {
  const f = put("c.docx", makeDocx({ paragraphs: ["Договор поставки № 17", "Срок оплаты: 14 дней & штраф 0,1% <в день>"], table: [["Позиция", "Кол-во"], ["Болт М8", "120"]] }));
  const r = await extractDocument(f, sniffFile(f));
  assert.equal(r.problem, undefined);
  assert.match(r.text, /Договор поставки № 17/);
  assert.match(r.text, /штраф 0,1% <в день>/); // XML-сущности раскрыты
  assert.match(r.text, /Позиция \| Кол-во/);
  assert.match(r.text, /Болт М8 \| 120/);
  const empty = put("e.docx", makeDocx({ paragraphs: [] }));
  assert.equal((await extractDocument(empty, sniffFile(empty))).problem, "empty");
});

test("extract: XLSX keeps sheets, numbers and formulas", async () => {
  const f = put("t.xlsx", makeXlsx({
    sheets: [
      { name: "Продажи", rows: [["Товар", "Кол-во", "Цена", "Сумма"], ["Болт", 10, 2.5, { f: "B2*C2", v: 25 }], ["Гайка", 4, 1.25, { f: "B3*C3", v: 5 }], ["Итого", "", "", { f: "SUM(D2:D3)", v: 30 }]] },
      { name: "Склад", rows: [["Товар", "Остаток"], ["Болт", 900]] },
    ],
  }));
  const r = await extractDocument(f, sniffFile(f));
  assert.equal(r.problem, undefined);
  assert.deepEqual(r.structure.sheets.map((s) => [s.name, s.rows, s.cols]), [["Продажи", 4, 4], ["Склад", 2, 2]]);
  assert.match(r.text, /Sheet "Продажи" \(4 rows × 4 cols\)/);
  assert.match(r.text, /row 2: A2=Болт \| B2=10 \| C2=2.5 \| D2=25 \[formula: =B2\*C2\]/);
  assert.match(r.text, /D4=30 \[formula: =SUM\(D2:D3\)\]/);
  assert.match(r.text, /Sheet "Склад"/);
  assert.match(r.text, /B2=900/);
});

test("extract: XLSX with many rows reports what is not shown", async () => {
  const rows = [["n"], ...Array.from({ length: 500 }, (_, i) => [i + 1])];
  const f = put("big.xlsx", makeXlsx({ sheets: [{ name: "N", rows }] }));
  const r = await extractDocument(f, sniffFile(f), { maxRowsPerSheet: 50 });
  assert.match(r.text, /451 more row\(s\) not shown/);
  assert.equal(r.structure.sheets[0].rows, 501);
});

test("extract: PDF with a text layer is read; a scan is NOT reported as success", { skip: !hasPoppler && "poppler is not installed" }, async () => {
  const f = put("t.pdf", makePdf(["Clause 7.2: payment within 14 days.", "Penalty rate is 0.1 percent per day."]));
  const r = await extractDocument(f, sniffFile(f));
  assert.equal(r.problem, undefined);
  assert.match(r.text, /Clause 7\.2: payment within 14 days\./);
  assert.match(r.text, /Penalty rate is 0\.1 percent per day\./);
  assert.equal(r.structure.pages, 1);
  const scan = put("scan.pdf", makeScanPdf());
  const s = await extractDocument(scan, sniffFile(scan));
  assert.equal(s.problem, "no-text-layer");
  assert.equal(s.text, "");
  const broken = put("broken.pdf", Buffer.from("%PDF-1.4\nthis is not really a pdf\n"));
  assert.equal((await extractDocument(broken, sniffFile(broken))).problem, "corrupt");
});

test("extract: corrupt, legacy and unsupported files produce an explicit problem, never empty success", async () => {
  const truncated = makeDocx({ paragraphs: ["x".repeat(500)] });
  const f = put("cut.docx", truncated.subarray(0, truncated.length - 60));
  const r = await extractDocument(f, { kind: "docx", family: "document" });
  assert.equal(r.problem, "corrupt");
  assert.equal(r.text, "");
  assert.equal((await extractDocument(put("old.doc", Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(100)])), { kind: "ole", family: "document" })).problem, "unsupported");
  assert.equal((await extractDocument(put("a.ogg", makeSilence()), { kind: "ogg", family: "audio" })).problem, "unsupported");
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
