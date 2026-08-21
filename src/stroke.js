// Converts stroked centre lines into closed filled outlines.
//
// Laser software is the reason this exists. xTool Creative Space imports an SVG
// as paths and discards `stroke-width` entirely, so a 0.6 mm road arrives as a
// hairline and a stroked border arrives as nothing worth engraving. A shape
// with real area cannot be misread that way: whatever the importer does with
// it, the width you designed is in the geometry.
//
// Every outline is traced in a single rotational direction and filled with the
// nonzero rule, so the loops that self-intersect on the inside of a sharp bend
// reinforce rather than cancel.

import { fmt } from './paths.js';

function dedupe(points) {
  const out = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - point[0]) > 1e-9 || Math.abs(last[1] - point[1]) > 1e-9) {
      out.push(point);
    }
  }
  return out;
}

/** Wound the same way as the traced outlines, so nonzero fill unions them. */
function circlePath(cx, cy, r, d) {
  const f = (n) => fmt(n, d);
  return (
    `M${f(cx - r)} ${f(cy)}` +
    `A${f(r)} ${f(r)} 0 0 0 ${f(cx + r)} ${f(cy)}` +
    `A${f(r)} ${f(r)} 0 0 0 ${f(cx - r)} ${f(cy)}Z`
  );
}

/**
 * Outline of one stroked polyline.
 *
 * @param {Array<[number, number]>} points centre line in millimetres
 * @param {number} width stroke width in millimetres
 * @param {'round'|'butt'|'square'} cap how the ends are finished
 * @returns {string} closed SVG path data, or '' for nothing drawable
 */
export function strokeOutline(points, width, { cap = 'round', decimals = 3 } = {}) {
  const r = Math.max(width, 1e-4) / 2;
  const pts = dedupe(points);
  if (!pts.length) return '';
  if (pts.length === 1) {
    return cap === 'butt' ? '' : circlePath(pts[0][0], pts[0][1], r, decimals);
  }

  const f = (n) => fmt(n, decimals);
  const arcR = `${f(r)} ${f(r)}`;
  // Side A is the left-hand offset; every arc below turns the same way, which
  // is what keeps the traced ring consistently wound.
  const dirs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0];
    const dy = pts[i + 1][1] - pts[i][1];
    const len = Math.hypot(dx, dy);
    dirs.push([dx / len, dy / len]);
  }
  const normal = (i) => [-dirs[i][1], dirs[i][0]];
  const offset = (pointIndex, segIndex, sign) => {
    const n = normal(segIndex);
    return [pts[pointIndex][0] + n[0] * r * sign, pts[pointIndex][1] + n[1] * r * sign];
  };
  const turn = (i) => dirs[i][0] * dirs[i + 1][1] - dirs[i][1] * dirs[i + 1][0];

  const parts = [];
  const moveTo = (p) => parts.push(`M${f(p[0])} ${f(p[1])}`);
  const lineTo = (p) => parts.push(`L${f(p[0])} ${f(p[1])}`);
  const arcTo = (p) => parts.push(`A${arcR} 0 0 0 ${f(p[0])} ${f(p[1])}`);

  const last = pts.length - 1;
  const lastSeg = dirs.length - 1;

  moveTo(offset(0, 0, 1));
  for (let i = 0; i < dirs.length; i++) {
    lineTo(offset(i + 1, i, 1));
    if (i < dirs.length - 1) {
      const next = offset(i + 1, i + 1, 1);
      // Side A is the outside of the bend when the path turns away from it.
      if (turn(i) < 0) arcTo(next);
      else lineTo(next);
    }
  }

  // End cap.
  if (cap === 'round') {
    arcTo(offset(last, lastSeg, -1));
  } else if (cap === 'square') {
    const d = dirs[lastSeg];
    const n = normal(lastSeg);
    lineTo([pts[last][0] + n[0] * r + d[0] * r, pts[last][1] + n[1] * r + d[1] * r]);
    lineTo([pts[last][0] - n[0] * r + d[0] * r, pts[last][1] - n[1] * r + d[1] * r]);
    lineTo(offset(last, lastSeg, -1));
  } else {
    lineTo(offset(last, lastSeg, -1));
  }

  for (let i = dirs.length - 1; i >= 0; i--) {
    lineTo(offset(i, i, -1));
    if (i > 0) {
      const next = offset(i, i - 1, -1);
      if (turn(i - 1) > 0) arcTo(next);
      else lineTo(next);
    }
  }

  // Start cap, closing the ring back where it began.
  if (cap === 'round') {
    arcTo(offset(0, 0, 1));
  } else if (cap === 'square') {
    const d = dirs[0];
    const n = normal(0);
    lineTo([pts[0][0] - n[0] * r - d[0] * r, pts[0][1] - n[1] * r - d[1] * r]);
    lineTo([pts[0][0] + n[0] * r - d[0] * r, pts[0][1] + n[1] * r - d[1] * r]);
  }
  parts.push('Z');
  return parts.join('');
}

/** Outlines for a whole layer's worth of centre lines, as one path's data. */
export function strokeOutlines(lines, width, options) {
  const parts = [];
  for (const line of lines) {
    const d = strokeOutline(line, width, options);
    if (d) parts.push(d);
  }
  return parts.join('');
}

export { circlePath as strokeDotPath };
