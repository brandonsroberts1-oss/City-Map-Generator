// Geometric clipping against a convex boundary.
//
// The exported SVG deliberately contains no <clipPath>: laser software
// (xTool Creative Space, LightBurn) either ignores clip paths or engraves the
// hidden geometry anyway. Clipping the coordinates here means what you preview
// is exactly what the machine burns.

const EPS = 1e-9;

/** Signed area of a ring; positive when the ring winds counter-clockwise. */
export function signedArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return sum / 2;
}

/** A rounded rectangle as a convex polygon, ready to clip against. */
export function roundedRectPolygon(rect, radius, cornerSteps = 16) {
  const r = Math.max(0, Math.min(radius, Math.min(rect.w, rect.h) / 2));
  const { x, y, w, h } = rect;
  if (r < EPS) {
    return [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ];
  }
  const corners = [
    { cx: x + w - r, cy: y + r, start: -Math.PI / 2 },
    { cx: x + w - r, cy: y + h - r, start: 0 },
    { cx: x + r, cy: y + h - r, start: Math.PI / 2 },
    { cx: x + r, cy: y + r, start: Math.PI },
  ];
  const out = [];
  for (const { cx, cy, start } of corners) {
    for (let i = 0; i <= cornerSteps; i++) {
      const a = start + (Math.PI / 2) * (i / cornerSteps);
      out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  }
  return out;
}

export function ellipsePolygon(cx, cy, rx, ry, steps = 128) {
  const out = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return out;
}

/** Axis-aligned bounds of a point list, or null when empty. */
export function boundsOf(points) {
  if (!points.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Half-plane description of every edge of a convex polygon, wound either way.
 * `inside(p) === nx*px + ny*py + c >= 0`.
 */
export function convexClipEdges(polygon) {
  const orientation = signedArea(polygon) >= 0 ? 1 : -1;
  const edges = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    if (Math.abs(dx) < EPS && Math.abs(dy) < EPS) continue;
    // Inward normal for this winding direction.
    const nx = -dy * orientation;
    const ny = dx * orientation;
    edges.push({ nx, ny, c: -(nx * a[0] + ny * a[1]) });
  }
  return { edges, bounds: boundsOf(polygon) };
}

function distanceTo(edge, p) {
  return edge.nx * p[0] + edge.ny * p[1] + edge.c;
}

/**
 * Sutherland-Hodgman polygon clipping. Returns [] when nothing survives.
 * Only valid for convex clip regions, which is all we ever use.
 */
export function clipPolygon(ring, clip) {
  let output = ring;
  for (const edge of clip.edges) {
    if (output.length === 0) return [];
    const input = output;
    output = [];
    let prev = input[input.length - 1];
    let prevD = distanceTo(edge, prev);
    for (const cur of input) {
      const curD = distanceTo(edge, cur);
      if (curD >= 0) {
        if (prevD < 0) {
          const t = prevD / (prevD - curD);
          output.push([prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t]);
        }
        output.push(cur);
      } else if (prevD >= 0) {
        const t = prevD / (prevD - curD);
        output.push([prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t]);
      }
      prev = cur;
      prevD = curD;
    }
  }
  return output.length >= 3 ? output : [];
}

/**
 * Cyrus-Beck clipping of an open polyline against a convex region.
 * Returns a list of surviving sub-polylines.
 */
export function clipPolyline(line, clip) {
  const pieces = [];
  let current = null;

  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    let tEnter = 0;
    let tLeave = 1;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    let dropped = false;

    for (const edge of clip.edges) {
      const denom = edge.nx * dx + edge.ny * dy;
      const dist = distanceTo(edge, a);
      if (Math.abs(denom) < EPS) {
        if (dist < 0) {
          dropped = true;
          break;
        }
        continue;
      }
      const t = -dist / denom;
      if (denom > 0) {
        if (t > tEnter) tEnter = t;
      } else if (t < tLeave) tLeave = t;
      if (tEnter > tLeave) {
        dropped = true;
        break;
      }
    }

    if (dropped || tEnter > tLeave) {
      current = null;
      continue;
    }

    const p0 = [a[0] + dx * tEnter, a[1] + dy * tEnter];
    const p1 = [a[0] + dx * tLeave, a[1] + dy * tLeave];

    // A segment that leaves early ends the run; one that enters late starts a new one.
    if (current && tEnter === 0) {
      current.push(p1);
    } else {
      current = [p0, p1];
      pieces.push(current);
    }
    if (tLeave < 1) current = null;
  }

  return pieces.filter((p) => p.length >= 2);
}

/** Quick reject: true when two axis-aligned boxes cannot possibly overlap. */
export function boundsDisjoint(a, b) {
  if (!a || !b) return true;
  return a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY;
}

export function pointInRing(point, ring) {
  let inside = false;
  const [px, py] = point;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Decomposes the *outside* of a convex polygon into disjoint convex regions.
 *
 * This is what lets the pin and the labels punch genuine holes in the streets
 * underneath them. A knocked-out letter is only readable if the map is not
 * engraved behind it, and "draw the background colour on top" is not a thing a
 * laser can do — the geometry itself has to go.
 *
 * Region i is "outside edge i, but inside every earlier edge", which tiles the
 * complement exactly once.
 */
export function convexComplementRegions(polygon, worldBounds) {
  const { edges } = convexClipEdges(polygon);
  const regions = [];
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    regions.push({
      edges: [{ nx: -e.nx, ny: -e.ny, c: -e.c }, ...edges.slice(0, i)],
      bounds: worldBounds,
    });
  }
  return regions;
}

/** A knockout: the shape to remove, plus the complement regions to clip against. */
export function createKnockout(polygon, worldBounds) {
  return {
    bounds: boundsOf(polygon),
    regions: convexComplementRegions(polygon, worldBounds),
  };
}

/** Removes every knockout shape from a polyline, returning the surviving runs. */
export function subtractFromPolyline(line, knockouts) {
  let pieces = [line];
  for (const knockout of knockouts) {
    const next = [];
    for (const piece of pieces) {
      if (boundsDisjoint(boundsOf(piece), knockout.bounds)) {
        next.push(piece);
        continue;
      }
      for (const region of knockout.regions) {
        next.push(...clipPolyline(piece, region));
      }
    }
    pieces = next;
    if (!pieces.length) break;
  }
  return pieces;
}

/** Removes every knockout shape from a ring, returning the surviving pieces. */
export function subtractFromRing(ring, knockouts) {
  let pieces = [ring];
  for (const knockout of knockouts) {
    const next = [];
    for (const piece of pieces) {
      if (boundsDisjoint(boundsOf(piece), knockout.bounds)) {
        next.push(piece);
        continue;
      }
      for (const region of knockout.regions) {
        const clipped = clipPolygon(piece, region);
        if (clipped.length >= 3) next.push(clipped);
      }
    }
    pieces = next;
    if (!pieces.length) break;
  }
  return pieces;
}
