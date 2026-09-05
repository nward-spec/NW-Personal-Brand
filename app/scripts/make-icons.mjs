// Generates the PWA icons without any native dependencies: a rounded purple
// tile with a 3x3 "habit grid" of dots. Writes PNGs into public/.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
mkdirSync(out, { recursive: true });

const BG = [0x6d, 0x5d, 0xfc];
const DOT_ON = [0xff, 0xff, 0xff];
const DOT_OFF = [0xff, 0xff, 0xff, 0.38];
// Which dots are "done" (row-major, 3x3).
const PATTERN = [1, 1, 0, 1, 1, 1, 0, 1, 0];

const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function encodePNG(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Coverage-sampled renderer: each pixel is averaged over a 4x4 sub-grid.
function render(size, { padding, radius, transparentCorners }) {
  const px = Buffer.alloc(size * size * 4);
  const tile = size * (1 - padding * 2);
  const t0 = size * padding;
  const r = tile * radius;
  const cell = tile / 3;
  const dotR = cell * 0.19;
  const SS = 4;

  const inTile = (x, y) => {
    const lx = x - t0;
    const ly = y - t0;
    if (lx < 0 || ly < 0 || lx > tile || ly > tile) return false;
    const cx = Math.min(Math.max(lx, r), tile - r);
    const cy = Math.min(Math.max(ly, r), tile - r);
    return (lx - cx) ** 2 + (ly - cy) ** 2 <= r * r;
  };
  const dotAt = (x, y) => {
    for (let i = 0; i < 9; i++) {
      const cx = t0 + cell * ((i % 3) + 0.5);
      const cy = t0 + cell * (Math.floor(i / 3) + 0.5);
      if ((x - cx) ** 2 + (y - cy) ** 2 <= dotR * dotR) return PATTERN[i] ? DOT_ON : DOT_OFF;
    }
    return null;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rr = 0, gg = 0, bb = 0, aa = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS;
          const fy = y + (sy + 0.5) / SS;
          let c = null;
          if (inTile(fx, fy)) {
            const dot = dotAt(fx, fy);
            if (dot) {
              const a = dot[3] ?? 1;
              c = [BG[0] * (1 - a) + dot[0] * a, BG[1] * (1 - a) + dot[1] * a, BG[2] * (1 - a) + dot[2] * a, 1];
            } else c = [...BG, 1];
          } else if (!transparentCorners) c = [...BG, 1];
          if (c) {
            rr += c[0]; gg += c[1]; bb += c[2]; aa += c[3];
          }
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      if (aa > 0) {
        px[i] = Math.round(rr / aa);
        px[i + 1] = Math.round(gg / aa);
        px[i + 2] = Math.round(bb / aa);
        px[i + 3] = Math.round((aa / n) * 255);
      }
    }
  }
  return px;
}

const specs = [
  ['icon-192.png', 192, { padding: 0, radius: 0.22, transparentCorners: true }],
  ['icon-512.png', 512, { padding: 0, radius: 0.22, transparentCorners: true }],
  ['icon-maskable-512.png', 512, { padding: 0.1, radius: 0, transparentCorners: false }],
  ['apple-touch-icon.png', 180, { padding: 0, radius: 0, transparentCorners: false }],
];
for (const [name, size, opts] of specs) {
  writeFileSync(join(out, name), encodePNG(size, render(size, opts)));
  console.log('wrote', name);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<rect width="100" height="100" rx="22" fill="#6d5dfc"/>
${PATTERN.map((on, i) => `<circle cx="${(i % 3) * 33.3 + 16.7}" cy="${Math.floor(i / 3) * 33.3 + 16.7}" r="6.3" fill="#fff" opacity="${on ? 1 : 0.38}"/>`).join('\n')}
</svg>`;
writeFileSync(join(out, 'favicon.svg'), svg);
console.log('wrote favicon.svg');
