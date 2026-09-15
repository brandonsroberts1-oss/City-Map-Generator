// Places the optional street / park / water names.
//
// Labels are laid out as straight runs rotated to the local bearing rather than
// bent along a <textPath>: curved text is a nightmare for laser software, and
// at coaster scale a straight run over the middle of a street reads better.

import { measureText, getLoadedFont, applyTextCase } from './typography.js';

const PRIORITY = {
  motorway: 100,
  primary: 80,
  secondary: 60,
  tertiary: 40,
  residential: 20,
  water: 90,
  riverLine: 85,
  streamLine: 30,
  landuseGreen: 50,
};

function insideClip(clip, x, y) {
  for (const edge of clip.edges) {
    if (edge.nx * x + edge.ny * y + edge.c < 0) return false;
  }
  return true;
}

/** Point at a given arc-length along a polyline, plus the local direction. */
function sampleAlong(points, targetDistance) {
  let travelled = 0;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    const segment = Math.hypot(x1 - x0, y1 - y0);
    if (travelled + segment >= targetDistance || i === points.length - 1) {
      const t = segment === 0 ? 0 : (targetDistance - travelled) / segment;
      return {
        x: x0 + (x1 - x0) * t,
        y: y0 + (y1 - y0) * t,
        angle: (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI,
      };
    }
    travelled += segment;
  }
  const last = points[points.length - 1];
  return { x: last[0], y: last[1], angle: 0 };
}

function rotatedBounds(cx, cy, width, height, angleDeg) {
  const a = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const hw = width / 2;
  const hh = height / 2;
  const dx = Math.abs(hw * cos) + Math.abs(hh * sin);
  const dy = Math.abs(hw * sin) + Math.abs(hh * cos);
  return { minX: cx - dx, maxX: cx + dx, minY: cy - dy, maxY: cy + dy };
}

function overlaps(a, b, padding) {
  return !(
    a.maxX + padding < b.minX ||
    a.minX - padding > b.maxX ||
    a.maxY + padding < b.minY ||
    a.minY - padding > b.maxY
  );
}

/**
 * @param {Array} candidates from prepareFeatures
 * @param {object} opts { clip, settings, reserved } — `reserved` are boxes
 *   (the pin, for instance) that labels must keep clear of.
 */
export function placeLabels(candidates, { clip, settings, reserved = [] }) {
  const font = getLoadedFont(settings.font, settings.weight, settings.italic);
  if (!font) return [];

  const wanted = new Set();
  if (settings.streets) wanted.add('streets');
  if (settings.water) wanted.add('water');
  if (settings.parks) wanted.add('parks');
  if (!wanted.size) return [];

  const bestByName = new Map();
  for (const cand of candidates) {
    if (!wanted.has(cand.category)) continue;
    // A point label (a lake name from a vector tile, say) has no length to
    // measure, so the size filter does not apply to it.
    if (cand.length != null && cand.length < settings.minFeatureMm) continue;
    const key = `${cand.category}:${cand.name.toLowerCase()}`;
    const score = (PRIORITY[cand.layerId] || 10) * 1000 + (cand.length || 0);
    const existing = bestByName.get(key);
    if (!existing || score > existing.score) bestByName.set(key, { ...cand, score });
  }

  const ordered = [...bestByName.values()].sort((a, b) => b.score - a.score);
  const placed = [];
  const boxes = reserved.slice();
  const padding = settings.size * 0.35;

  for (const cand of ordered) {
    if (placed.length >= settings.maxLabels) break;
    const text = applyTextCase(cand.name, settings.textCase);
    const metrics = measureText(font, text, settings.size, settings.tracking);
    if (metrics.width <= 0) continue;

    let x;
    let y;
    let angle = 0;

    if (cand.kind === 'line') {
      if (cand.length == null) continue;
      // A label needs a straight-ish run at least as long as the text.
      if (cand.length < metrics.width * 1.15) continue;
      const sample = sampleAlong(cand.points, cand.length / 2);
      x = sample.x;
      y = sample.y;
      angle = sample.angle;
      if (angle > 90) angle -= 180;
      else if (angle < -90) angle += 180;
    } else {
      [x, y] = cand.anchor;
      y += metrics.capHeight / 2;
    }

    const height = settings.size * 1.05;
    const box = rotatedBounds(x, y - metrics.capHeight / 2, metrics.width, height, angle);
    if (
      !insideClip(clip, box.minX, box.minY) ||
      !insideClip(clip, box.maxX, box.minY) ||
      !insideClip(clip, box.minX, box.maxY) ||
      !insideClip(clip, box.maxX, box.maxY)
    ) {
      continue;
    }
    if (boxes.some((b) => overlaps(box, b, padding))) continue;

    boxes.push(box);
    placed.push({
      text,
      x,
      y,
      angle,
      width: metrics.width,
      capHeight: metrics.capHeight || settings.size * 0.7,
      category: cand.category,
    });
  }

  return placed;
}

export { rotatedBounds };
