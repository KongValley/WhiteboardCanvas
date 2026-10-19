// SPDX-License-Identifier: GPL-3.0-or-later
// 生成 build/icon.ico（自绘，256/128/64/48/32/16 多尺寸 PNG 条目）。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const SS = 3; // 超采样

function roundedRect(x, y, w, h, r) {
  return (px, py) => {
    const cx = Math.max(x + r, Math.min(px, x + w - r));
    const cy = Math.max(y + r, Math.min(py, y + h - r));
    return Math.hypot(px - cx, py - cy) <= r;
  };
}

function distSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy || 1;
  let t = ((px - ax) * vx + (py - ay) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

function render() {
  const pixels = new Uint8Array(SIZE * SIZE * 4);
  const board = roundedRect(38, 38, 180, 180, 30);
  const base = roundedRect(6, 6, 244, 244, 54);
  const strokes = [
    [70, 178, 108, 116],
    [108, 116, 148, 158],
    [148, 158, 194, 82]
  ];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let bg = 0;
      let fg = 0;
      let white = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (base(px, py)) bg++;
          if (!board(px, py)) continue;
          white++;
          for (const [ax, ay, bx, by] of strokes) {
            if (distSegment(px, py, ax, ay, bx, by) <= 11) {
              fg++;
              break;
            }
          }
        }
      }
      const total = SS * SS;
      const i = (y * SIZE + x) * 4;
      const a = bg / total;
      const w = white / total;
      const f = fg / total;
      // 蓝色圆角底 + 白色板面 + 蓝色笔迹
      const blue = [37, 99, 235];
      const boardRgb = [255, 255, 255];
      let r = blue[0];
      let g = blue[1];
      let b = blue[2];
      if (w > 0) {
        r = r + (boardRgb[0] - r) * w;
        g = g + (boardRgb[1] - g) * w;
        b = b + (boardRgb[2] - b) * w;
      }
      if (f > 0) {
        r = r + (blue[0] - r) * f;
        g = g + (blue[1] - g) * f;
        b = b + (blue[2] - b) * f;
      }
      pixels[i] = Math.round(r);
      pixels[i + 1] = Math.round(g);
      pixels[i + 2] = Math.round(b);
      pixels[i + 3] = Math.round(a * 255);
    }
  }
  return pixels;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const name = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([len, name, data, crc]);
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0;
    rgba.copy(row, 1, y * size * 4, (y + 1) * size * 4);
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function downscale(rgba, size, target) {
  const out = Buffer.alloc(target * target * 4);
  const ratio = size / target;
  for (let y = 0; y < target; y++) {
    for (let x = 0; x < target; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = Math.floor(y * ratio); sy < Math.min(size, Math.ceil((y + 1) * ratio)); sy++) {
        for (let sx = Math.floor(x * ratio); sx < Math.min(size, Math.ceil((x + 1) * ratio)); sx++) {
          const i = (sy * size + sx) * 4;
          r += rgba[i];
          g += rgba[i + 1];
          b += rgba[i + 2];
          a += rgba[i + 3];
          n++;
        }
      }
      const i = (y * target + x) * 4;
      out[i] = Math.round(r / n);
      out[i + 1] = Math.round(g / n);
      out[i + 2] = Math.round(b / n);
      out[i + 3] = Math.round(a / n);
    }
  }
  return out;
}

function build() {
  const master = render();
  const sizes = [256, 128, 64, 48, 32, 16];
  const images = sizes.map((size) => encodePng(size === SIZE ? Buffer.from(master) : downscale(Buffer.from(master), SIZE, size), size));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  const entries = [];
  let offset = 6 + sizes.length * 16;
  for (let i = 0; i < sizes.length; i++) {
    const entry = Buffer.alloc(16);
    entry[0] = sizes[i] === 256 ? 0 : sizes[i];
    entry[1] = sizes[i] === 256 ? 0 : sizes[i];
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(images[i].length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += images[i].length;
  }
  const out = Buffer.concat([header, ...entries, ...images]);
  const target = path.join(__dirname, '..', 'build', 'icon.ico');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, out);
  console.log('icon.ico', out.length, 'bytes');
}

build();
