/**
 * Audits the four PNGs `apps/mobile/app.json` references.
 *
 * `.review/build-mobile-assets.mjs` renders them through Chrome and then says,
 * honestly, "check them by eye". This is the machine version of that eye.
 *
 * Three things can silently go wrong and none of them fail a build:
 *
 *  1. **The glyph is a tofu box.** U+20BF is not in every font, and this
 *     environment has already garbled non-ASCII through Node source twice. A
 *     missing glyph renders as a hollow rectangle, which still screenshots
 *     fine at thumbnail size.
 *  2. **A layer that must be transparent is opaque.** `adaptive-icon.png` is a
 *     *foreground* layer composited over `android.adaptiveIcon.backgroundColor`,
 *     and `splash.png` sits on `splash.backgroundColor`. Either one painted
 *     white would show as a white square on blue — and RGBA alone doesn't
 *     prove the background is transparent, only that alpha *could* vary.
 *  3. **The plate is the wrong blue.** `#2563EB` is `theme.ts`'s `primary`.
 *
 * So: decode the PNGs here and assert on pixels.
 *
 * Run: `node .review/asset-audit.mjs`
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const assetsDir = join(here, '..', 'apps', 'mobile', 'assets');

const BRAND = [0x25, 0x63, 0xeb];

/* ------------------------------------------------------------------ decode */

/** Minimal 8-bit RGBA PNG decoder. Only what our own renderer emits. */
function decodePng(buffer) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i += 1) {
    if (buffer[i] !== signature[i]) throw new Error('not a PNG');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }

    offset += 12 + length;
  }

  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error(`unsupported PNG: depth ${bitDepth}, colour type ${colorType}`);
  }

  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const pixels = Buffer.alloc(height * stride);

  // Undo the per-scanline filters (PNG spec §9.2).
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;

    for (let x = 0; x < stride; x += 1) {
      const value = raw[src + x];
      const left = x >= bpp ? pixels[dst + x - bpp] : 0;
      const up = y > 0 ? pixels[dst - stride + x] : 0;
      const upLeft = y > 0 && x >= bpp ? pixels[dst - stride + x - bpp] : 0;

      let restored;
      switch (filter) {
        case 0: restored = value; break;
        case 1: restored = value + left; break;
        case 2: restored = value + up; break;
        case 3: restored = value + ((left + up) >> 1); break;
        case 4: {
          // Paeth predictor.
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const nearest = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          restored = value + nearest;
          break;
        }
        default: throw new Error(`unknown PNG filter ${filter} on row ${y}`);
      }

      pixels[dst + x] = restored & 0xff;
    }
  }

  const at = (x, y) => {
    const i = y * stride + x * bpp;
    return [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]];
  };

  return { width, height, at };
}

/* ------------------------------------------------------------------ probes */

const hex = ([r, g, b]) =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;

const same = (a, b, tolerance = 6) =>
  Math.abs(a[0] - b[0]) <= tolerance &&
  Math.abs(a[1] - b[1]) <= tolerance &&
  Math.abs(a[2] - b[2]) <= tolerance;

/** Bounding box of pixels matching `predicate`, plus their count. */
function bbox({ width, height, at }, predicate) {
  let minX = width, minY = height, maxX = -1, maxY = -1, count = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!predicate(at(x, y))) continue;
      count += 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY, count };
}

const isOpaqueWhite = ([r, g, b, a]) => a > 200 && r > 240 && g > 240 && b > 240;
const isOpaque = ([, , , a]) => a > 200;
const isTransparent = ([, , , a]) => a < 40;

/**
 * The tofu test.
 *
 * A missing-glyph box is **hollow**: at the vertical middle of its bounding box
 * only the left and right edges are inked. A real `₿` has the B's middle bar
 * there, so the middle row is solid. Measuring the inked fraction across the
 * middle row separates the two cleanly, and doesn't care what the glyph is
 * *supposed* to look like.
 */
function middleRowFill(image, box) {
  const y = Math.round((box.minY + box.maxY) / 2);
  let inked = 0;
  for (let x = box.minX; x <= box.maxX; x += 1) {
    if (isOpaqueWhite(image.at(x, y))) inked += 1;
  }
  return inked / (box.maxX - box.minX + 1);
}

/**
 * Counts distinct inked runs across a row of the glyph — `₿` carries two stems,
 * so the row near its top should read two runs.
 *
 * Sampled 8% down from the top rather than on `minY` itself: antialiasing makes
 * the tallest stem's first row the only fully-inked one, which would report a
 * spurious single run.
 */
function stemRuns(image, box) {
  const y = box.minY + Math.round((box.maxY - box.minY + 1) * 0.08);
  let runs = 0;
  let inRun = false;
  for (let x = box.minX; x <= box.maxX; x += 1) {
    const inked = isOpaqueWhite(image.at(x, y));
    if (inked && !inRun) runs += 1;
    inRun = inked;
  }
  return runs;
}

/**
 * Every opaque pixel must lie on the plate↔glyph blend ramp — the brand blue,
 * white, or a mix of the two.
 *
 * A plain "is it blue or white" test does not work: antialiasing along the
 * glyph's perimeter produces ~150 distinct in-between colours (the 50% mix is
 * `#92B1F5`), and the ₿ outline is long enough that those run to a few thousand
 * pixels. Measuring the perpendicular distance to the segment brand→white
 * accepts the whole ramp and still rejects a genuinely foreign colour.
 */
const WHITE = [255, 255, 255];

function distanceToRamp(pixel) {
  const ab = [WHITE[0] - BRAND[0], WHITE[1] - BRAND[1], WHITE[2] - BRAND[2]];
  const ap = [pixel[0] - BRAND[0], pixel[1] - BRAND[1], pixel[2] - BRAND[2]];
  const lengthSquared = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
  const t = Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / lengthSquared));
  const closest = [BRAND[0] + t * ab[0], BRAND[1] + t * ab[1], BRAND[2] + t * ab[2]];
  return Math.hypot(pixel[0] - closest[0], pixel[1] - closest[1], pixel[2] - closest[2]);
}

function offBrandPixels(image) {
  let count = 0;
  let worst = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const pixel = image.at(x, y);
      if (!isOpaque(pixel)) continue;
      const distance = distanceToRamp(pixel);
      if (distance > 12) count += 1;
      if (distance > worst) worst = distance;
    }
  }
  return { count, worst };
}

/* ------------------------------------------------------------------- cases */

/**
 * `plate: true`  — an opaque brand-coloured tile (the OS shows this one as-is).
 * `plate: false` — a transparent foreground composited over `#2563EB`.
 */
const CASES = [
  { file: 'icon.png', size: 1024, plate: true, minMark: 0.3 },
  { file: 'favicon.png', size: 196, plate: true, minMark: 0.3 },
  { file: 'adaptive-icon.png', size: 1024, plate: false, minMark: 0.15 },
  { file: 'splash.png', size: 1024, plate: false, minMark: 0.1 },
];

let failures = 0;

function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
}

console.log('Mobile asset audit — apps/mobile/assets/\n');

for (const spec of CASES) {
  const path = join(assetsDir, spec.file);
  console.log(spec.file);

  let image;
  try {
    image = decodePng(readFileSync(path));
  } catch (error) {
    failures += 1;
    console.log(`  FAIL could not decode: ${error.message}\n`);
    continue;
  }

  check('dimensions', image.width === spec.size && image.height === spec.size,
    `${image.width}×${image.height}`);

  // Corners: a rounded plate is transparent there; a transparent layer is too.
  const corner = image.at(2, 2);
  check('corner transparent', isTransparent(corner), `alpha ${corner[3]}`);

  if (spec.plate) {
    // Top edge midpoint must be *inside* the plate — proves rounded, not round.
    const edge = image.at(Math.floor(spec.size / 2), 2);
    check('plate reaches edge midpoint', isOpaque(edge), `alpha ${edge[3]}`);
    check('plate is brand blue', same(edge, BRAND), hex(edge));
  } else {
    // Nothing but the glyph may be painted, or the composite shows a white box.
    const stray = image.at(Math.floor(spec.size / 2), 20);
    check('background fully transparent', isTransparent(stray), `alpha ${stray[3]}`);

    const opaque = bbox(image, isOpaque);
    check('only the glyph is opaque', opaque.count > 0 && opaque.count < image.width * image.height * 0.25,
      `${opaque.count} opaque px`);
  }

  const glyph = bbox(image, isOpaqueWhite);
  const markHeight = (glyph.maxY - glyph.minY + 1) / spec.size;
  check('glyph present', glyph.count > 0, `${glyph.count} px`);
  check('glyph size', markHeight >= spec.minMark, `${(markHeight * 100).toFixed(0)}% of canvas tall`);

  // The tofu test.
  const fill = middleRowFill(image, glyph);
  check('not a tofu box', fill > 0.5, `middle row ${(fill * 100).toFixed(0)}% inked`);

  const runs = stemRuns(image, glyph);
  check('two stems', runs === 2, `${runs} run(s) near the top`);

  if (spec.plate) {
    const { count, worst } = offBrandPixels(image);
    check('no off-brand ink', count === 0, `${count} px, worst distance ${worst.toFixed(1)}`);
  }

  console.log('');
}

console.log(failures === 0 ? 'PASS  all four assets decode and match the brand mark' : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
