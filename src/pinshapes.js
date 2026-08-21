// Geometry for the location marker.
//
// Every shape returns two things that have to agree with each other: the path
// drawn into the SVG, and a set of convex polygons covering the same area. The
// polygons are what gets subtracted from the streets underneath, so a knocked
// out word sits on bare slate — see src/clip.js for why they must be convex.

import { ellipsePolygon, roundedRectPolygon } from './clip.js';
import { roundedRectPath, ellipsePath, fmt } from './paths.js';

export const PIN_STYLES = [
  { id: 'disc', label: 'Disc', hint: 'A filled circle with the text knocked out' },
  { id: 'oval', label: 'Oval', hint: 'Stretches to fit the word, like the reference coaster' },
  { id: 'pill', label: 'Pill', hint: 'Rounded rectangle that grows with the text' },
  { id: 'heart', label: 'Heart', hint: 'Classic two-lobe heart' },
  { id: 'teardrop', label: 'Map pin', hint: 'Teardrop marker with a point' },
  { id: 'ring', label: 'Ring', hint: 'Outline only, text inside' },
  { id: 'dot', label: 'Dot', hint: 'A plain filled dot with no text' },
];

export const PIN_STYLE_IDS = new Set(PIN_STYLES.map((s) => s.id));

/** Styles that hold text at all. */
export const TEXT_STYLES = new Set(['disc', 'oval', 'pill', 'heart', 'teardrop', 'ring']);

/**
 * How wide a word each shape can carry per millimetre of radius.
 *
 * The round shapes cannot stretch without stopping being themselves, so they
 * grow as a whole instead: "Pin size" is a floor, and a long word raises it
 * rather than spilling over the edge.
 */
const TEXT_CAPACITY = {
  disc: 1.6,
  ring: 1.6,
  heart: 1.45,
  teardrop: 1.55,
};

/** The smallest radius at which `textWidth` still fits inside `style`. */
export function minRadiusForText(style, textWidth) {
  const capacity = TEXT_CAPACITY[style];
  return capacity && textWidth > 0 ? textWidth / capacity : 0;
}

const circlePolygon = (cx, cy, r, segments = 48) =>
  // Circumscribed, so the polygon contains the true circle instead of cutting
  // the corners off it and leaving a hairline of street under the edge.
  ellipsePolygon(cx, cy, r / Math.cos(Math.PI / segments), r / Math.cos(Math.PI / segments), segments);

function circlePath(cx, cy, r, decimals) {
  return ellipsePath(cx, cy, r, r, decimals);
}

/** Tangent point on a circle from an external point, on the requested side. */
function tangentPoint(cx, cy, r, px, py, side) {
  const dx = px - cx;
  const dy = py - cy;
  const dist = Math.hypot(dx, dy);
  if (dist <= r) return [cx + r * Math.sign(side || 1), cy];
  const theta = Math.atan2(dy, dx);
  const alpha = Math.acos(Math.min(1, r / dist));
  const a1 = theta + alpha;
  const a2 = theta - alpha;
  const p1 = [cx + r * Math.cos(a1), cy + r * Math.sin(a1)];
  const p2 = [cx + r * Math.cos(a2), cy + r * Math.sin(a2)];
  return side >= 0 ? (p1[0] >= p2[0] ? p1 : p2) : p1[0] <= p2[0] ? p1 : p2;
}

// ------------------------------------------------------------------ teardrop
function teardropGeometry(cx, cy, r, stem) {
  const tipY = cy + r + Math.max(0.1, stem);
  const right = tangentPoint(cx, cy, r, cx, tipY, 1);
  const left = tangentPoint(cx, cy, r, cx, tipY, -1);
  return { tip: [cx, tipY], right, left };
}

function teardropPath(cx, cy, r, stem, decimals) {
  const { tip, right, left } = teardropGeometry(cx, cy, r, stem);
  const f = (n) => fmt(n, decimals);
  return (
    `M${f(tip[0])} ${f(tip[1])}L${f(right[0])} ${f(right[1])}` +
    `A${f(r)} ${f(r)} 0 1 0 ${f(left[0])} ${f(left[1])}Z`
  );
}

// --------------------------------------------------------------------- heart
/**
 * A heart built from two overlapping lobes and a wedge running down to the tip.
 * `radius` is the half-width, so it lines up with every other style's sizing.
 */
function heartGeometry(cx, cy, radius) {
  const lobeR = radius * 0.55;
  const halfGap = radius * 0.45; // lobe centres sit at cx ± halfGap
  const lobeY = cy - radius * 0.3;
  const tipY = cy + radius * 0.98;
  const leftC = [cx - halfGap, lobeY];
  const rightC = [cx + halfGap, lobeY];
  const tip = [cx, tipY];
  // The lobes overlap, and their lower crossing point is the heart's top notch.
  const notchDy = Math.sqrt(Math.max(0, lobeR * lobeR - halfGap * halfGap));
  const notch = [cx, lobeY - notchDy];
  return {
    lobeR,
    leftC,
    rightC,
    tip,
    notch,
    rightTangent: tangentPoint(rightC[0], rightC[1], lobeR, tip[0], tip[1], 1),
    leftTangent: tangentPoint(leftC[0], leftC[1], lobeR, tip[0], tip[1], -1),
  };
}

function heartPath(cx, cy, radius, decimals) {
  const g = heartGeometry(cx, cy, radius);
  const f = (n) => fmt(n, decimals);
  const r = f(g.lobeR);
  return (
    `M${f(g.tip[0])} ${f(g.tip[1])}` +
    `L${f(g.rightTangent[0])} ${f(g.rightTangent[1])}` +
    `A${r} ${r} 0 1 0 ${f(g.notch[0])} ${f(g.notch[1])}` +
    `A${r} ${r} 0 1 0 ${f(g.leftTangent[0])} ${f(g.leftTangent[1])}Z`
  );
}

function heartPieces(cx, cy, radius) {
  const g = heartGeometry(cx, cy, radius);
  return [
    circlePolygon(g.leftC[0], g.leftC[1], g.lobeR, 40),
    circlePolygon(g.rightC[0], g.rightC[1], g.lobeR, 40),
    // The wedge below the lobes, plus the sliver the two chords leave behind.
    [g.tip, g.rightTangent, g.leftTangent],
    [g.leftTangent, g.leftC, g.rightC, g.rightTangent],
  ];
}

// ----------------------------------------------------------------- assembly
/**
 * @param {object} opts
 * @param {number} opts.textWidth  measured width of the pin's text, for the
 *   styles that stretch to hold it
 * @param {number} opts.grow  extra millimetres added to the knockout polygons
 * @returns {{path: string, pieces: Array, anchorX: number, anchorY: number,
 *   box: object, stroked: boolean}}
 */
export function buildPinShape(style, {
  cx,
  cy,
  radius,
  stemLength = 0,
  textWidth = 0,
  grow = 0,
  decimals = 3,
} = {}) {
  const R = Math.max(0.05, radius, minRadiusForText(style, textWidth));
  const g = Math.max(0, grow);
  const shape = { stroked: style === 'ring', anchorX: cx, anchorY: cy };

  switch (style) {
    case 'oval': {
      const ry = R;
      const rx = Math.max(R, textWidth / 2 + R * 0.5);
      shape.path = ellipsePath(cx, cy, rx, ry, decimals);
      shape.pieces = [ellipsePolygon(cx, cy, rx + g, ry + g, 64)];
      shape.box = { minX: cx - rx, maxX: cx + rx, minY: cy - ry, maxY: cy + ry };
      return shape;
    }
    case 'pill': {
      const h = R * 2;
      const w = Math.max(h, textWidth + R * 1.1);
      const rect = { x: cx - w / 2, y: cy - h / 2, w, h };
      shape.path = roundedRectPath(rect, h / 2, decimals);
      const grown = { x: rect.x - g, y: rect.y - g, w: w + g * 2, h: h + g * 2 };
      shape.pieces = [roundedRectPolygon(grown, grown.h / 2, 16)];
      shape.box = { minX: rect.x, maxX: rect.x + w, minY: rect.y, maxY: rect.y + h };
      return shape;
    }
    case 'heart': {
      shape.path = heartPath(cx, cy, R, decimals);
      // Growing the whole heart proportionally keeps the knockout outside the
      // drawn edge everywhere, which a uniform offset would not.
      shape.pieces = heartPieces(cx, cy, R + g);
      shape.anchorY = cy - R * 0.22;
      shape.box = { minX: cx - R, maxX: cx + R, minY: cy - R * 0.85, maxY: cy + R };
      return shape;
    }
    case 'teardrop': {
      const headY = cy;
      const geo = teardropGeometry(cx, headY, R, stemLength);
      shape.path = teardropPath(cx, headY, R, stemLength, decimals);
      const grownGeo = teardropGeometry(cx, headY, R + g, stemLength + g);
      shape.pieces = [
        circlePolygon(cx, headY, R + g, 48),
        [grownGeo.tip, grownGeo.right, grownGeo.left],
      ];
      shape.box = { minX: cx - R, maxX: cx + R, minY: headY - R, maxY: geo.tip[1] };
      return shape;
    }
    case 'ring':
    case 'dot':
    case 'disc':
    default: {
      shape.path = circlePath(cx, cy, R, decimals);
      shape.pieces = [circlePolygon(cx, cy, R + g, 48)];
      shape.box = { minX: cx - R, maxX: cx + R, minY: cy - R, maxY: cy + R };
      // The ring style needs its own filled-band version for laser export.
      shape.circle = { cx, cy, r: R };
      return shape;
    }
  }
}

/** Where the head of the marker sits relative to the point it marks. */
export function pinHeadOffset(style, radius, stemLength) {
  return style === 'teardrop' ? -(radius + Math.max(0.1, stemLength)) : 0;
}
