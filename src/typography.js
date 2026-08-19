// Font loading and text-to-outline conversion.
//
// Every glyph on the coaster is exported as a filled path, never as an SVG
// <text> element: xTool Creative Space substitutes whatever font it feels like
// for live text, which silently ruins the caption. Converting here means the
// preview and the burn are the same shapes.

const FONT_DIR = 'assets/fonts';

export const FONTS = [
  { id: 'playfair-display', name: 'Playfair Display', note: 'High-contrast serif', weights: [400, 700], italic: true },
  { id: 'cormorant-garamond', name: 'Cormorant Garamond', note: 'Light elegant serif', weights: [400, 700], italic: true },
  { id: 'eb-garamond', name: 'EB Garamond', note: 'Classic book serif', weights: [400, 700], italic: true },
  { id: 'libre-baskerville', name: 'Libre Baskerville', note: 'Sturdy, engraves clean', weights: [400, 700], italic: true },
  { id: 'marcellus', name: 'Marcellus', note: 'Humanist, Optima-like', weights: [400], italic: false },
  { id: 'cinzel', name: 'Cinzel', note: 'Engraved Roman capitals', weights: [400, 700], italic: false },
  { id: 'montserrat', name: 'Montserrat', note: 'Clean geometric sans', weights: [400, 700], italic: true },
  { id: 'josefin-sans', name: 'Josefin Sans', note: 'Slim deco sans', weights: [400, 700], italic: true },
];

export const FONTS_BY_ID = new Map(FONTS.map((f) => [f.id, f]));

const cache = new Map();
const failed = new Set();

function variantFile(id, weight, italic) {
  const spec = FONTS_BY_ID.get(id);
  const w = spec && spec.weights.includes(weight) ? weight : 400;
  const style = italic && spec && spec.italic ? 'italic' : 'normal';
  // Only the 400 weight ships an italic cut, which is all a caption needs.
  const finalWeight = style === 'italic' ? 400 : w;
  return `${FONT_DIR}/${id}-${finalWeight}-${style}.woff`;
}

export function fontKey(id, weight, italic) {
  return `${id}|${weight}|${italic ? 'i' : 'n'}`;
}

/** Resolves to an opentype Font, or null when the file could not be used. */
export async function loadFont(id, weight = 400, italic = false) {
  const key = fontKey(id, weight, italic);
  if (cache.has(key)) return cache.get(key);
  if (failed.has(key)) return null;
  if (typeof opentype === 'undefined') return null;

  const promise = (async () => {
    const url = variantFile(id, weight, italic);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Font ${url} → HTTP ${res.status}`);
    return opentype.parse(await res.arrayBuffer());
  })();

  cache.set(key, promise);
  try {
    const font = await promise;
    cache.set(key, font);
    return font;
  } catch (err) {
    console.warn('Font load failed', key, err);
    cache.delete(key);
    failed.add(key);
    return null;
  }
}

export function getLoadedFont(id, weight = 400, italic = false) {
  const font = cache.get(fontKey(id, weight, italic));
  return font && typeof font.stringToGlyphs === 'function' ? font : null;
}

/** Preloads every variant the current design references. */
export async function preloadFonts(variants) {
  await Promise.all(variants.map(({ id, weight, italic }) => loadFont(id, weight, italic)));
}

export async function preloadAll() {
  const jobs = [];
  for (const spec of FONTS) {
    for (const weight of spec.weights) jobs.push(loadFont(spec.id, weight, false));
    if (spec.italic) jobs.push(loadFont(spec.id, 400, true));
  }
  await Promise.all(jobs);
}

function layoutGlyphs(font, text, size, tracking) {
  const scale = size / font.unitsPerEm;
  const glyphs = font.stringToGlyphs(text);
  const placed = [];
  let x = 0;
  let prev = null;
  for (const glyph of glyphs) {
    if (prev) x += font.getKerningValue(prev, glyph) * scale;
    placed.push({ glyph, x });
    x += glyph.advanceWidth * scale + tracking;
    prev = glyph;
  }
  // Trailing tracking is not part of the visible run.
  const width = placed.length ? x - tracking : 0;
  return { placed, width, scale };
}

/**
 * Metrics for one line of text.
 * `tracking` is extra letter-spacing in the same units as `size` (millimetres).
 */
export function measureText(font, text, size, tracking = 0) {
  if (!font || !text) return { width: 0, ascent: size * 0.75, descent: size * 0.25 };
  const { width } = layoutGlyphs(font, text, size, tracking);
  const scale = size / font.unitsPerEm;
  return {
    width,
    ascent: font.ascender * scale,
    descent: Math.abs(font.descender * scale),
    capHeight: (font.tables.os2?.sCapHeight || font.ascender * 0.7) * scale,
  };
}

/**
 * Glyph outlines for a line of text as opentype path commands, with the
 * baseline at (x, y). `align` shifts the run: start | middle | end.
 */
export function textCommands(font, text, { x = 0, y = 0, size = 10, tracking = 0, align = 'start' } = {}) {
  if (!font || !text) return [];
  const { placed, width } = layoutGlyphs(font, text, size, tracking);
  let originX = x;
  if (align === 'middle') originX -= width / 2;
  else if (align === 'end') originX -= width;

  const commands = [];
  for (const { glyph, x: dx } of placed) {
    commands.push(...glyph.getPath(originX + dx, y, size).commands);
  }
  return commands;
}

/**
 * Serialises path commands, optionally baking in an affine transform.
 *
 * Rotations are baked into the coordinates rather than emitted as a
 * `transform` attribute: some laser importers drop transforms on paths, which
 * would silently stack every rotated street label at the origin.
 */
export function commandsToPathData(commands, { decimals = 3, matrix = null } = {}) {
  const f = (n) => {
    const v = Number(n.toFixed(decimals));
    return Object.is(v, -0) ? 0 : v;
  };
  const tx = matrix
    ? (px, py) => [matrix.a * px + matrix.c * py + matrix.e, matrix.b * px + matrix.d * py + matrix.f]
    : (px, py) => [px, py];

  const out = [];
  for (const cmd of commands) {
    if (cmd.type === 'M') {
      const [x, y] = tx(cmd.x, cmd.y);
      out.push(`M${f(x)} ${f(y)}`);
    } else if (cmd.type === 'L') {
      const [x, y] = tx(cmd.x, cmd.y);
      out.push(`L${f(x)} ${f(y)}`);
    } else if (cmd.type === 'C') {
      const [x1, y1] = tx(cmd.x1, cmd.y1);
      const [x2, y2] = tx(cmd.x2, cmd.y2);
      const [x, y] = tx(cmd.x, cmd.y);
      out.push(`C${f(x1)} ${f(y1)} ${f(x2)} ${f(y2)} ${f(x)} ${f(y)}`);
    } else if (cmd.type === 'Q') {
      const [x1, y1] = tx(cmd.x1, cmd.y1);
      const [x, y] = tx(cmd.x, cmd.y);
      out.push(`Q${f(x1)} ${f(y1)} ${f(x)} ${f(y)}`);
    } else if (cmd.type === 'Z') {
      out.push('Z');
    }
  }
  return out.join('');
}

/** Rotation about (cx, cy), in degrees, as an affine matrix. */
export function rotationMatrix(angleDeg, cx, cy) {
  const a = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return { a: cos, b: sin, c: -sin, d: cos, e: cx - cx * cos + cy * sin, f: cy - cx * sin - cy * cos };
}

/** Convenience wrapper: text straight to path data. */
export function textToPathData(font, text, options = {}) {
  const { decimals = 3, matrix = null, ...rest } = options;
  return commandsToPathData(textCommands(font, text, rest), { decimals, matrix });
}

/** Uppercase / lowercase / small-caps-ish transforms offered in the UI. */
export function applyTextCase(text, mode) {
  if (mode === 'upper') return text.toUpperCase();
  if (mode === 'lower') return text.toLowerCase();
  if (mode === 'title') {
    return text.replace(/\b\p{L}[\p{L}'’]*/gu, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
  }
  return text;
}

/** CSS @font-face rules so the control panel can preview each family. */
export function fontFaceCss() {
  const rules = [];
  for (const spec of FONTS) {
    for (const weight of spec.weights) {
      rules.push(
        `@font-face{font-family:'${spec.name}';font-style:normal;font-weight:${weight};font-display:swap;src:url('${FONT_DIR}/${spec.id}-${weight}-normal.woff') format('woff');}`
      );
    }
    if (spec.italic) {
      rules.push(
        `@font-face{font-family:'${spec.name}';font-style:italic;font-weight:400;font-display:swap;src:url('${FONT_DIR}/${spec.id}-400-italic.woff') format('woff');}`
      );
    }
  }
  return rules.join('\n');
}
