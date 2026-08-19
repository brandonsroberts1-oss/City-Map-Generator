// Turns lon/lat features into millimetre geometry that is projected, thinned,
// clipped to the coaster window, and grouped per layer — the last step before
// anything becomes SVG path data.

import { LAYERS_BY_ID, labelCategory } from './layers.js';
import { simplify, simplifyRing } from './simplify.js';
import {
  clipPolygon,
  clipPolyline,
  signedArea,
  boundsOf,
  boundsDisjoint,
  subtractFromPolyline,
  subtractFromRing,
} from './clip.js';

function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return total;
}

function centroidOfRing(ring) {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    area += cross;
    cx += (ring[j][0] + ring[i][0]) * cross;
    cy += (ring[j][1] + ring[i][1]) * cross;
  }
  if (Math.abs(area) < 1e-9) {
    const b = boundsOf(ring);
    return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
  }
  area *= 0.5;
  return [cx / (6 * area), cy / (6 * area)];
}

/** Outer rings wind one way and holes the other, so nonzero fill leaves the hole open. */
function orient(ring, wantPositive) {
  const positive = signedArea(ring) >= 0;
  return positive === wantPositive ? ring : ring.slice().reverse();
}

const clipBoundsOf = (clip) => ({
  minX: clip.bounds.minX,
  minY: clip.bounds.minY,
  maxX: clip.bounds.maxX,
  maxY: clip.bounds.maxY,
});

/**
 * @param {Array} features parsed OSM features in lon/lat
 * @param {object} opts { projection, clip, state }
 */
export function prepareFeatures(features, { projection, clip, state }) {
  const byLayer = new Map();
  const labelCandidates = [];
  const clipBounds = clipBoundsOf(clip);
  const tolerance = state.detail.simplifyMm;
  const wantLabels = state.labels.enabled;

  const bucket = (id) => {
    let b = byLayer.get(id);
    if (!b) {
      b = { lines: [], areas: [], outlines: [] };
      byLayer.set(id, b);
    }
    return b;
  };

  const project = ([lon, lat]) => projection.project(lon, lat);

  for (const feature of features) {
    const layer = LAYERS_BY_ID.get(feature.layerId);
    if (!layer) continue;
    const settings = state.layers[feature.layerId];
    if (!settings || !settings.enabled) continue;

    if (feature.kind === 'line') {
      const projected = feature.line.map(project);
      if (boundsDisjoint(boundsOf(projected), clipBounds)) continue;
      const thinned = simplify(projected, tolerance);
      const pieces = clipPolyline(thinned, clip);
      if (!pieces.length) continue;
      bucket(feature.layerId).lines.push(...pieces);

      if (wantLabels && feature.name) {
        const category = labelCategory(feature.layerId);
        if (category) {
          let best = null;
          for (const piece of pieces) {
            const len = polylineLength(piece);
            if (!best || len > best.length) best = { length: len, points: piece };
          }
          if (best) {
            labelCandidates.push({
              name: feature.name,
              category,
              kind: 'line',
              layerId: feature.layerId,
              points: best.points,
              length: best.length,
            });
          }
        }
      }
      continue;
    }

    // Areas
    const minArea = Math.max(
      layer.minAreaMm2 || 0,
      feature.layerId === 'buildings' ? state.detail.minBuildingMm2 : 0
    );
    const outers = [];
    const holes = [];
    let totalArea = 0;
    let biggest = null;

    for (const ring of feature.rings) {
      const projected = ring.map(project);
      if (boundsDisjoint(boundsOf(projected), clipBounds)) continue;
      const thinned = simplifyRing(projected, tolerance);
      const clipped = clipPolygon(thinned, clip);
      if (clipped.length < 3) continue;
      const area = Math.abs(signedArea(clipped));
      if (area < minArea) continue;
      totalArea += area;
      if (!biggest || area > biggest.area) biggest = { area, ring: clipped };
      outers.push(orient(clipped, true));
    }
    if (!outers.length) continue;

    for (const ring of feature.holes || []) {
      const projected = ring.map(project);
      if (boundsDisjoint(boundsOf(projected), clipBounds)) continue;
      const clipped = clipPolygon(simplifyRing(projected, tolerance), clip);
      if (clipped.length < 3) continue;
      if (Math.abs(signedArea(clipped)) < minArea) continue;
      holes.push(orient(clipped, false));
    }

    // Outline-mode areas travel as closed polylines, not rings: once a label or
    // the pin punches a hole in them, a ring would have to re-close across the
    // gap and draw a chord straight through the middle of the park.
    if (settings.mode === 'fill') {
      bucket(feature.layerId).areas.push({ outers, holes });
    } else {
      const target = bucket(feature.layerId).outlines;
      for (const ring of [...outers, ...holes]) target.push([...ring, ring[0]]);
    }

    if (wantLabels && feature.name && biggest) {
      const category = labelCategory(feature.layerId);
      if (category) {
        labelCandidates.push({
          name: feature.name,
          category,
          kind: 'area',
          layerId: feature.layerId,
          anchor: centroidOfRing(biggest.ring),
          ring: biggest.ring,
          area: totalArea,
          length: Math.sqrt(totalArea),
        });
      }
    }
  }

  return { byLayer, labelCandidates };
}

export { polylineLength, centroidOfRing };

/**
 * Removes the knockout shapes from every layer's geometry.
 *
 * Run after labels are placed, so the pin and each label sit in genuinely clear
 * slate instead of on top of engraved streets.
 */
export function applyKnockouts(byLayer, knockouts) {
  if (!knockouts.length) return byLayer;
  for (const bucket of byLayer.values()) {
    if (bucket.lines.length) {
      const lines = [];
      for (const line of bucket.lines) lines.push(...subtractFromPolyline(line, knockouts));
      bucket.lines = lines;
    }
    if (bucket.outlines.length) {
      const outlines = [];
      for (const line of bucket.outlines) outlines.push(...subtractFromPolyline(line, knockouts));
      bucket.outlines = outlines;
    }
    if (bucket.areas.length) {
      const areas = [];
      for (const area of bucket.areas) {
        const outers = [];
        for (const ring of area.outers) {
          for (const piece of subtractFromRing(ring, knockouts)) outers.push(orient(piece, true));
        }
        if (!outers.length) continue;
        const holes = [];
        for (const ring of area.holes) {
          for (const piece of subtractFromRing(ring, knockouts)) holes.push(orient(piece, false));
        }
        areas.push({ outers, holes });
      }
      bucket.areas = areas;
    }
  }
  return byLayer;
}
