// Overpass data fetching: query assembly, mirror fallback, and a cache that
// avoids re-downloading when you nudge the map or toggle a layer you already
// have data for.

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
];

/** Overpass statements per data family, keyed the way LAYER_DATA_NEEDS names them. */
const QUERY_PARTS = {
  roads: [
    'way["highway"]["highway"!~"^(proposed|construction|raceway|bus_guideway|escape|elevator)$"](BBOX);',
  ],
  rail: ['way["railway"]["railway"!~"^(abandoned|disused|razed|construction|proposed)$"](BBOX);'],
  water: [
    'way["natural"~"^(water|bay|strait|wetland)$"](BBOX);',
    'way["landuse"~"^(reservoir|basin)$"](BBOX);',
    'way["waterway"~"^(riverbank|dock)$"](BBOX);',
    'relation["natural"~"^(water|bay|strait)$"](BBOX);',
    'relation["landuse"~"^(reservoir|basin)$"](BBOX);',
    'relation["waterway"="riverbank"](BBOX);',
  ],
  waterways: ['way["waterway"~"^(river|stream|canal|ditch|drain|tidal_channel)$"](BBOX);'],
  buildings: ['way["building"](BBOX);', 'relation["building"]["type"="multipolygon"](BBOX);'],
  green: [
    'way["leisure"~"^(park|garden|golf_course|nature_reserve|pitch|playground|common|dog_park)$"](BBOX);',
    'way["landuse"~"^(grass|forest|meadow|village_green|recreation_ground|cemetery|allotments|orchard|vineyard|greenfield)$"](BBOX);',
    'way["natural"~"^(wood|scrub|heath|grassland|sand|beach)$"](BBOX);',
    'relation["leisure"~"^(park|garden|golf_course|nature_reserve)$"](BBOX);',
    'relation["landuse"~"^(forest|grass|meadow|recreation_ground|cemetery)$"](BBOX);',
  ],
};

export const DATA_FAMILIES = Object.keys(QUERY_PARTS);

export function buildQuery(bounds, families, timeout = 90) {
  const bbox = `${bounds.south.toFixed(6)},${bounds.west.toFixed(6)},${bounds.north.toFixed(
    6
  )},${bounds.east.toFixed(6)}`;
  const body = families
    .filter((f) => QUERY_PARTS[f])
    .flatMap((f) => QUERY_PARTS[f])
    .map((stmt) => '  ' + stmt.replace(/BBOX/g, bbox))
    .join('\n');
  return `[out:json][timeout:${timeout}];\n(\n${body}\n);\nout body;\n>;\nout skel qt;`;
}

class OverpassError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = 'OverpassError';
    this.retryable = retryable;
  }
}

async function requestOnce(endpoint, query, signal) {
  const res = await fetch(endpoint, {
    method: 'POST',
    body: 'data=' + encodeURIComponent(query),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal,
  });
  if (res.status === 429 || res.status === 504 || res.status === 503) {
    throw new OverpassError(`${endpoint} is busy (HTTP ${res.status})`, { retryable: true });
  }
  if (!res.ok) {
    throw new OverpassError(`${endpoint} returned HTTP ${res.status}`, { retryable: true });
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new OverpassError('Overpass returned a non-JSON response', { retryable: true });
  }
  if (json.remark && /error/i.test(json.remark)) {
    throw new OverpassError(json.remark, { retryable: false });
  }
  return json;
}

/** Tries each mirror in turn; only the last failure is surfaced. */
export async function fetchOverpass(bounds, families, { signal, onProgress } = {}) {
  const query = buildQuery(bounds, families);
  let lastError = null;
  for (let i = 0; i < MIRRORS.length; i++) {
    const endpoint = MIRRORS[i];
    try {
      onProgress?.(
        i === 0
          ? 'Downloading map data from OpenStreetMap…'
          : `Primary server busy, trying mirror ${i + 1}…`
      );
      return { json: await requestOnce(endpoint, query, signal), endpoint, query };
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      lastError = err;
      if (err instanceof OverpassError && !err.retryable) break;
    }
  }
  throw lastError || new Error('Could not reach any Overpass server');
}

export { MIRRORS };
