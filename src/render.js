// Builds the coaster as an SVG string. The same string drives the live preview
// and the exported file, so what you see really is what gets burned — only the
// colours and a few preview-only affordances differ.

import { LAYERS, LINE } from './layers.js';
import { buildPinShape, pinHeadOffset, TEXT_STYLES, minRadiusForText } from './pinshapes.js';
import { strokeOutlines } from './stroke.js';
import { ellipseBandPath } from './paths.js';
import { getLoadedFont, textCommands, commandsToPathData, rotationMatrix, applyTextCase, measureText } from './typography.js';

export const PREVIEW_THEMES = {
  slate: { id: 'slate', label: 'Slate (dark)', bg: '#3a3f43', ink: '#efece6', edge: '#22262a' },
  charcoal: { id: 'charcoal', label: 'Charcoal', bg: '#1e2124', ink: '#f6f3ed', edge: '#101214' },
  paper: { id: 'paper', label: 'Paper (light)', bg: '#f7f4ee', ink: '#15171a', edge: '#d8d2c6' },
  wood: { id: 'wood', label: 'Wood', bg: '#8a6236', ink: '#2b1a0d', edge: '#5d4023' },
};

/** Distinct colours so xTool / LightBurn can assign per-layer power and speed. */
export const EXPORT_LAYER_COLORS = {
  motorway: '#e6194b',
  primary: '#f58231',
  secondary: '#bfa300',
  tertiary: '#3cb44b',
  residential: '#4363d8',
  service: '#911eb4',
  path: '#42d4f4',
  rail: '#808080',
  water: '#000075',
  riverLine: '#0072b2',
  streamLine: '#56b4e9',
  buildings: '#800000',
  landuseGreen: '#469990',
  labels: '#f032e6',
  caption: '#111111',
  pin: '#9a6324',
  border: '#666600',
  cut: '#ff0000',
};

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);

function num(n, decimals) {
  const v = Number(n.toFixed(decimals));
  return Object.is(v, -0) ? 0 : v;
}

function linesToPathData(lines, decimals) {
  const out = [];
  for (const line of lines) {
    if (line.length < 2) continue;
    let d = `M${num(line[0][0], decimals)} ${num(line[0][1], decimals)}`;
    for (let i = 1; i < line.length; i++) {
      d += `L${num(line[i][0], decimals)} ${num(line[i][1], decimals)}`;
    }
    out.push(d);
  }
  return out.join('');
}

function ringsToPathData(areas, decimals) {
  const out = [];
  for (const area of areas) {
    for (const ring of [...area.outers, ...area.holes]) {
      if (ring.length < 3) continue;
      let d = `M${num(ring[0][0], decimals)} ${num(ring[0][1], decimals)}`;
      for (let i = 1; i < ring.length; i++) {
        d += `L${num(ring[i][0], decimals)} ${num(ring[i][1], decimals)}`;
      }
      out.push(d + 'Z');
    }
  }
  return out.join('');
}

/**
 * Geometry for the location marker, including the box labels must avoid.
 *
 * Built before rendering because label placement has to know where the marker
 * is, and the knockout has to know its exact outline.
 */
export function computePin(state, layout, projection) {
  const cfg = state.pin;
  if (!cfg.enabled) return null;
  const lat = cfg.followCentre ? state.location.lat : cfg.lat;
  const lon = cfg.followCentre ? state.location.lon : cfg.lon;
  const [x, y] = projection.project(lon, lat);

  const font = getLoadedFont(cfg.font, cfg.weight, cfg.italic);
  const wantsText = TEXT_STYLES.has(cfg.style) && Boolean(cfg.text);
  const text = wantsText ? applyTextCase(cfg.text, cfg.textCase) : '';
  const metrics = text && font ? measureText(font, text, cfg.textSize, cfg.tracking) : null;

  const textWidth = metrics ? metrics.width : 0;
  // A round shape that had to grow for its text hangs lower, so the head offset
  // has to be measured from the size it actually ended up.
  const effectiveRadius = Math.max(cfg.radius, minRadiusForText(cfg.style, textWidth));
  const headY = y + pinHeadOffset(cfg.style, effectiveRadius, cfg.stemLength);

  const shape = buildPinShape(cfg.style, {
    cx: x,
    cy: headY,
    radius: cfg.radius,
    stemLength: cfg.stemLength,
    textWidth,
    grow: cfg.clearSpace ? Math.max(0, cfg.clearance) : 0,
  });

  const box = {
    minX: shape.box.minX - 0.6,
    maxX: shape.box.maxX + 0.6,
    minY: shape.box.minY - 0.6,
    maxY: shape.box.maxY + 0.6,
  };

  // A pin whose coordinates are miles from the current view still "exists", it
  // is just drawn somewhere nobody can see. Saying so lets the UI offer a way
  // back instead of leaving the toggle looking broken.
  const view = layout.clip.bounds;
  const onMap = !(
    box.maxX < view.minX || box.minX > view.maxX || box.maxY < view.minY || box.minY > view.maxY
  );

  return { x, y, headY, lat, lon, text, metrics, font, shape, box, onMap };
}

function pinMarkup(state, pin, ink, asOutlines) {
  const cfg = state.pin;
  if (!pin) return '';
  const { shape } = pin;
  const parts = [];

  const textData =
    pin.text && pin.font
      ? commandsToPathData(
          textCommands(pin.font, pin.text, {
            x: shape.anchorX,
            y: shape.anchorY + (pin.metrics.capHeight || cfg.textSize * 0.7) / 2 + cfg.textOffsetY,
            size: cfg.textSize,
            tracking: cfg.tracking,
            align: 'middle',
          }),
          { decimals: 3 }
        )
      : '';

  if (cfg.style === 'ring') {
    const c = shape.circle;
    parts.push(
      asOutlines && c
        ? `<path d="${ellipseBandPath(c.cx, c.cy, c.r, cfg.strokeWidth)}" fill="${ink}" fill-rule="nonzero" stroke="none"/>`
        : `<path d="${shape.path}" fill="none" stroke="${ink}" stroke-width="${num(cfg.strokeWidth, 3)}"/>`
    );
    if (textData) parts.push(`<path d="${textData}" fill="${ink}"/>`);
    return parts.join('');
  }

  // Filled marker: knocking the text out keeps it legible on slate, where the
  // marker itself is the engraved (light) area.
  if (textData && cfg.knockout) {
    parts.push(`<path d="${shape.path}${textData}" fill="${ink}" fill-rule="evenodd"/>`);
  } else {
    parts.push(`<path d="${shape.path}" fill="${ink}"/>`);
    if (textData) parts.push(`<path d="${textData}" fill="${ink}"/>`);
  }
  return parts.join('');
}

function captionMarkup(layout, ink) {
  const parts = [];
  for (const line of layout.caption.lines) {
    const font = getLoadedFont(line.font, line.weight, line.italic);
    if (!font) continue;
    const anchor =
      (line.align === 'left'
        ? layout.caption.left
        : line.align === 'right'
          ? layout.caption.right
          : layout.caption.centerX) + (line.offsetX || 0);
    const align = line.align === 'left' ? 'start' : line.align === 'right' ? 'end' : 'middle';
    const baseline =
      layout.caption.top + line.offsetY + line.advance / 2 + (line.metrics.capHeight || line.size * 0.7) / 2;
    const d = commandsToPathData(
      textCommands(font, line.text, {
        x: anchor,
        y: baseline,
        size: line.size,
        tracking: line.tracking,
        align,
      }),
      { decimals: 3 }
    );
    if (d) parts.push(`<path d="${d}" fill="${ink}"/>`);
  }
  return parts.join('');
}

function labelMarkup(labels, settings, ink) {
  const font = getLoadedFont(settings.font, settings.weight, settings.italic);
  if (!font || !labels.length) return '';
  const parts = [];
  for (const label of labels) {
    const cmds = textCommands(font, label.text, {
      x: label.x,
      y: label.y,
      size: settings.size,
      tracking: settings.tracking,
      align: 'middle',
    });
    const matrix = label.angle ? rotationMatrix(label.angle, label.x, label.y) : null;
    const d = commandsToPathData(cmds, { decimals: 3, matrix });
    if (!d) continue;
    parts.push(`<path d="${d}" fill="${ink}"/>`);
  }
  return parts.join('');
}

/**
 * @param {object} opts
 * @param {'preview'|'export'} opts.mode
 * @returns {{ markup: string, stats: object }}
 */
export function renderSvg({ state, layout, projection, prepared, labels, pin, mode = 'preview' }) {
  const isExport = mode === 'export';
  const theme = PREVIEW_THEMES[state.style.previewTheme] || PREVIEW_THEMES.slate;
  const monoInk = isExport ? state.style.exportInk : theme.ink;
  const perLayer = isExport && state.style.exportColors === 'layers';
  const inkFor = (key) => (perLayer ? EXPORT_LAYER_COLORS[key] || monoInk : monoInk);
  const decimals = 2;
  const scale = state.detail.strokeScale;
  const cap = state.detail.lineCap;
  // Filled outlines rather than centre lines: see src/stroke.js. The preview
  // uses whichever the export will, so the two cannot drift apart.
  const asOutlines = state.style.geometry !== 'strokes';

  /** One layer's worth of centre lines, as either an outlined or stroked path. */
  const linework = (lines, ink, width) =>
    asOutlines
      ? `<path d="${strokeOutlines(lines, width, { cap, decimals: 3 })}" fill="${ink}" fill-rule="nonzero" stroke="none"/>`
      : `<path d="${linesToPathData(lines, decimals)}" fill="none" stroke="${ink}" stroke-width="${num(
          width,
          3
        )}" stroke-linecap="${cap}" stroke-linejoin="round"/>`;

  const groups = [];
  const stats = { paths: 0, segments: 0, layers: 0 };

  if (!isExport) {
    groups.push(
      `<g id="preview-face"><path d="${layout.coasterPath}" fill="${theme.bg}" stroke="${theme.edge}" stroke-width="0.4"/></g>`
    );
  }

  // Map layers, painted low order first.
  const mapParts = [];
  for (const layer of [...LAYERS].sort((a, b) => a.order - b.order)) {
    const bucket = prepared.byLayer.get(layer.id);
    if (!bucket) continue;
    const settings = state.layers[layer.id];
    const ink = inkFor(layer.id);
    const width = num(Math.max(0.01, settings.weight * scale), 3);

    if (layer.kind === LINE) {
      if (!bucket.lines.length) continue;
      stats.paths += 1;
      stats.segments += bucket.lines.length;
      stats.layers += 1;
      mapParts.push(
        `<g id="layer-${layer.id}" data-layer="${layer.id}"${
          isExport ? ` inkscape:groupmode="layer" inkscape:label="${esc(layer.label)}"` : ''
        }>${linework(bucket.lines, ink, width)}</g>`
      );
      continue;
    }

    const filled = settings.mode === 'fill';
    if (filled && !bucket.areas.length) continue;
    if (!filled && !bucket.outlines.length) continue;
    const body = filled
      ? `<path d="${ringsToPathData(bucket.areas, decimals)}" fill="${ink}" fill-rule="nonzero" stroke="none"/>`
      : linework(bucket.outlines, ink, width);
    stats.paths += 1;
    stats.segments += filled ? bucket.areas.length : bucket.outlines.length;
    stats.layers += 1;
    mapParts.push(
      `<g id="layer-${layer.id}" data-layer="${layer.id}"${
        isExport ? ` inkscape:groupmode="layer" inkscape:label="${esc(layer.label)}"` : ''
      }>${body}</g>`
    );
  }
  if (mapParts.length) groups.push(`<g id="map">${mapParts.join('')}</g>`);

  if (labels && labels.length) {
    const markup = labelMarkup(labels, state.labels, inkFor('labels'));
    if (markup) groups.push(`<g id="labels" data-role="labels">${markup}</g>`);
  }

  if (pin) {
    const markup = pinMarkup(state, pin, inkFor('pin'), asOutlines);
    if (markup) groups.push(`<g id="pin" data-role="pin">${markup}</g>`);
  }

  if (layout.borderPath) {
    const borderInk = inkFor('border');
    const body = asOutlines
      ? `<path d="${layout.borderBandPath}" fill="${borderInk}" fill-rule="nonzero" stroke="none"/>`
      : `<path d="${layout.borderPath}" fill="none" stroke="${borderInk}" stroke-width="${num(
          layout.borderWidth,
          3
        )}"/>`;
    groups.push(`<g id="border" data-role="border">${body}</g>`);
  }

  const caption = captionMarkup(layout, inkFor('caption'));
  if (caption) groups.push(`<g id="caption" data-role="caption">${caption}</g>`);

  if (layout.cutPath) {
    groups.push(
      `<g id="cut-line" data-role="cut"><path d="${layout.cutPath}" fill="none" stroke="${inkFor(
        'cut'
      )}" stroke-width="0.1"/></g>`
    );
  }

  const title = [state.location.label, state.location.region].filter(Boolean).join(', ') || 'City map coaster';
  const ns = isExport
    ? ' xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"'
    : ' xmlns="http://www.w3.org/2000/svg"';

  const header = isExport
    ? `<title>${esc(title)}</title><desc>${esc(
        `${title} — ${state.location.lat.toFixed(5)}, ${state.location.lon.toFixed(
          5
        )} · ${layout.width}×${layout.height} mm · map data © OpenStreetMap contributors (ODbL)`
      )}</desc>`
    : '';

  const markup =
    `<svg${ns} width="${layout.width}mm" height="${layout.height}mm" ` +
    `viewBox="0 0 ${num(layout.width, 3)} ${num(layout.height, 3)}" ` +
    `data-mm-width="${layout.width}" data-mm-height="${layout.height}">` +
    header +
    groups.join('') +
    '</svg>';

  return { markup, stats };
}
