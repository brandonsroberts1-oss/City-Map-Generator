// Builds the coaster as an SVG string. The same string drives the live preview
// and the exported file, so what you see really is what gets burned — only the
// colours and a few preview-only affordances differ.

import { LAYERS, LINE } from './layers.js';
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

function circlePathData(cx, cy, r, decimals = 3) {
  const f = (n) => num(n, decimals);
  return (
    `M${f(cx - r)} ${f(cy)}` +
    `A${f(r)} ${f(r)} 0 0 1 ${f(cx + r)} ${f(cy)}` +
    `A${f(r)} ${f(r)} 0 0 1 ${f(cx - r)} ${f(cy)}Z`
  );
}

/** Classic teardrop marker: a disc with tangent lines running down to a tip. */
function teardropPathData(cx, cy, r, stem, decimals = 3) {
  const f = (n) => num(n, decimals);
  const tipY = cy + r + Math.max(0.1, stem);
  const d = tipY - cy;
  const alpha = Math.acos(Math.min(1, r / d));
  const theta = Math.PI / 2;
  const a1 = theta - alpha;
  const a2 = theta + alpha;
  const p1 = [cx + r * Math.cos(a1), cy + r * Math.sin(a1)];
  const p2 = [cx + r * Math.cos(a2), cy + r * Math.sin(a2)];
  return (
    `M${f(cx)} ${f(tipY)}L${f(p1[0])} ${f(p1[1])}` +
    `A${f(r)} ${f(r)} 0 1 0 ${f(p2[0])} ${f(p2[1])}Z`
  );
}

/**
 * Geometry for the location marker, including the box labels must avoid.
 * Returned separately from rendering so label placement can run first.
 */
export function computePin(state, layout, projection) {
  const pin = state.pin;
  if (!pin.enabled) return null;
  const lat = pin.followCentre ? state.location.lat : pin.lat;
  const lon = pin.followCentre ? state.location.lon : pin.lon;
  const [x, y] = projection.project(lon, lat);

  const font = getLoadedFont(pin.font, pin.weight, pin.italic);
  const text = pin.text ? applyTextCase(pin.text, pin.textCase) : '';
  const metrics = text && font ? measureText(font, text, pin.textSize, pin.tracking) : null;

  const isTeardrop = pin.style === 'teardrop';
  const headY = isTeardrop ? y - pin.radius - pin.stemLength : y;
  const bottom = isTeardrop ? y : y + pin.radius;

  return {
    x,
    y,
    headY,
    lat,
    lon,
    text,
    metrics,
    font,
    box: {
      minX: x - pin.radius - 0.6,
      maxX: x + pin.radius + 0.6,
      minY: headY - pin.radius - 0.6,
      maxY: bottom + 0.6,
    },
  };
}

function pinMarkup(state, pin, ink, decimals) {
  const cfg = state.pin;
  if (!pin) return '';
  const parts = [];
  const cx = pin.x;
  const cy = pin.headY;

  const textCmds =
    pin.text && pin.font
      ? textCommands(pin.font, pin.text, {
          x: cx,
          y: cy + (pin.metrics.capHeight || cfg.textSize * 0.7) / 2,
          size: cfg.textSize,
          tracking: cfg.tracking,
          align: 'middle',
        })
      : [];
  const textData = textCmds.length ? commandsToPathData(textCmds, { decimals: 3 }) : '';

  if (cfg.style === 'dot') {
    parts.push(`<path d="${circlePathData(cx, cy, cfg.radius, decimals)}" fill="${ink}"/>`);
    return parts.join('');
  }

  const shape =
    cfg.style === 'teardrop'
      ? teardropPathData(cx, cy, cfg.radius, cfg.stemLength, decimals)
      : circlePathData(cx, cy, cfg.radius, decimals);

  if (cfg.style === 'ring') {
    parts.push(
      `<path d="${shape}" fill="none" stroke="${ink}" stroke-width="${num(cfg.strokeWidth, 3)}"/>`
    );
    if (textData) parts.push(`<path d="${textData}" fill="${ink}"/>`);
    return parts.join('');
  }

  // Filled marker: knocking the text out of the disc keeps it legible on slate,
  // where the disc itself is the engraved (light) area.
  if (textData && cfg.knockout) {
    parts.push(`<path d="${shape}${textData}" fill="${ink}" fill-rule="evenodd"/>`);
  } else {
    parts.push(`<path d="${shape}" fill="${ink}"/>`);
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
      line.align === 'left' ? layout.caption.left : line.align === 'right' ? layout.caption.right : layout.caption.centerX;
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
      const d = linesToPathData(bucket.lines, decimals);
      if (!d) continue;
      stats.paths += 1;
      stats.segments += bucket.lines.length;
      stats.layers += 1;
      mapParts.push(
        `<g id="layer-${layer.id}" data-layer="${layer.id}"${
          isExport ? ` inkscape:groupmode="layer" inkscape:label="${esc(layer.label)}"` : ''
        }><path d="${d}" fill="none" stroke="${ink}" stroke-width="${width}" stroke-linecap="${cap}" stroke-linejoin="round"/></g>`
      );
      continue;
    }

    const filled = settings.mode === 'fill';
    const d = filled
      ? ringsToPathData(bucket.areas, decimals)
      : linesToPathData(bucket.outlines, decimals);
    if (!d) continue;
    stats.paths += 1;
    stats.segments += filled ? bucket.areas.length : bucket.outlines.length;
    stats.layers += 1;
    const shapeAttrs = filled
      ? `fill="${ink}" fill-rule="nonzero" stroke="none"`
      : `fill="none" stroke="${ink}" stroke-width="${width}" stroke-linecap="${cap}" stroke-linejoin="round"`;
    mapParts.push(
      `<g id="layer-${layer.id}" data-layer="${layer.id}"${
        isExport ? ` inkscape:groupmode="layer" inkscape:label="${esc(layer.label)}"` : ''
      }><path d="${d}" ${shapeAttrs}/></g>`
    );
  }
  if (mapParts.length) groups.push(`<g id="map">${mapParts.join('')}</g>`);

  if (labels && labels.length) {
    const markup = labelMarkup(labels, state.labels, inkFor('labels'));
    if (markup) groups.push(`<g id="labels" data-role="labels">${markup}</g>`);
  }

  if (pin) {
    const markup = pinMarkup(state, pin, inkFor('pin'), decimals);
    if (markup) groups.push(`<g id="pin" data-role="pin">${markup}</g>`);
  }

  if (layout.borderPath) {
    groups.push(
      `<g id="border" data-role="border"><path d="${layout.borderPath}" fill="none" stroke="${inkFor(
        'border'
      )}" stroke-width="${num(layout.borderWidth, 3)}"/></g>`
    );
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
