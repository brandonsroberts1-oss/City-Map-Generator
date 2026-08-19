// Ramer-Douglas-Peucker simplification, run in millimetre space so the
// tolerance means something physical: 0.05 mm of deviation is finer than any
// diode laser can resolve, but dropping those points can halve the file size.

function perpendicularDistanceSq(p, a, b) {
  let dx = b[0] - a[0];
  let dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    dx = p[0] - a[0];
    dy = p[1] - a[1];
    return dx * dx + dy * dy;
  }
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const ex = a[0] + t * dx - p[0];
  const ey = a[1] + t * dy - p[1];
  return ex * ex + ey * ey;
}

export function simplify(points, tolerance) {
  if (tolerance <= 0 || points.length < 3) return points;
  const tolSq = tolerance * tolerance;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    if (last - first < 2) continue;
    let maxDistSq = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = perpendicularDistanceSq(points[i], points[first], points[last]);
      if (d > maxDistSq) {
        maxDistSq = d;
        index = i;
      }
    }
    if (maxDistSq > tolSq && index > 0) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/** Closed rings need their wrap-around point handled, and never drop below a triangle. */
export function simplifyRing(ring, tolerance) {
  if (tolerance <= 0 || ring.length < 5) return ring;
  const simplified = simplify(ring, tolerance);
  return simplified.length >= 4 ? simplified : ring;
}
