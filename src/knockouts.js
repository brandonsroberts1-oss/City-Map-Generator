// Builds the shapes that get punched out of the map: the location pin and,
// optionally, a clear panel behind every street or place label.

import { createKnockout, ellipsePolygon, roundedRectPolygon } from './clip.js';

const PIN_SEGMENTS = 48;

/**
 * A polygon that *contains* the circle rather than sitting inside it.
 *
 * The pin itself is drawn as a true SVG arc, so an inscribed approximation
 * would leave a hairline of engraved street peeking out from under its edge.
 */
function circumscribedCircle(cx, cy, r, segments = PIN_SEGMENTS) {
  return ellipsePolygon(cx, cy, r / Math.cos(Math.PI / segments), r / Math.cos(Math.PI / segments), segments);
}

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

/** Triangle joining the pin tip to the two tangent points on its head. */
function teardropStemPolygon(cx, cy, r, stem) {
  const tipY = cy + r + Math.max(0.1, stem);
  const d = tipY - cy;
  const alpha = Math.acos(Math.min(1, r / d));
  const a1 = Math.PI / 2 - alpha;
  const a2 = Math.PI / 2 + alpha;
  return [
    [cx, tipY],
    [cx + r * Math.cos(a1), cy + r * Math.sin(a1)],
    [cx + r * Math.cos(a2), cy + r * Math.sin(a2)],
  ];
}

export function buildKnockouts({ state, pin, labels, worldBounds }) {
  const shapes = [];

  if (pin && state.pin.clearSpace) {
    const clearance = Math.max(0, state.pin.clearance);
    const r = state.pin.radius + clearance;
    shapes.push(createKnockout(circumscribedCircle(pin.x, pin.headY, r), worldBounds));
    if (state.pin.style === 'teardrop') {
      const stem = teardropStemPolygon(pin.x, pin.headY, r, state.pin.stemLength);
      shapes.push(createKnockout(stem, worldBounds));
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
