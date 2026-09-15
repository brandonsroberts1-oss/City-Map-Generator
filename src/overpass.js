// Overpass data fetching.
//
// Three things make this slow if you let them, and all three are handled here:
// the query asks for more than it needs, the public servers are frequently
// busy, and a stalled connection has no natural end. So the query is kept as
// small as the design can tolerate, a second mirror is started if the first has
// not answered promptly, and every attempt has a hard deadline.

const MIRRORS = [
  // Ordered by how reliably they answer quickly; the first is the one that
  // usually wins, the rest exist for when it does not.
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
];

/**
 * Buildings tagged as houses, garages and sheds are the bulk of the payload in
 * any suburb, and below a certain zoom every one of them is smaller than the
 * laser can resolve — they are downloaded only to be thrown away. Past that
 * point they are left out of the query instead.
 */
const SMALL_BUILDING_VALUES = [
  'house', 'detached', 'semidetached_house', 'garage', 'garages', 'shed', 'hut',
  'carport', 'cabin', 'bungalow', 'static_caravan', 'roof', 'terrace',
];

/** Overpass statements per data family, keyed the way LAYER_DATA_NEEDS names them. */
const QUERY_PARTS = {
  roads: () => [
    'way["highway"]["highway"!~"^(proposed|construction|raceway|bus_guideway|escape|elevator)$"](BBOX);',
  ],
  rail: () => [
    'way["railway"]["railway"!~"^(abandoned|disused|razed|construction|proposed)$"](BBOX);',
  ],
  water: () => [
    'way["natural"~"^(water|bay|strait|wetland)$"](BBOX);',
    'way["landuse"~"^(reservoir|basin)$"](BBOX);',
    'way["waterway"~"^(riverbank|dock)$"](BBOX);',
    'relation["natural"~"^(water|bay|strait)$"](BBOX);',
    'relation["landuse"~"^(reservoir|basin)$"](BBOX);',
    'relation["waterway"="riverbank"](BBOX);',
  ],
  waterways: () => ['way["waterway"~"^(river|stream|canal|ditch|drain|tidal_channel)$"](BBOX);'],
  buildings: ({ skipSmallBuildings }) => [
    skipSmallBuildings
      ? `way["building"]["building"!~"^(${SMALL_BUILDING_VALUES.join('|')})$"](BBOX);`
      : 'way["building"](BBOX);',
    'relation["building"]["type"="multipolygon"](BBOX);',
  ],
  green: () => [
    'way["leisure"~"^(park|garden|golf_course|nature_reserve|pitch|playground|common|dog_park)$"](BBOX);',
    'way["landuse"~"^(grass|forest|meadow|village_green|recreation_ground|cemetery|allotments|orchard|vineyard|greenfield)$"](BBOX);',
    'way["natural"~"^(wood|scrub|heath|grassland|sand|beach)$"](BBOX);',
    'relation["leisure"~"^(park|garden|golf_course|nature_reserve)$"](BBOX);',
    'relation["landuse"~"^(forest|grass|meadow|recreation_ground|cemetery)$"](BBOX);',
  ],
};

export const DATA_FAMILIES = Object.keys(QUERY_PARTS);

/** Families that are cheap and define the map; everything else can arrive later. */
export const BASE_FAMILIES = ['roads', 'water', 'waterways', 'rail', 'green'];

export function buildQuery(bounds, families, { timeout = 25, skipSmallBuildings = false } = {}) {
  const bbox = `${bounds.south.toFixed(5)},${bounds.west.toFixed(5)},${bounds.north.toFixed(
    5
  )},${bounds.east.toFixed(5)}`;
  const body = families
    .filter((f) => QUERY_PARTS[f])
    .flatMap((f) => QUERY_PARTS[f]({ skipSmallBuildings }))
    .map((stmt) => '  ' + stmt.replace(/BBOX/g, bbox))
    .join('\n');
  // `out geom` attaches coordinates to each way directly. The alternative —
  // `out body; >; out skel qt;` — makes the server run a second pass to collect
  // every referenced node and then sends them all back with their ids, which is
  // both slower to produce and about a third more to download.
  return `[out:json][timeout:${timeout}];\n(\n${body}\n);\nout geom;`;
}

export class OverpassError extends Error {
  constructor(message, { retryable = true } = {}) {
    super(message);
    this.name = 'OverpassError';
    this.retryable = retryable;
  }
}

function hostOf(endpoint) {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

async function requestOnce(endpoint, query, signal) {
  const res = await fetch(endpoint, {
    method: 'POST',
    body: 'data=' + encodeURIComponent(query),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal,
  });
  if (res.status === 429 || res.status === 503 || res.status === 504) {
    throw new OverpassError(`${hostOf(endpoint)} is busy (HTTP ${res.status})`);
  }
  if (!res.ok) {
    throw new OverpassError(`${hostOf(endpoint)} returned HTTP ${res.status}`);
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new OverpassError(`${hostOf(endpoint)} returned something that is not JSON`);
  }
  // A remark about load or timeout is worth retrying elsewhere; a syntax error
  // in our own query is not, and would only waste every remaining mirror.
  if (json.remark) {
    const retryable = !/(line \d+|parse error|static error)/i.test(json.remark);
    if (/error|exceeded|timed out/i.test(json.remark)) {
      throw new OverpassError(`${hostOf(endpoint)}: ${json.remark.trim()}`, { retryable });
    }
  }
  return json;
}

/**
 * Runs the query against the mirrors, starting the next one if the current
 * attempt has not answered within `hedgeDelayMs` rather than waiting for it to
 * fail outright. The first response wins and the rest are abandoned.
 *
 * Every attempt also carries its own deadline, because a server that accepts
 * the connection and then goes quiet will otherwise leave the app waiting for
 * ever — which is exactly how this used to fail.
 */
export function fetchOverpass(bounds, families, options = {}) {
  const {
    signal,
    onProgress,
    endpoints = MIRRORS,
    hedgeDelayMs = 4000,
    attemptTimeoutMs = 30000,
    timeout,
    skipSmallBuildings,
  } = options;
  const query = buildQuery(bounds, families, { timeout, skipSmallBuildings });

  return new Promise((resolve, reject) => {
    const controllers = [];
    let launched = 0;
    let finished = 0;
    let settled = false;
    let lastError = null;
    let hedgeTimer = null;

    const stopAll = () => {
      clearTimeout(hedgeTimer);
      for (const controller of controllers) controller.abort();
    };
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onOutsideAbort);
      stopAll();
      fn();
    };
    function onOutsideAbort() {
      finish(() => reject(new DOMException('Aborted', 'AbortError')));
    }
    if (signal?.aborted) return onOutsideAbort();
    signal?.addEventListener('abort', onOutsideAbort, { once: true });

    const launch = () => {
      if (settled || launched >= endpoints.length) return;
      const index = launched++;
      const endpoint = endpoints[index];
      const controller = new AbortController();
      controllers.push(controller);
      const deadline = setTimeout(
        () => controller.abort(new DOMException('Timed out', 'TimeoutError')),
        attemptTimeoutMs
      );

      onProgress?.({ kind: index === 0 ? 'start' : 'hedge', host: hostOf(endpoint), index, launched });

      requestOnce(endpoint, query, controller.signal).then(
        (json) => {
          clearTimeout(deadline);
          finish(() => resolve({ json, endpoint, query }));
        },
        (error) => {
          clearTimeout(deadline);
          if (settled) return;
          finished += 1;
          // An abort we caused ourselves is a deadline, not a server fault.
          lastError =
            error.name === 'AbortError' || error.name === 'TimeoutError'
              ? new OverpassError(`${hostOf(endpoint)} did not answer in time`)
              : error;
          if (error instanceof OverpassError && !error.retryable) {
            finish(() => reject(error));
            return;
          }
          onProgress?.({ kind: 'failed', host: hostOf(endpoint), index, message: lastError.message });
          if (launched < endpoints.length) {
            clearTimeout(hedgeTimer);
            launch();
          } else if (finished >= launched) {
            finish(() => reject(lastError));
          }
        }
      );

      if (launched < endpoints.length) {
        clearTimeout(hedgeTimer);
        hedgeTimer = setTimeout(launch, hedgeDelayMs);
      }
    };

    launch();
  });
}

export { MIRRORS, SMALL_BUILDING_VALUES, hostOf };
