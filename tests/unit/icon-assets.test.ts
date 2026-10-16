import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const iconsDir = resolve(process.cwd(), 'resources/icons');

function pngSize(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('icon assets', () => {
  it('ships every icon referenced by electron-builder.yml and the tray', () => {
    expect(existsSync(resolve(iconsDir, 'icon.ico'))).toBe(true);
    expect(existsSync(resolve(iconsDir, 'tray.png'))).toBe(true);
    expect(existsSync(resolve(iconsDir, 'icon.png'))).toBe(true);
  });

  it('declares a valid ICO directory (the previous stub claimed a size larger than the file)', () => {
    const buf = readFileSync(resolve(iconsDir, 'icon.ico'));
    expect(buf.readUInt16LE(2)).toBe(1);

    const count = buf.readUInt16LE(4);
    expect(count).toBeGreaterThanOrEqual(4);
    expect(6 + count * 16).toBeLessThanOrEqual(buf.length);

    const sizes: number[] = [];
    for (let i = 0; i < count; i++) {
      const entry = 6 + i * 16;
      const width = buf[entry] === 0 ? 256 : buf[entry];
      const height = buf[entry + 1] === 0 ? 256 : buf[entry + 1];
      const size = buf.readUInt32LE(entry + 8);
      const offset = buf.readUInt32LE(entry + 12);

      expect(buf.readUInt16LE(entry + 6)).toBe(32);
      expect(offset + size).toBeLessThanOrEqual(buf.length);
      expect(size).toBeGreaterThan(40);
      sizes.push(width);
      expect(height).toBe(width);
    }

    expect(sizes).toContain(256);
    expect(sizes).toContain(32);
    expect(sizes).toContain(16);
  });

  it('ships PNG bitmaps at the sizes the tray and window expect', () => {
    const tray = readFileSync(resolve(iconsDir, 'tray.png'));
    expect(tray.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(pngSize(tray)).toEqual({ width: 32, height: 32 });

    const app = readFileSync(resolve(iconsDir, 'icon.png'));
    expect(pngSize(app)).toEqual({ width: 256, height: 256 });
  });
});
