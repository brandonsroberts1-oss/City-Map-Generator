// Turns raw Overpass JSON into a flat list of classified features in lon/lat.
// Multipolygon relations are stitched here rather than in the renderer, because
// a lake with an island has to keep its hole all the way through to the SVG.

import { classify } from './layers.js';

const RING_SNAP = 1e-9;

function isClosedRing(nodes) {
  if (nodes.length < 4) return false;
  const a = nodes[0];
  const b = nodes[nodes.length - 1];
  return Math.abs(a[0] - b[0]) < RING_SNAP && Math.abs(a[1] - b[1]) < RING_SNAP;
}

/**
 * Joins unordered way fragments into closed rings, the way an OSM
 * multipolygon relation expects consumers to. Fragments that never close are
 * dropped rather than guessed at.
 */
function assembleRings(fragments) {
  const rings = [];
  const pending = fragments.filter((f) => f && f.length >= 2).map((f) => f.slice());

  while (pending.length) {
    let current = pending.pop();
    let joined = true;
    while (joined && !isClosedRing(current)) {
      joined = false;
      const head = current[0];
      const tail = current[current.length - 1];
      for (let i = 0; i < pending.length; i++) {
        const cand = pending[i];
        const cHead = cand[0];
        const cTail = cand[cand.length - 1];
        const near = (a, b) =>
          Math.abs(a[0] - b[0]) < RING_SNAP && Math.abs(a[1] - b[1]) < RING_SNAP;

        if (near(tail, cHead)) current = current.concat(cand.slice(1));
        else if (near(tail, cTail)) current = current.concat(cand.slice(0, -1).reverse());
        else if (near(head, cTail)) current = cand.slice(0, -1).concat(current);
        else if (near(head, cHead)) current = cand.slice(1).reverse().concat(current);
        else continue;

        pending.splice(i, 1);
        joined = true;
        break;
      }
    }
    if (isClosedRing(current) && current.length >= 4) rings.push(current);
  }
  return rings;
}

function tagsSayArea(tags) {
  if (!tags) return false;
  if (tags.area === 'yes') return true;
  if (tags.building || tags['building:part']) return true;
  if (tags.landuse || tags.leisure || tags.amenity) return true;
  if (tags.natural && tags.natural !== 'coastline' && tags.natural !== 'tree_row') return true;
  if (tags.waterway === 'riverbank' || tags.waterway === 'dock') return true;
  if (tags.highway) return false;
  return false;
}

/**
 * @param {object} json Overpass API response (`out body; >; out skel qt;` shape)
 * @returns {{features: Array, counts: object}}
 */
export function parseOverpass(json) {
  const nodes = new Map();
  const ways = new Map();
  const relations = [];

  for (const el of json.elements || []) {
    if (el.type === 'node') nodes.set(el.id, [el.lon, el.lat]);
    else if (el.type === 'way') ways.set(el.id, el);
    else if (el.type === 'relation') relations.push(el);
  }

  const features = [];
  const consumedByRelation = new Set();
  const counts = {};
  const bump = (id) => {
    counts[id] = (counts[id] || 0) + 1;
  };

  // Relations first, so their member ways are not also emitted standalone.
  for (const rel of relations) {
    const tags = rel.tags || {};
    if (tags.type !== 'multipolygon' && tags.type !== 'boundary') continue;
    const layerId = classify(tags, true);
    if (!layerId) continue;

    const outerFragments = [];
    const innerFragments = [];
    for (const member of rel.members || []) {
      if (member.type !== 'way') continue;
      const way = ways.get(member.ref);
      if (!way || !way.nodes) continue;
      const coords = way.nodes.map((id) => nodes.get(id)).filter(Boolean);
      if (coords.length < 2) continue;
      consumedByRelation.add(member.ref);
      if (member.role === 'inner') innerFragments.push(coords);
      else outerFragments.push(coords);
    }

    const outers = assembleRings(outerFragments);
    if (!outers.length) continue;
    features.push({
      id: `r${rel.id}`,
      layerId,
      kind: 'area',
      name: tags.name || null,
      rings: outers,
      holes: assembleRings(innerFragments),
      tags,
    });
    bump(layerId);
  }

  for (const way of ways.values()) {
    const tags = way.tags;
    if (!tags) continue;
    if (consumedByRelation.has(way.id) && !tags.building) continue;
    const coords = (way.nodes || []).map((id) => nodes.get(id)).filter(Boolean);
    if (coords.length < 2) continue;

    const closed = isClosedRing(coords);
    const layerId = classify(tags, closed);
    if (!layerId) continue;

    if (closed && tagsSayArea(tags)) {
      features.push({
        id: `w${way.id}`,
        layerId,
        kind: 'area',
        name: tags.name || null,
        rings: [coords],
        holes: [],
        tags,
      });
    } else {
      features.push({
        id: `w${way.id}`,
        layerId,
        kind: 'line',
        name: tags.name || null,
        line: coords,
        tags,
      });
    }
    bump(layerId);
  }

  return { features, counts };
}
