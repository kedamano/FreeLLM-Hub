// Regenerates resources/icons/{icon.ico,icon.png,tray.png}.
// Pure Node (zlib only) so the icon set stays reproducible without an image toolchain.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'resources/icons');

const TOP = [56, 189, 248];
const BOTTOM = [99, 102, 241];
const GLYPH = [255, 255, 255];

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// BITMAPINFOHEADER + bottom-up BGRA + bottom-up 1-bit AND mask (bit set = transparent).
function bmpEntry(size, rgba) {
  const pixelBytes = size * size * 4;
  const maskStride = Math.ceil(size / 32) * 4;
  const maskBytes = maskStride * size;

  const info = Buffer.alloc(40);
  info.writeUInt32LE(40, 0);
  info.writeInt32LE(size, 4);
  info.writeInt32LE(size * 2, 8);
  info.writeUInt16LE(1, 12);
  info.writeUInt16LE(32, 14);
  info.writeUInt32LE(0, 16);
  info.writeUInt32LE(pixelBytes + maskBytes, 20);

  const pixels = Buffer.alloc(pixelBytes);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = ((size - 1 - y) * size + x) * 4;
      const d = (y * size + x) * 4;
      pixels[d] = rgba[s + 2];
      pixels[d + 1] = rgba[s + 1];
      pixels[d + 2] = rgba[s];
      pixels[d + 3] = rgba[s + 3];
    }
  }

  const mask = Buffer.alloc(maskBytes);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (rgba[((size - 1 - y) * size + x) * 4 + 3] < 128) {
        mask[y * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }

  return Buffer.concat([info, pixels, mask]);
}

function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  let offset = 6 + 16 * entries.length;
  const blocks = [];
  const entryBlocks = [];

  entries.forEach(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entryBlocks.push(entry);
    blocks.push(data);
    offset += data.length;
  });

  return Buffer.concat([header, ...entryBlocks, ...blocks]);
}

/**
 * Apple icon family. Every entry is a whole PNG payload (allowed since OS X 10.7), so no
 * `iconutil`/macOS host is needed to produce a valid `.icns` from Linux or Windows CI.
 * Type -> pixel size, including the @2x slots the shell picks per display density.
 */
const ICNS_ENTRIES = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 48],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32],
  ['ic12', 64],
  ['ic13', 256],
  ['ic14', 512],
];

function encodeIcns(pngBySize) {
  const blocks = [];
  for (const [type, size] of ICNS_ENTRIES) {
    const png = pngBySize.get(size);
    if (!png) continue;
    const header = Buffer.alloc(8);
    header.write(type, 0, 'ascii');
    header.writeUInt32BE(png.length + 8, 4);
    blocks.push(header, png);
  }

  const body = Buffer.concat(blocks);
  const magic = Buffer.alloc(8);
  magic.write('icns', 0, 'ascii');
  magic.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([magic, body]);
}

function roundedRectAlpha(x, y, n, corner) {
  const dx = Math.abs(x - n / 2) - (n / 2 - corner);
  const dy = Math.abs(y - n / 2) - (n / 2 - corner);
  const dist = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - corner;
  return Math.max(0, Math.min(1, 0.5 - dist));
}

function segmentDistance(x, y, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

function glyphAlpha(x, y, n) {
  const cx = n / 2;
  const cy = n / 2;
  const hub = Math.hypot(x - cx, y - cy) - n * 0.06;
  let best = Math.max(0, Math.min(1, 0.5 - hub));
  for (let i = 0; i < 3; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / 3;
    const nx = cx + Math.cos(a) * n * 0.29;
    const ny = cy + Math.sin(a) * n * 0.29;
    const node = Math.max(0, Math.min(1, 0.5 - (Math.hypot(x - nx, y - ny) - n * 0.075)));
    const spoke = Math.max(0, Math.min(1, 0.5 - (segmentDistance(x, y, cx, cy, nx, ny) - n * 0.03)));
    best = Math.min(1, best + node + spoke);
  }
  return best;
}

function render(size, samples) {
  const n = size * samples;
  const corner = n * 0.22;
  const out = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rAcc = 0;
      let gAcc = 0;
      let bAcc = 0;
      let aAcc = 0;

      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px = x * samples + sx + 0.5;
          const py = y * samples + sy + 0.5;
          const cov = roundedRectAlpha(px, py, n, corner);
          if (cov === 0) continue;
          const t = py / n;
          const g = glyphAlpha(px, py, n);
          const mix = g * cov;
          rAcc += cov * (TOP[0] + (BOTTOM[0] - TOP[0]) * t + (GLYPH[0] - (TOP[0] + (BOTTOM[0] - TOP[0]) * t)) * mix);
          gAcc += cov * (TOP[1] + (BOTTOM[1] - TOP[1]) * t + (GLYPH[1] - (TOP[1] + (BOTTOM[1] - TOP[1]) * t)) * mix);
          bAcc += cov * (TOP[2] + (BOTTOM[2] - TOP[2]) * t + (GLYPH[2] - (TOP[2] + (BOTTOM[2] - TOP[2]) * t)) * mix);
          aAcc += cov;
        }
      }

      const alpha = aAcc / (samples * samples);
      const d = (y * size + x) * 4;
      out[d + 3] = Math.round(alpha * 255);
      if (alpha > 0) {
        out[d] = Math.round(Math.min(255, rAcc / aAcc));
        out[d + 1] = Math.round(Math.min(255, gAcc / aAcc));
        out[d + 2] = Math.round(Math.min(255, bAcc / aAcc));
      }
    }
  }

  return out;
}

mkdirSync(outDir, { recursive: true });
const linuxDir = resolve(outDir, 'linux');
mkdirSync(linuxDir, { recursive: true });

const icns = [16, 24, 32, 48, 64, 256].map((size) => ({
  size,
  data: bmpEntry(size, render(size, size >= 128 ? 2 : 4)),
}));

// PNG payloads shared by the .icns container and the Linux icon directory.
const PNG_SIZES = [16, 32, 48, 64, 128, 256, 512, 1024];
const pngBySize = new Map();
for (const size of PNG_SIZES) {
  pngBySize.set(size, encodePng(size, render(size, size >= 256 ? 1 : 4)));
}

writeFileSync(resolve(outDir, 'icon.ico'), encodeIco(icns));
writeFileSync(resolve(outDir, 'icon.png'), pngBySize.get(256));
writeFileSync(resolve(outDir, 'tray.png'), encodePng(32, render(32, 4)));
writeFileSync(resolve(outDir, 'icon.icns'), encodeIcns(pngBySize));

// electron-builder picks Linux icons as `<size>x<size>.png` inside buildResources/linux.
for (const size of [16, 32, 48, 64, 128, 256, 512]) {
  writeFileSync(resolve(linuxDir, `${size}x${size}.png`), pngBySize.get(size));
}
writeFileSync(resolve(outDir, 'icon-512.png'), pngBySize.get(512));

console.log(
  '[icons] wrote icon.ico (16/24/32/48/64/256), icon.png (256), icon-512.png, tray.png (32), ' +
    `icon.icns (${ICNS_ENTRIES.length} PNG entries), linux/ (${[16, 32, 48, 64, 128, 256, 512].join('/')} px)`
);
