// Builds the shapes that get punched out of the map: the location pin and,
// optionally, a clear panel behind every street or place label.

import { createKnockout, roundedRectPolygon } from './clip.js';

function rotatePoints(points, angleDeg, cx, cy) {
  if (!angleDeg) return points;
  const a = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return points.map(([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
  });
}

export function buildKnockouts({ state, pin, labels, worldBounds }) {
  const shapes = [];

  if (pin && state.pin.clearSpace) {
    // The marker's own convex decomposition, already grown by the clearance —
    // a heart or a teardrop needs several pieces to cover it.
    for (const piece of pin.shape.pieces) {
      shapes.push(createKnockout(piece, worldBounds));
    }
  }

  if (labels && labels.length && state.labels.clearSpace) {
    const pad = Math.max(0, state.labels.haloMm);
    for (const label of labels) {
      const w = label.width + pad * 2;
      const h = label.capHeight + pad * 2;
      const rect = { x: label.x - w / 2, y: label.y - label.capHeight / 2 - h / 2, w, h };
      const poly = roundedRectPolygon(rect, Math.min(h / 2, pad + label.capHeight * 0.28), 5);
      shapes.push(createKnockout(rotatePoints(poly, label.angle, label.x, label.y), worldBounds));
    }
  }

  return shapes;
}
