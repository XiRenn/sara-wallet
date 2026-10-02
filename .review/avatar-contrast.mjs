/**
 * Finds the highest HSL lightness at which white text still clears WCAG AA
 * (4.5:1) on *every* hue at a given saturation.
 *
 * The avatar fill is hashed, so the hue is not known ahead of time — the
 * guarantee has to hold for all 360 of them, not for a sample. Yellow-ish hues
 * are the binding case: they are far brighter than blue at the same lightness.
 */

function hslToRgb(hue, saturation, lightness) {
  const s = saturation / 100;
  const l = lightness / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const secondary = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const match = l - chroma / 2;

  const [r, g, b] =
    hue < 60
      ? [chroma, secondary, 0]
      : hue < 120
        ? [secondary, chroma, 0]
        : hue < 180
          ? [0, chroma, secondary]
          : hue < 240
            ? [0, secondary, chroma]
            : hue < 300
              ? [secondary, 0, chroma]
              : [chroma, 0, secondary];

  return [r, g, b].map((value) => Math.round((value + match) * 255));
}

const channel = (v) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

function luminance([r, g, b]) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contrast of white text on this fill. */
function whiteContrast(rgb) {
  return 1.05 / (luminance(rgb) + 0.05);
}

/** Contrast of near-black text on this fill. */
function blackContrast(rgb) {
  return (luminance(rgb) + 0.05) / 0.05;
}

const SATURATION = 66;

console.log('saturation 66% — worst hue at each lightness\n');
console.log('  L%   white-on-fill   black-on-fill');
for (const l of [45, 42, 40, 38, 36, 34, 32, 30, 28, 26]) {
  let worstWhite = Infinity;
  let worstBlack = Infinity;
  let worstWhiteHue = 0;

  for (let hue = 0; hue < 360; hue += 1) {
    const rgb = hslToRgb(hue, SATURATION, l);
    const w = whiteContrast(rgb);
    if (w < worstWhite) {
      worstWhite = w;
      worstWhiteHue = hue;
    }
    worstBlack = Math.min(worstBlack, blackContrast(rgb));
  }

  const whiteOk = worstWhite >= 4.5 ? 'AA' : worstWhite >= 3 ? 'AA-large only' : 'fails';
  console.log(
    `  ${String(l).padStart(2)}   ${worstWhite.toFixed(2)}:1 (hue ${String(worstWhiteHue).padStart(3)}) ${whiteOk.padEnd(14)} ${worstBlack.toFixed(2)}:1`,
  );
}

// The answer we actually want.
for (let l = 45; l >= 20; l -= 0.5) {
  let worst = Infinity;
  for (let hue = 0; hue < 360; hue += 1) {
    worst = Math.min(worst, whiteContrast(hslToRgb(hue, SATURATION, l)));
  }
  if (worst >= 4.5) {
    console.log(`\nHighest lightness with white text at 4.5:1 for all hues: ${l}%  (worst ${worst.toFixed(2)}:1)`);
    break;
  }
}

/* -------------------------------------------------------------------------- */
/* The alternative: a soft tinted fill with dark text                          */
/* -------------------------------------------------------------------------- */

console.log('\nsoft tint — background L / text L, worst hue across all 360\n');
console.log('  bgL  textL   worst contrast');
for (const bgL of [94, 92, 90, 88, 86]) {
  for (const textL of [32, 30, 28, 26, 24]) {
    let worst = Infinity;
    let worstHue = 0;
    for (let hue = 0; hue < 360; hue += 1) {
      const bg = hslToRgb(hue, SATURATION, bgL);
      const fg = hslToRgb(hue, SATURATION, textL);
      const a = luminance(bg);
      const b = luminance(fg);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      if (ratio < worst) {
        worst = ratio;
        worstHue = hue;
      }
    }
    const verdict = worst >= 4.5 ? 'AA' : worst >= 3 ? 'AA-large only' : 'fails';
    console.log(
      `  ${String(bgL).padStart(3)}  ${String(textL).padStart(4)}   ${worst.toFixed(2)}:1 (hue ${String(worstHue).padStart(3)}) ${verdict}`,
    );
  }
  console.log('');
}

/* -------------------------------------------------------------------------- */
/* What the desktop preview actually renders                                   */
/* -------------------------------------------------------------------------- */

/** Worst-case ink/fill contrast for a tinted avatar across all 360 hues. */
function worstTint(saturation, fillL, inkL) {
  let worst = Infinity;
  let worstHue = 0;
  for (let hue = 0; hue < 360; hue += 1) {
    const a = luminance(hslToRgb(hue, saturation, fillL));
    const b = luminance(hslToRgb(hue, saturation, inkL));
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    if (ratio < worst) {
      worst = ratio;
      worstHue = hue;
    }
  }
  return { worst, worstHue };
}

console.log('\ntinted avatar candidates\n');
console.log('  theme   sat  fill  ink    worst contrast');
const CANDIDATES = [
  ['light', 66, 90, 26],
  ['dark', 62, 22, 82],
  ['dark', 62, 24, 84],
  ['dark', 62, 26, 86],
  ['dark', 62, 20, 80],
];
for (const [theme, sat, fill, ink] of CANDIDATES) {
  const { worst, worstHue } = worstTint(sat, fill, ink);
  const verdict = worst >= 4.5 ? 'AA' : worst >= 3 ? 'AA-large only' : 'fails';
  console.log(
    `  ${theme.padEnd(7)} ${String(sat).padStart(3)}  ${String(fill).padStart(3)}%  ${String(ink).padStart(3)}%   ${worst.toFixed(2)}:1 (hue ${String(worstHue).padStart(3)}) ${verdict}`,
  );
}

// The counterparties in apps/desktop/design/preview.template.html. The desktop
// paints `.debt-avatar` as hsl(hue 66% 45%) with `color: #fff`, and its
// preview suite only asserts that the avatars are *distinct* — it never checks
// that the initial on them is readable.
function hashString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}
const hueOf = (name) => (hashString(name) * 137) % 360;

const PREVIEW_NAMES = ['Ko Aung', 'Daw Hla', 'Su Su', 'Nok', 'Shop'];

console.log('desktop .debt-avatar as shipped — white text on hsl(hue 66% 45%)\n');
let worstPreview = Infinity;
for (const name of PREVIEW_NAMES) {
  const hue = hueOf(name);
  const rgb = hslToRgb(hue, SATURATION, 45);
  const ratio = whiteContrast(rgb);
  worstPreview = Math.min(worstPreview, ratio);
  const verdict = ratio >= 4.5 ? 'AA' : ratio >= 3 ? 'AA-large only' : 'FAILS AA';
  console.log(
    `  ${name.padEnd(9)} hue ${String(hue).padStart(3)}  ${ratio.toFixed(2)}:1  ${verdict}`,
  );
}
console.log(`\n  worst of the preview: ${worstPreview.toFixed(2)}:1`);
