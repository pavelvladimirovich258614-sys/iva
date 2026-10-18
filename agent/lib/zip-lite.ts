// Минимальное безопасное чтение ZIP (docx/xlsx/pptx — это ZIP). Ничего не распаковывается на диск:
// нужные записи читаются в память под жёсткими лимитами, что исключает zip-slip и zip-bomb.
// Поддержано: stored и deflate, без шифрования и без ZIP64 (такие архивы отклоняются явной ошибкой).

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

export class ZipError extends Error {
  code: "not-zip" | "unsupported" | "bomb" | "corrupt" | "traversal";
  constructor(code: ZipError["code"], message: string) {
    super(message);
    this.name = "ZipError";
    this.code = code;
  }
}

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
  encrypted: boolean;
}

export interface ZipLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxRatio: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 5000,
  maxEntryBytes: 32 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxRatio: 200,
};

function readAt(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = readSync(fd, buf, done, length - done, position + done);
    if (n === 0) break;
    done += n;
  }
  return done === length ? buf : buf.subarray(0, done);
}

export interface ZipArchive {
  entries: ZipEntry[];
  /** Читает запись целиком в память (с лимитами). */
  read(name: string): Buffer;
  has(name: string): boolean;
  close(): void;
}

export function openZip(path: string, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipArchive {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size < 22) throw new ZipError("not-zip", "file is too small to be a ZIP archive");
    const tailLen = Math.min(size, 22 + 65535);
    const tail = readAt(fd, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new ZipError("not-zip", "ZIP end-of-central-directory record not found");
    const total = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw new ZipError("unsupported", "ZIP64 archives are not supported");
    }
    if (total > limits.maxEntries) throw new ZipError("bomb", `archive has too many entries (${total})`);
    if (cdOffset + cdSize > size || cdSize > 8 * 1024 * 1024) throw new ZipError("corrupt", "invalid central directory");
    const cd = readAt(fd, cdOffset, cdSize);
    const entries: ZipEntry[] = [];
    let p = 0;
    let declaredTotal = 0;
    for (let i = 0; i < total; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new ZipError("corrupt", "invalid central directory entry");
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const compressedSize = cd.readUInt32LE(p + 20);
      const usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const offset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString("utf8");
      p += 46 + nameLen + extraLen + commentLen;
      if (name.startsWith("/") || name.split(/[\\/]/).includes("..") || name.includes("\0")) {
        throw new ZipError("traversal", "archive contains an unsafe entry name");
      }
      if (usize === 0xffffffff || compressedSize === 0xffffffff) throw new ZipError("unsupported", "ZIP64 entries are not supported");
      declaredTotal += usize;
      if (usize > limits.maxEntryBytes && !name.endsWith("/")) {
        // Слишком большая запись не обязательно бомба, но читать её мы не будем (read() отклонит).
      }
      entries.push({ name, method, compressedSize, size: usize, offset, encrypted: (flags & 1) === 1 });
    }
    if (declaredTotal > limits.maxTotalBytes * 8) throw new ZipError("bomb", "archive declares an excessive uncompressed size");
    const byName = new Map(entries.map((e) => [e.name, e]));
    let consumed = 0;
    return {
      entries,
      has: (name) => byName.has(name),
      read(name) {
        const e = byName.get(name);
        if (!e) throw new ZipError("corrupt", "entry not found in archive");
        if (e.encrypted) throw new ZipError("unsupported", "encrypted entries are not supported");
        if (e.size > limits.maxEntryBytes) throw new ZipError("bomb", "archive entry is too large");
        if (e.compressedSize > 0 && e.size / e.compressedSize > limits.maxRatio) throw new ZipError("bomb", "suspicious compression ratio");
        consumed += e.size;
        if (consumed > limits.maxTotalBytes) throw new ZipError("bomb", "archive expands beyond the allowed total size");
        const lh = readAt(fd, e.offset, 30);
        if (lh.length < 30 || lh.readUInt32LE(0) !== 0x04034b50) throw new ZipError("corrupt", "invalid local file header");
        const start = e.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
        const raw = readAt(fd, start, e.compressedSize);
        if (raw.length !== e.compressedSize) throw new ZipError("corrupt", "truncated archive entry");
        if (e.method === 0) return raw;
        if (e.method === 8) {
          try {
            // maxOutputLength не даёт распаковать больше заявленного размера + запас.
            return inflateRawSync(raw, { maxOutputLength: Math.min(limits.maxEntryBytes, e.size + 1024) });
          } catch {
            throw new ZipError("corrupt", "archive entry cannot be decompressed");
          }
        }
        throw new ZipError("unsupported", `compression method ${e.method} is not supported`);
      },
      close: () => {
        try {
          closeSync(fd);
        } catch {
          /* уже закрыт */
        }
      },
    };
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
    throw err;
  }
}
