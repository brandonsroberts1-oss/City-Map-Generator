// Vector tiles as a map data source.
//
// Overpass answers arbitrary questions about the whole planet, live, on a
// shared machine — which is why it is slow and why it times out under load. A
// vector tile server answers one question, "what is in this square", from files
// built in advance and cached on a CDN. For drawing a map that is the right
// trade: a city arrives in a second or so instead of tens of seconds, and there
// is no queue to wait in.
//
// The cost is that tiles carry a fixed, generalised schema (OpenMapTiles)
// rather than raw OSM tags, and features are cut at tile edges. Both are
// handled below.

import { decodeTile, GEOMETRY_LINE, GEOMETRY_POLYGON, GEOMETRY_POINT } from './mvt.js';

export const TILE_SOURCES = [
  {
    id: 'openfreemap',
    label: 'OpenFreeMap',
    url: 'https://tiles.openfreemap.org/planet',
    note: 'Free and unmetered, no account needed.',
  },
  {
    id: 'versatiles',
    label: 'VersaTiles',
    url: 'https://tiles.versatiles.org/tiles/osm',
    note: 'Community mirror, same tile schema.',
  },
];

const MAX_TILES = 24;
const TILE_CONCURRENCY = 8;

// ------------------------------------------------------------------ tile maths
export const lonToTileX = (lon, z) => ((lon + 180) / 360) * 2 ** z;

export function latToTileY(lat, z) {
  const rad = (Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z;
}

export const tileXToLon = (x, z) => (x / 2 ** z) * 360 - 180;

export function tileYToLat(y, z) {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

export function tilesForBounds(bounds, z) {
  const scale = 2 ** z;
  const minX = Math.max(0, Math.floor(lonToTileX(bounds.west, z)));
  const maxX = Math.min(scale - 1, Math.floor(lonToTileX(bounds.east, z)));
  const minY = Math.max(0, Math.floor(latToTileY(bounds.north, z)));
  const maxY = Math.min(scale - 1, Math.floor(latToTileY(bounds.south, z)));
  const tiles = [];
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) tiles.push({ z, x, y });
  }
  return tiles;
}

/**
 * The most detailed zoom that still covers the view in a sane number of tiles.
 * A wide view drops a level rather than asking for a hundred squares — and at
 * that scale the extra detail would be filtered out anyway.
 */
export function pickZoom(bounds, maxZoom = 14, minZoom = 8) {
  for (let z = maxZoom; z > minZoom; z--) {
    if (tilesForBounds(bounds, z).length <= MAX_TILES) return z;
  }
  return minZoom;
}

// ------------------------------------------------------------ schema mapping
const ROAD_CLASSES = {
  motorway: 'motorway',
  trunk: 'motorway',
  primary: 'primary',
  secondary: 'secondary',
  tertiary: 'tertiary',
  minor: 'residential',
  street: 'residential',
  residential: 'residential',
  unclassified: 'tertiary',
  service: 'service',
  track: 'path',
  path: 'path',
  footway: 'path',
  pedestrian: 'path',
  rail: 'rail',
  transit: 'rail',
};

const GREEN_LANDCOVER = new Set(['wood', 'grass', 'forest', 'meadow', 'scrub', 'heath', 'park', 'farmland', 'wetland', 'sand']);
const GREEN_LANDUSE = new Set(['cemetery', 'recreation_ground', 'allotments', 'village_green', 'grass', 'park']);

/** OpenMapTiles layer + properties → one of this app's engravable layers. */
function classify(layerName, props) {
  const cls = props.class || props.subclass || '';
  switch (layerName) {
    case 'transportation':
      return ROAD_CLASSES[cls] || null;
    case 'transportation_name':
      // Names travel in their own layer; these are labels, never ink.
      return ROAD_CLASSES[cls] || 'residential';
    case 'waterway':
      return cls === 'river' ? 'riverLine' : 'streamLine';
    case 'water':
      return 'water';
    case 'water_name':
      return 'water';
    case 'building':
      return 'buildings';
    case 'park':
      return 'landuseGreen';
    case 'landcover':
      return GREEN_LANDCOVER.has(cls) ? 'landuseGreen' : null;
    case 'landuse':
      return GREEN_LANDUSE.has(cls) ? 'landuseGreen' : null;
    default:
      return null;
  }
}

const LABEL_ONLY_LAYERS = new Set(['transportation_name', 'water_name']);

const WANTED_LAYERS = [
  'transportation',
  'transportation_name',
  'waterway',
  'water',
  'water_name',
  'building',
  'park',
  'landcover',
  'landuse',
];

/** Which tile layers a data family needs, so unused ones can be dropped early. */
const FAMILY_LAYERS = {
  roads: ['transportation', 'transportation_name'],
  rail: ['transportation'],
  water: ['water', 'water_name'],
  waterways: ['waterway'],
  buildings: ['building'],
  green: ['park', 'landcover', 'landuse'],
};

function signedArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return sum / 2;
}

// ------------------------------------------------------------ tile conversion
function convertTile(tile, layers, { wantedLayers, idPrefix }) {
  const features = [];
  const { z, x, y } = tile;

  for (const layerName of wantedLayers) {
    const layer = layers[layerName];
    if (!layer) continue;
    const extent = layer.extent || 4096;
    const labelOnly = LABEL_ONLY_LAYERS.has(layerName);

    // Tiles carry a margin of geometry beyond their own square; anything cut at
    // that margin is an artefact of tiling, not a real edge.
    const seamMin = -0.5;
    const seamMax = extent + 0.5;
    const toLonLat = ([px, py]) => [
      tileXToLon(x + px / extent, z),
      tileYToLat(y + py / extent, z),
    ];
    const onSeam = ([px, py]) => px <= seamMin || px >= seamMax || py <= seamMin || py >= seamMax;

    for (const feature of layer.features) {
      const layerId = classify(layerName, feature.properties);
      if (!layerId) continue;
      const name = typeof feature.properties.name === 'string' ? feature.properties.name : null;
      if (labelOnly && !name) continue;
      const id = `${idPrefix}${layerName[0]}${feature.id ?? features.length}`;

      if (feature.type === GEOMETRY_LINE) {
        for (const ring of feature.geometry) {
          if (ring.length < 2) continue;
          features.push({
            id,
            layerId,
            kind: 'line',
            name,
            labelOnly,
            line: ring.map(toLonLat),
            tags: feature.properties,
          });
        }
      } else if (feature.type === GEOMETRY_POLYGON) {
        const rings = [];
        const holes = [];
        const outlines = [];
        for (const ring of feature.geometry) {
          if (ring.length < 4) continue;
          // Vector tiles wind exterior rings clockwise in tile space, where y
          // increases downwards; under this shoelace that is a positive area.
          const exterior = signedArea(ring) > 0;
          (exterior ? rings : holes).push(ring.map(toLonLat));
          // For outline drawing, break the ring wherever it only follows the
          // tile's own edge, so a park does not appear to have a straight side.
          let run = [];
          for (let i = 0; i < ring.length; i++) {
            const point = ring[i];
            const next = ring[(i + 1) % ring.length];
            run.push(toLonLat(point));
            if (onSeam(point) && onSeam(next)) {
              if (run.length > 1) outlines.push(run);
              run = [];
            }
          }
          if (run.length > 1) outlines.push(run);
        }
        if (!rings.length) continue;
        features.push({
          id,
          layerId,
          kind: 'area',
          name,
          labelOnly,
          rings,
          holes,
          outlines,
          tags: feature.properties,
        });
      } else if (feature.type === GEOMETRY_POINT && labelOnly) {
        const point = feature.geometry[0]?.[0];
        if (point) {
          features.push({
            id,
            layerId,
            kind: 'point',
            name,
            labelOnly: true,
            point: toLonLat(point),
            tags: feature.properties,
          });
        }
      }
    }
  }
  return features;
}

// ------------------------------------------------------------------- fetching
const tileJsonCache = new Map();

/** Resolves a source URL to a `{z}/{x}/{y}` template and its zoom range. */
export async function resolveTileSource(url, { signal } = {}) {
  if (url.includes('{z}')) return { template: url, maxzoom: 14, minzoom: 0 };
  if (tileJsonCache.has(url)) return tileJsonCache.get(url);
  const promise = (async () => {
    const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Tile server returned HTTP ${res.status}`);
    const json = await res.json();
    const template = Array.isArray(json.tiles) ? json.tiles[0] : null;
    if (!template) throw new Error('Tile server did not advertise a tile URL');
    return {
      template,
      maxzoom: Number.isFinite(json.maxzoom) ? json.maxzoom : 14,
      minzoom: Number.isFinite(json.minzoom) ? json.minzoom : 0,
      attribution: json.attribution,
    };
  })();
  tileJsonCache.set(url, promise);
  try {
    const resolved = await promise;
    tileJsonCache.set(url, resolved);
    return resolved;
  } catch (error) {
    tileJsonCache.delete(url);
    throw error;
  }
}

async function fetchOne(template, tile, signal, timeoutMs) {
  const url = template
    .replace('{z}', tile.z)
    .replace('{x}', tile.x)
    .replace('{y}', tile.y);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  // A signal that was already aborted never fires the event, so a request
  // queued behind others would otherwise carry on after being cancelled.
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    // A missing tile means empty ocean or an area with nothing in it, which is
    // an answer rather than a failure.
    if (res.status === 404 || res.status === 204) return null;
    if (!res.ok) throw new Error(`tile ${tile.z}/${tile.x}/${tile.y} → HTTP ${res.status}`);
    const buffer = await res.arrayBuffer();
    return buffer.byteLength ? buffer : null;
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function mapWithLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * @returns {Promise<{features: Array, tiles: number, bytes: number, zoom: number}>}
 */
export async function fetchTiles(bounds, families, options = {}) {
  const { signal, onProgress, sourceUrl, timeoutMs = 15000 } = options;
  const source = await resolveTileSource(sourceUrl, { signal });
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const zoom = pickZoom(bounds, source.maxzoom, source.minzoom);
  const tiles = tilesForBounds(bounds, zoom);

  const wantedLayers = new Set();
  for (const family of families) {
    for (const name of FAMILY_LAYERS[family] || []) wantedLayers.add(name);
  }
  const layerList = WANTED_LAYERS.filter((name) => wantedLayers.has(name));

  onProgress?.({ kind: 'start', tiles: tiles.length, zoom });

  let done = 0;
  let bytes = 0;
  let failures = 0;
  const perTile = await mapWithLimit(tiles, TILE_CONCURRENCY, async (tile) => {
    let buffer = null;
    try {
      buffer = await fetchOne(source.template, tile, signal, timeoutMs);
    } catch (error) {
      if (error.name === 'AbortError' && signal?.aborted) throw error;
      failures += 1;
      return [];
    } finally {
      done += 1;
      onProgress?.({ kind: 'tile', done, total: tiles.length });
    }
    if (!buffer) return [];
    bytes += buffer.byteLength;
    return convertTile(tile, decodeTile(buffer), {
      wantedLayers: layerList,
      idPrefix: `t${tile.z}_${tile.x}_${tile.y}_`,
    });
  });

  if (failures === tiles.length && tiles.length) {
    throw new Error('No tiles could be downloaded');
  }
  return { features: perTile.flat(), tiles: tiles.length, bytes, zoom, failures };
}

export { convertTile, classify, FAMILY_LAYERS };
