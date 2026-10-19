// SPDX-License-Identifier: GPL-3.0-or-later
// 最小 ZIP 读写：仅供 .wbc v2 容器使用（store/deflate）。
const zlib = require('zlib');

let crcTable = null;

function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function u16(value) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value & 0xffff, 0);
  return b;
}

function u32(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value >>> 0, 0);
  return b;
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/** entries: [{ name, data }] → Buffer */
function write(entries, date = new Date()) {
  const { time, day } = dosDateTime(date);
  const locals = [];
  const centrals = [];
  let offset = 0;
  let centralSize = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const crc = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(time), u16(day),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0),
      name, data
    ]);
    locals.push(local);

    const central = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(time), u16(day),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), name
    ]);
    centrals.push(central);
    centralSize += central.length;
    offset += local.length;
  }

  const centralOffset = offset;
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralSize), u32(centralOffset), u16(0)
  ]);
  return Buffer.concat([...locals, centralDir, eocd]);
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/** Buffer → Map<name, Buffer> */
function read(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('不是有效的 ZIP 文件');
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件');
  const count = buf.readUInt16LE(eocd + 10);
  if (count > 10000) throw new Error('ZIP 条目过多');
  const MAX_ENTRY = 300 * 1024 * 1024;
  let total = 0;
  let ptr = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error('ZIP 目录损坏');
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const uncompSize = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    ptr += 46 + nameLen + extraLen + commentLen;

    if (compSize > MAX_ENTRY || uncompSize > MAX_ENTRY) throw new Error('ZIP 条目过大');
    total += uncompSize;
    if (total > MAX_ENTRY * 2) throw new Error('ZIP 解压体积过大');
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('ZIP 数据损坏');
    const localNameLen = buf.readUInt16LE(localOff + 26);
    const localExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + localNameLen + localExtraLen;
    if (dataStart + compSize > buf.length) throw new Error('ZIP 数据越界');
    const raw = buf.subarray(dataStart, dataStart + compSize);
    if (method === 0) files.set(name, raw);
    else if (method === 8) files.set(name, zlib.inflateRawSync(raw));
    else throw new Error('不支持的 ZIP 压缩方式');
  }
  return files;
}

function isZip(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50;
}

module.exports = { write, read, isZip, crc32 };

/** 扫描本地文件头，尽量读取截断的 ZIP */
function readLenient(buf) {
  const files = new Map();
  const MAX_ENTRY = 300 * 1024 * 1024;
  let ptr = 0;
  while (ptr + 30 <= buf.length) {
    if (buf.readUInt32LE(ptr) !== 0x04034b50) {
      ptr += 1;
      continue;
    }
    const method = buf.readUInt16LE(ptr + 8);
    const compSize = buf.readUInt32LE(ptr + 18);
    const nameLen = buf.readUInt16LE(ptr + 26);
    const extraLen = buf.readUInt16LE(ptr + 28);
    const dataStart = ptr + 30 + nameLen + extraLen;
    if (nameLen <= 0 || compSize > MAX_ENTRY || dataStart + compSize > buf.length) break;
    const name = buf.toString('utf8', ptr + 30, ptr + 30 + nameLen);
    const raw = buf.subarray(dataStart, dataStart + compSize);
    try {
      if (method === 0) files.set(name, raw);
      else if (method === 8) files.set(name, zlib.inflateRawSync(raw));
    } catch {
      /* 跳过损坏条目 */
    }
    ptr = dataStart + compSize;
  }
  return files;
}

module.exports = { write, read, isZip, crc32, readLenient };
