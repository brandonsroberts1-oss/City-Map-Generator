// Test suite.  node tools/test.mjs [--no-browser]
//
// The geometry and typography checks run in plain node; the browser pass boots
// the real app against the demo fixture and exercises the controls, because
// most of what can break here (font loading, DOM wiring, the export blob) only
// exists in a browser.

import { createRequire } from 'module';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
globalThis.opentype = require('opentype.js');
// The app fetches fonts and the demo fixture by relative path, which in node
// means reading from disk. Anything with a scheme is a real request and must
// reach the network stack — the fetching tests depend on it.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (/^[a-z]+:\/\//i.test(String(url))) return realFetch(url, init);
  const file = String(url).replace(/^\//, '');
  if (!fs.existsSync(file)) return { ok: false, status: 404 };
  const b = fs.readFileSync(file);
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
    json: async () => JSON.parse(b.toString('utf8')),
  };
};

let passed = 0;
let failed = 0;
const group = (name) => console.log(`\n${name}`);
function check(label, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

// ------------------------------------------------------------------ modules
const geo = await import('../src/geo.js');
const clip = await import('../src/clip.js');
const simplifyMod = await import('../src/simplify.js');
const osm = await import('../src/osm.js');
const overpass = await import('../src/overpass.js');
const geocode = await import('../src/geocode.js');
const typography = await import('../src/typography.js');
const layersMod = await import('../src/layers.js');
const stateMod = await import('../src/state.js');
const layoutMod = await import('../src/layout.js');
const prepareMod = await import('../src/prepare.js');
const knockoutMod = await import('../src/knockouts.js');
const labelsMod = await import('../src/labels.js');
const pinshapes = await import('../src/pinshapes.js');
const renderMod = await import('../src/render.js');
const strokeMod = await import('../src/stroke.js');
const pathsMod = await import('../src/paths.js');
const exportMod = await import('../src/export.js');

// ---------------------------------------------------------------- projection
group('projection');
{
  const rect = { x: 0, y: 0, w: 80, h: 80 };
  const p = geo.createProjection({ lat: 39.1031, lon: -84.512, spanMetres: 6000, rect });
  const [cx, cy] = p.project(-84.512, 39.1031);
  check('centre lands in the middle of the rect', near(cx, 40, 1e-9) && near(cy, 40, 1e-9));
  check('span maps to the short side', near(6000 * p.mmPerMetre, 80, 1e-9));
  const [lon, lat] = p.unproject(...p.project(-84.55, 39.15));
  check('project/unproject round-trips', near(lon, -84.55, 1e-9) && near(lat, 39.15, 1e-9));
  check('north is above south on screen', p.project(0, 1)[1] < p.project(0, 0)[1]);
  check('bounds bracket the centre', p.bounds.south < 39.1031 && p.bounds.north > 39.1031);

  const tall = geo.createProjection({ lat: 0, lon: 0, spanMetres: 1000, rect: { x: 0, y: 0, w: 50, h: 100 } });
  check('non-square rect scales from the short side', near(1000 * tall.mmPerMetre, 50, 1e-9));
  check('formatCoordinate signs the hemisphere', geo.formatCoordinate(-76.7298, 'lon') === '76.7298° W');
  check('formatCoordinate handles latitude', geo.formatCoordinate(39.9943, 'lat') === '39.9943° N');
  check('padBounds grows the box', geo.padBounds({ south: 0, north: 1, west: 0, east: 1 }, 0.5).north === 1.5);
  check('boundsContain rejects a wider box',
    !geo.boundsContain({ south: 0, north: 1, west: 0, east: 1 }, { south: 0, north: 2, west: 0, east: 1 }));
}

// ------------------------------------------------------------------ clipping
group('clipping');
{
  const square = clip.convexClipEdges([[0, 0], [10, 0], [10, 10], [0, 10]]);
  const inner = clip.clipPolygon([[5, 5], [20, 5], [20, 20], [5, 20]], square);
  check('polygon clipped to the overlap', Math.abs(clip.signedArea(inner)) === 25);
  check('polygon fully outside disappears', clip.clipPolygon([[20, 20], [30, 20], [30, 30]], square).length === 0);

  const crossing = clip.clipPolyline([[-5, 5], [15, 5]], square);
  check('polyline trimmed at both edges',
    crossing.length === 1 && near(crossing[0][0][0], 0) && near(crossing[0][1][0], 10));
  const reentrant = clip.clipPolyline([[5, 5], [20, 5], [20, 7], [5, 7]], square);
  check('polyline that leaves and returns yields two runs', reentrant.length === 2);
  check('polyline entirely outside yields nothing', clip.clipPolyline([[-5, -5], [-1, -5]], square).length === 0);

  const rounded = clip.roundedRectPolygon({ x: 0, y: 0, w: 10, h: 10 }, 2, 8);
  check('rounded rect is convex and closed-ish', rounded.length === 36);
  check('rounded rect area is under the square', Math.abs(clip.signedArea(rounded)) < 100);

  const world = { minX: -100, minY: -100, maxX: 100, maxY: 100 };
  const hole = clip.createKnockout(clip.roundedRectPolygon({ x: -2, y: -2, w: 4, h: 4 }, 0), world);
  const cut = clip.subtractFromPolyline([[-10, 0], [10, 0]], [hole]);
  check('knockout splits a line in two', cut.length === 2);
  check('knockout keeps the correct total length',
    near(cut.reduce((s, l) => s + Math.hypot(l[1][0] - l[0][0], l[1][1] - l[0][1]), 0), 16));

  const ringPieces = clip.subtractFromRing([[-5, -5], [5, -5], [5, 5], [-5, 5]], [hole]);
  const remaining = ringPieces.reduce((s, r) => s + Math.abs(clip.signedArea(r)), 0);
  check('knockout removes exactly its own area from a polygon', near(remaining, 84, 1e-6), `got ${remaining}`);

  const disc = clip.createKnockout(clip.ellipsePolygon(0, 0, 3, 3, 64), world);
  const discRemoved = 100 - clip.subtractFromRing([[-5, -5], [5, -5], [5, 5], [-5, 5]], [disc])
    .reduce((s, r) => s + Math.abs(clip.signedArea(r)), 0);
  check('circular knockout removes ~pi*r^2', Math.abs(discRemoved - Math.PI * 9) < 0.1, `removed ${discRemoved.toFixed(3)}`);
  check('point-in-ring works', clip.pointInRing([1, 1], [[0, 0], [5, 0], [5, 5], [0, 5]]) &&
    !clip.pointInRing([9, 9], [[0, 0], [5, 0], [5, 5], [0, 5]]));
}

// --------------------------------------------------------------- simplify
group('simplification');
{
  const straight = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]];
  check('collinear points collapse to the ends', simplifyMod.simplify(straight, 0.01).length === 2);
  const bumpy = [[0, 0], [1, 1], [2, 0], [3, 1], [4, 0]];
  check('real detail survives', simplifyMod.simplify(bumpy, 0.1).length === 5);
  check('tolerance 0 is a no-op', simplifyMod.simplify(bumpy, 0).length === 5);
  check('rings never collapse below a triangle', simplifyMod.simplifyRing(straight, 99).length >= 4);
}

// -------------------------------------------------------------- osm parsing
group('OSM parsing');
{
  const json = {
    elements: [
      { type: 'node', id: 1, lon: 0, lat: 0 }, { type: 'node', id: 2, lon: 1, lat: 0 },
      { type: 'node', id: 3, lon: 1, lat: 1 }, { type: 'node', id: 4, lon: 0, lat: 1 },
      { type: 'node', id: 5, lon: 0.3, lat: 0.3 }, { type: 'node', id: 6, lon: 0.6, lat: 0.3 },
      { type: 'node', id: 7, lon: 0.6, lat: 0.6 },
      { type: 'way', id: 10, nodes: [1, 2, 3] }, { type: 'way', id: 11, nodes: [3, 4, 1] },
      { type: 'way', id: 12, nodes: [5, 6, 7, 5] },
      { type: 'way', id: 20, nodes: [1, 3], tags: { highway: 'residential', name: 'Main St' } },
      { type: 'way', id: 21, nodes: [1, 2, 3, 4, 1], tags: { building: 'yes' } },
      { type: 'way', id: 22, nodes: [1, 2, 3], tags: { waterway: 'river', name: 'Big River' } },
      { type: 'relation', id: 30, tags: { type: 'multipolygon', natural: 'water', name: 'Test Lake' },
        members: [{ type: 'way', ref: 10, role: 'outer' }, { type: 'way', ref: 11, role: 'outer' },
                  { type: 'way', ref: 12, role: 'inner' }] },
    ],
  };
  const { features, counts } = osm.parseOverpass(json);
  const lake = features.find((f) => f.name === 'Test Lake');
  check('multipolygon stitched from two fragments', lake && lake.rings[0].length === 5);
  check('multipolygon keeps its hole', lake && lake.holes.length === 1);
  check('member ways are not emitted twice', counts.water === 1);
  check('open highway stays a line', features.find((f) => f.name === 'Main St')?.kind === 'line');
  check('closed building becomes an area', features.find((f) => f.layerId === 'buildings')?.kind === 'area');
  check('open waterway is a river line', features.find((f) => f.name === 'Big River')?.layerId === 'riverLine');

  check('classify maps motorway_link', layersMod.classify({ highway: 'motorway_link' }) === 'motorway');
  check('classify ignores unknown tags', layersMod.classify({ amenity: 'bench' }) === null);
  check('classify sends closed rivers to water', layersMod.classify({ waterway: 'river' }, true) === 'water');
  check('classify skips construction highways', layersMod.classify({ highway: 'nonsense' }) === null);
  check('label categories cover streets and water',
    layersMod.labelCategory('primary') === 'streets' && layersMod.labelCategory('water') === 'water');
}

// ------------------------------------------------------------------ overpass
group('Overpass query building');
{
  const q = overpass.buildQuery({ south: 1, west: 2, north: 3, east: 4 }, ['roads', 'buildings']);
  check('query carries the bbox', q.includes('1.00000,2.00000,3.00000,4.00000'));
  check('query asks for highways', q.includes('way["highway"]'));
  check('query asks for buildings', q.includes('way["building"]'));
  check('query skips families not requested', !q.includes('waterway'));
  // `out geom` returns coordinates inline. The older form made the server run a
  // second pass over every referenced node and send them all back with their
  // ids, which was both slower and about a third more to download.
  check('query asks for inline geometry', q.trimEnd().endsWith('out geom;'));
  check('query does not recurse to nodes', !q.includes('>;') && !q.includes('out skel'));
  check('query timeout leaves room to fail over', /\[timeout:(\d+)\]/.exec(q)[1] <= 30);
  check('unknown families are ignored', !overpass.buildQuery({ south: 0, west: 0, north: 1, east: 1 }, ['nope']).includes('nope'));

  const withHouses = overpass.buildQuery({ south: 0, west: 0, north: 1, east: 1 }, ['buildings']);
  const withoutHouses = overpass.buildQuery({ south: 0, west: 0, north: 1, east: 1 }, ['buildings'], {
    skipSmallBuildings: true,
  });
  check('houses are asked for by default', /way\["building"\]\(/.test(withHouses));
  check('houses can be left out when they would be too small to engrave',
    withoutHouses.includes('"building"!~') && withoutHouses.includes('garage'));
  check('big buildings are still asked for either way', withoutHouses.includes('relation["building"]'));
  check('streets and water are the first wave',
    overpass.BASE_FAMILIES.includes('roads') && !overpass.BASE_FAMILIES.includes('buildings'));
  check('parseLatLon reads a pasted pair', geocode.parseLatLon('39.9943, -76.7298')?.lat === 39.9943);
  check('parseLatLon rejects out-of-range', geocode.parseLatLon('200, 400') === null);
  check('parseLatLon rejects prose', geocode.parseLatLon('York PA') === null);
}

// --------------------------------------------------------------- vector tiles
group('vector tiles');
{
  const mvt = await import('../src/mvt.js');
  const tiles = await import('../src/tiles.js');
  const geojsonvt = (await import('geojson-vt')).default;
  const vtpbf = (await import('vt-pbf')).default;

  const TILE = { z: 14, x: 4345, y: 6255 };
  const encode = (layers) => {
    const out = {};
    for (const [name, features] of Object.entries(layers)) {
      const index = new geojsonvt({ type: 'FeatureCollection', features }, {
        maxZoom: 14, indexMaxZoom: 14, buffer: 64,
      });
      const tile = index.getTile(TILE.z, TILE.x, TILE.y);
      if (tile && tile.features.length) out[name] = tile;
    }
    return vtpbf.fromGeojsonVt(out, { version: 2 });
  };
  const feature = (geometry, properties) => ({ type: 'Feature', properties, geometry });

  // --- decoding, checked against an independent encoder
  const buffer = encode({
    transportation: [feature({ type: 'LineString', coordinates: [[-84.52, 39.10], [-84.51, 39.11]] }, { class: 'primary' })],
    water: [feature({ type: 'Polygon', coordinates: [
      [[-84.518, 39.098], [-84.512, 39.098], [-84.512, 39.104], [-84.518, 39.104], [-84.518, 39.098]],
      [[-84.517, 39.099], [-84.514, 39.099], [-84.514, 39.102], [-84.517, 39.102], [-84.517, 39.099]],
    ] }, { class: 'lake', name: 'Test Lake', rank: 2, deep: true })],
    water_name: [feature({ type: 'Point', coordinates: [-84.515, 39.101] }, { class: 'lake', name: 'Test Lake' })],
  });
  const decoded = mvt.decodeTile(buffer);
  check('tile layers are found by name', Object.keys(decoded).sort().join(',') === 'transportation,water,water_name');
  check('the tile extent is read', decoded.water.extent === 4096);
  check('a line decodes to one path', decoded.transportation.features[0].geometry.length === 1);
  check('a polygon with a hole decodes to two rings', decoded.water.features[0].geometry.length === 2);
  check('string properties survive', decoded.water.features[0].properties.name === 'Test Lake');
  check('numeric properties survive', decoded.water.features[0].properties.rank === 2);
  check('boolean properties survive', decoded.water.features[0].properties.deep === true);
  check('geometry types are reported', decoded.water_name.features[0].type === mvt.GEOMETRY_POINT);
  check('an empty buffer decodes to nothing', Object.keys(mvt.decodeTile(new Uint8Array(0))).length === 0);

  // --- tile arithmetic
  const roundTripX = tiles.tileXToLon(tiles.lonToTileX(-84.512, 14), 14);
  const roundTripY = tiles.tileYToLat(tiles.latToTileY(39.1031, 14), 14);
  check('tile coordinates round-trip', near(roundTripX, -84.512, 1e-9) && near(roundTripY, 39.1031, 1e-9));
  const box = { south: 39.07, west: -84.56, north: 39.14, east: -84.46 };
  check('a view maps to a block of tiles', tiles.tilesForBounds(box, 14).length === 30);
  check('zooming out uses fewer', tiles.tilesForBounds(box, 12).length < tiles.tilesForBounds(box, 14).length);
  check('a wide view drops a zoom rather than asking for hundreds',
    tiles.pickZoom({ south: 39, west: -85, north: 39.6, east: -84.3 }, 14) < 14);
  check('a small view keeps full detail',
    tiles.pickZoom({ south: 39.10, west: -84.52, north: 39.11, east: -84.51 }, 14) === 14);

  // --- schema mapping
  check('motorways map across', tiles.classify('transportation', { class: 'motorway' }) === 'motorway');
  check('minor roads become residential', tiles.classify('transportation', { class: 'minor' }) === 'residential');
  check('rivers and streams are told apart',
    tiles.classify('waterway', { class: 'river' }) === 'riverLine' &&
      tiles.classify('waterway', { class: 'stream' }) === 'streamLine');
  check('buildings map across', tiles.classify('building', {}) === 'buildings');
  check('woods count as green', tiles.classify('landcover', { class: 'wood' }) === 'landuseGreen');
  check('unknown layers are ignored', tiles.classify('aeroway', { class: 'runway' }) === null);

  // --- conversion
  const converted = tiles.convertTile(TILE, decoded, {
    wantedLayers: ['transportation', 'water', 'water_name'],
    idPrefix: 't',
  });
  const lake = converted.find((f) => f.layerId === 'water' && f.kind === 'area');
  const widthOf = (ring) => Math.max(...ring.map((p) => p[0])) - Math.min(...ring.map((p) => p[0]));
  check('the outer ring is the outer one', lake && widthOf(lake.rings[0]) > widthOf(lake.holes[0]));
  check('the hole is kept as a hole', lake?.holes.length === 1);
  check('outline paths are produced for stroked drawing', lake?.outlines.length >= 1);
  const point = converted.find((f) => f.kind === 'point');
  check('a name point becomes a label anchor', point?.labelOnly === true && point.name === 'Test Lake');
  check('road geometry is not label-only', converted.find((f) => f.layerId === 'primary')?.labelOnly === false);

  // Features cut at a tile edge must not be outlined along that edge.
  const spanning = tiles.convertTile(TILE, mvt.decodeTile(encode({
    park: [feature({ type: 'Polygon', coordinates: [[
      [-84.60, 39.05], [-84.40, 39.05], [-84.40, 39.15], [-84.60, 39.15], [-84.60, 39.05],
    ]] }, { class: 'park', name: 'Big Park' })],
  })), { wantedLayers: ['park'], idPrefix: 't' })[0];
  check('a park larger than the tile still fills', spanning?.rings.length === 1);
  check('but its outline is broken at the tile seam', spanning?.outlines.length < 1 + spanning.rings[0].length);

  // --- fetching, against a tile server that behaves like a real one
  const tileServer = spawn(process.execPath, ['tools/mock-tiles.mjs', '5402'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));
  try {
    const source = 'http://localhost:5402/planet';
    const resolved = await tiles.resolveTileSource(source);
    check('TileJSON gives a tile template', resolved.template.includes('{z}'));
    check('and a maximum zoom', resolved.maxzoom === 14);

    const view = { south: 39.088, west: -84.53, north: 39.118, east: -84.494 };
    const result = await tiles.fetchTiles(view, ['roads', 'water', 'buildings', 'waterways'], { sourceUrl: source });
    check('tiles produce features', result.features.length > 500, `${result.features.length}`);
    check('nothing failed', result.failures === 0);
    check('the payload is small', result.bytes < 400 * 1024, `${(result.bytes / 1024).toFixed(0)} KB`);
    check('street names come through', result.features.some((f) => f.labelOnly && f.name));
    check('buildings come through', result.features.some((f) => f.layerId === 'buildings'));

    const controller = new AbortController();
    const cancelled = tiles.fetchTiles(view, ['roads'], { sourceUrl: source, signal: controller.signal });
    controller.abort();
    let cancelledProperly = false;
    try {
      await cancelled;
    } catch (error) {
      cancelledProperly = error.name === 'AbortError';
    }
    check('a tile fetch can be cancelled', cancelledProperly);

    let missingHandled = true;
    try {
      await tiles.fetchTiles({ south: 60, west: -170, north: 60.01, east: -169.99 }, ['roads'], { sourceUrl: source });
    } catch {
      missingHandled = false;
    }
    check('empty tiles are an answer, not an error', missingHandled);

    let badSource = false;
    try {
      await tiles.resolveTileSource('http://localhost:5402/not-tilejson');
    } catch {
      badSource = true;
    }
    check('a bad tile source reports itself', badSource);
  } finally {
    tileServer.kill();
  }
}

// ------------------------------------------------------------ network behaviour
group('fetching');
{
  const mock = spawn(process.execPath, ['tools/mock-overpass.mjs', '5301'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 600));
  const endpoint = (query) => `http://localhost:5301/api/interpreter${query}`;
  const bounds = { south: 39.07, west: -84.56, north: 39.14, east: -84.46 };
  const timed = async (fn) => {
    const started = Date.now();
    try {
      return { value: await fn(), ms: Date.now() - started };
    } catch (error) {
      return { error, ms: Date.now() - started };
    }
  };

  try {
    const healthy = await timed(() =>
      overpass.fetchOverpass(bounds, ['roads'], { endpoints: [endpoint('')] })
    );
    check('a healthy server answers', healthy.value?.json.elements.length > 50);
    check('inline geometry comes back', Boolean(healthy.value?.json.elements[0].geometry));

    // The failure that used to leave the app spinning for ever: a server that
    // accepts the connection and then says nothing.
    const stalled = await timed(() =>
      overpass.fetchOverpass(bounds, ['roads'], {
        endpoints: [endpoint('?stall=1'), endpoint('')],
        hedgeDelayMs: 500,
      })
    );
    check('a stalled server is overtaken by the next mirror', Boolean(stalled.value));
    check('the hedge starts without waiting for a failure', stalled.ms < 1500, `${stalled.ms}ms`);

    const busy = await timed(() =>
      overpass.fetchOverpass(bounds, ['roads'], {
        endpoints: [endpoint('?busy=1'), endpoint('')],
        hedgeDelayMs: 10000,
      })
    );
    check('a busy server fails over at once', Boolean(busy.value) && busy.ms < 1000, `${busy.ms}ms`);

    const slowButWorking = await timed(() =>
      overpass.fetchOverpass(bounds, ['roads'], {
        endpoints: [endpoint('?delay=500'), endpoint('?delay=8000')],
        hedgeDelayMs: 200,
      })
    );
    check('a slow first answer still wins if it arrives first',
      slowButWorking.value && slowButWorking.ms < 2000, `${slowButWorking.ms}ms`);

    const allStalled = await timed(() =>
      overpass.fetchOverpass(bounds, ['roads'], {
        endpoints: [endpoint('?stall=1'), endpoint('?stall=1')],
        hedgeDelayMs: 200,
        attemptTimeoutMs: 900,
      })
    );
    check('a total stall ends in an error, not a hang', Boolean(allStalled.error), `${allStalled.ms}ms`);
    check('and it ends promptly', allStalled.ms < 4000, `${allStalled.ms}ms`);
    check('the error says what happened', /did not answer in time/.test(allStalled.error?.message || ''));

    const aborted = await timed(async () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 200);
      return overpass.fetchOverpass(bounds, ['roads'], {
        endpoints: [endpoint('?stall=1')],
        signal: controller.signal,
      });
    });
    check('the caller can cancel', aborted.error?.name === 'AbortError');

    // A mistake in our own query must not burn through every mirror.
    const badQuery = await timed(() =>
      overpass.fetchOverpass(bounds, ['roads'], { endpoints: [endpoint('?busy=1'), endpoint('?busy=1')] })
    );
    check('exhausting the mirrors reports the last failure', /busy|HTTP 504/.test(badQuery.error?.message || ''));

    const log = await (await fetch('http://localhost:5301/__log')).json();
    check('the server was asked for inline geometry', log.log.every((e) => e.query.includes('out geom')));
    check('no request recursed to nodes', log.log.every((e) => !e.query.includes('>;')));
  } finally {
    mock.kill();
  }
}

// ---------------------------------------------------------------- typography
group('typography');
{
  await typography.preloadAll();
  const font = typography.getLoadedFont('playfair-display', 400, false);
  check('every listed font variant loads', Boolean(font));
  for (const spec of typography.FONTS) {
    if (!typography.getLoadedFont(spec.id, spec.weights[0], false)) {
      check(`font ${spec.id} loads`, false);
    }
  }
  const m = typography.measureText(font, 'Cincinnati, Ohio', 6, 0.3);
  check('measured width is positive', m.width > 0);
  check('tracking widens the run', typography.measureText(font, 'AAAA', 6, 0.5).width > typography.measureText(font, 'AAAA', 6, 0).width);
  const degree = typography.textToPathData(font, '39.1031° N', { size: 5 });
  check('degree sign has an outline', degree.length > 100);
  check('empty text yields no path', typography.textToPathData(font, '', { size: 5 }) === '');
  check('applyTextCase title-cases', typography.applyTextCase('york pennsylvania', 'title') === 'York Pennsylvania');
  check('applyTextCase uppercases', typography.applyTextCase('york', 'upper') === 'YORK');

  const cmds = typography.textCommands(font, 'A', { x: 10, y: 10, size: 4, align: 'middle' });
  const rotated = typography.commandsToPathData(cmds, { decimals: 2, matrix: typography.rotationMatrix(90, 10, 10) });
  const plain = typography.commandsToPathData(cmds, { decimals: 2 });
  check('rotation is baked into the coordinates', rotated !== plain && rotated.startsWith('M'));
  check('serialised path has no NaN', !/NaN/.test(plain));
}

// -------------------------------------------------------------------- layout
group('layout');
{
  const state = stateMod.createDefaultState();
  const layout = layoutMod.computeLayout(state);
  check('layout is coaster-sized', layout.width === 100 && layout.height === 100);
  check('map window sits inside the margin', layout.mapBox.x >= state.coaster.margin - 1e-9);
  check('caption sits below the map', layout.caption.top >= layout.mapBox.y + layout.mapBox.h);
  check('caption has two measured lines', layout.caption.lines.length === 2);
  check('border path exists when enabled', typeof layout.borderPath === 'string' && layout.borderPath.length > 10);
  check('no cut path unless asked', layout.cutPath === null);

  const noCaption = stateMod.createDefaultState();
  noCaption.caption.enabled = false;
  const tallerMap = layoutMod.computeLayout(noCaption).mapBox.h;
  check('turning the caption off gives the map more room', tallerMap > layout.mapBox.h);

  const circle = stateMod.createDefaultState();
  circle.coaster.shape = 'circle';
  const circleLayout = layoutMod.computeLayout(circle);
  check('circle coaster clips to a disc plus the caption cut',
    circleLayout.isCircle && circleLayout.clip.edges.length > 100);

  const square = stateMod.createDefaultState();
  square.mapArea.aspect = 'square';
  const squareLayout = layoutMod.computeLayout(square);
  check('square map window is square', near(squareLayout.mapBox.w, squareLayout.mapBox.h, 1e-9));
}

// ------------------------------------------------------------------ pipeline
group('render pipeline (demo fixture)');
{
  const state = stateMod.createDefaultState();
  state.labels.enabled = true;
  state.layers.landuseGreen.enabled = true;
  const raw = JSON.parse(fs.readFileSync('assets/demo/sample-city.json', 'utf8'));
  const { features } = osm.parseOverpass(raw);
  check('fixture parses to a real city', features.length > 1500);

  const layout = layoutMod.computeLayout(state);
  const projection = geo.createProjection({
    lat: state.location.lat, lon: state.location.lon,
    spanMetres: state.view.spanMetres, rect: layout.projectionRect,
  });
  const prepared = prepareMod.prepareFeatures(features, { projection, clip: layout.clip, state });
  check('layers came out of preparation', prepared.byLayer.size >= 8);
  check('label candidates were collected', prepared.labelCandidates.length > 20);

  // Nothing may escape the map window.
  let outside = 0;
  const b = layout.clip.bounds;
  const tol = 1e-6;
  for (const bucket of prepared.byLayer.values()) {
    for (const geom of [...bucket.lines, ...bucket.outlines, ...bucket.areas.flatMap((a) => [...a.outers, ...a.holes])]) {
      for (const [x, y] of geom) {
        if (x < b.minX - tol || x > b.maxX + tol || y < b.minY - tol || y > b.maxY + tol) outside++;
      }
    }
  }
  check('all geometry is clipped to the map window', outside === 0, `${outside} stray points`);

  const pin = renderMod.computePin(state, layout, projection);
  const labels = labelsMod.placeLabels(prepared.labelCandidates, {
    clip: layout.clip, settings: state.labels, reserved: [pin.box],
  });
  check('labels get placed', labels.length > 5);
  check('labels respect the maximum', labels.length <= state.labels.maxLabels);
  check('no duplicate label text', new Set(labels.map((l) => l.text)).size === labels.length);
  check('labels stay upright', labels.every((l) => Math.abs(l.angle) <= 90 + 1e-9));

  const knockouts = knockoutMod.buildKnockouts({ state, pin, labels, worldBounds: layout.clip.bounds });
  check('a knockout exists for every pin piece and every label',
    knockouts.length === labels.length + pin.shape.pieces.length);
  prepareMod.applyKnockouts(prepared.byLayer, knockouts);

  // Nothing may survive inside the marker itself.
  const insideShape = (x, y) => {
    const b = pin.shape.box;
    if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY) return false;
    // Inside the drawn outline is approximated by its inscribed disc, which is
    // enough to catch a knockout that failed to fire.
    const rIn = Math.min(b.maxX - b.minX, b.maxY - b.minY) / 2 - 0.05;
    const cxs = (b.minX + b.maxX) / 2;
    const cys = (b.minY + b.maxY) / 2;
    return (x - cxs) ** 2 + (y - cys) ** 2 < rIn * rIn;
  };
  let insidePin = 0;
  for (const bucket of prepared.byLayer.values()) {
    for (const geom of [...bucket.lines, ...bucket.outlines, ...bucket.areas.flatMap((a) => a.outers)]) {
      for (const [x, y] of geom) if (insideShape(x, y)) insidePin++;
    }
  }
  check('the pin sits on genuinely clear slate', insidePin === 0, `${insidePin} points inside the pin`);

  const preview = renderMod.renderSvg({ state, layout, projection, prepared, labels, pin, mode: 'preview' });
  const exported = renderMod.renderSvg({ state, layout, projection, prepared, labels, pin, mode: 'export' });
  check('preview draws the slate face', preview.markup.includes('preview-face'));
  check('export omits the preview face', !exported.markup.includes('preview-face'));
  check('export is millimetre-sized', exported.markup.includes('width="100mm"') && exported.markup.includes('viewBox="0 0 100 100"'));
  check('export has no clip paths', !/clip-?[Pp]ath/.test(exported.markup));
  check('export has no live text', !exported.markup.includes('<text'));
  check('export has no transforms', !/ transform=/.test(exported.markup));
  check('export has no NaN coordinates', !/NaN/.test(exported.markup));
  check('export credits OpenStreetMap', exported.markup.includes('OpenStreetMap'));
  check('export names its layers for Inkscape/LightBurn', exported.markup.includes('inkscape:label'));
  check('every path is closed off properly', (exported.markup.match(/<path/g) || []).length === (exported.markup.match(/\/>/g) || []).length);

  // The whole point of outline geometry: nothing in the file relies on a
  // stroke attribute, because xTool throws those away on import.
  check('the export contains no stroked paths', !/stroke="(?!none)/.test(exported.markup));
  check('the export contains no stroke widths', !exported.markup.includes('stroke-width'));
  check('the export contains no unfilled paths', !exported.markup.includes('fill="none"'));
  check('the frame survives as a filled band', /<g id="border"[^>]*><path d="[^"]+" fill="#/.test(exported.markup));

  const centreLines = { ...state, style: { ...state.style, geometry: 'strokes' } };
  const stroked = renderMod.renderSvg({ state: centreLines, layout, projection, prepared, labels, pin, mode: 'export' });
  check('centre-line mode still offers stroke widths', stroked.markup.includes('stroke-width'));
  check('outline mode costs more bytes than centre lines', exported.markup.length > stroked.markup.length);

  const perLayer = { ...state, style: { ...state.style, exportColors: 'layers' } };
  const coloured = renderMod.renderSvg({ state: perLayer, layout, projection, prepared, labels, pin, mode: 'export' });
  const colours = new Set(coloured.markup.match(/(?:stroke|fill)="#[0-9a-f]{6}"/g) || []);
  check('per-layer export uses several colours', colours.size >= 5, `${colours.size} distinct`);
}

// ----------------------------------------------------- clipping artefacts
group('degenerate bridges');
{
  // Taken verbatim from the water layer, where it drew a 38 mm hairline across
  // empty slate: vertices 4-6 run out to a far apex and straight back.
  const bridged = [
    [7.1, 38.74], [7.1, 36.78], [8.05, 36.52], [9.9, 36.31], [10.91, 36.32],
    [47.57, 46.96], [47.57, 46.96], [25.75, 40.63], [25.13, 40.71], [23.26, 40.82],
    [21.38, 40.8], [19.47, 40.65], [13.7, 39.85], [11.78, 39.67], [11.68, 39.67],
  ];
  const cleaned = clip.removeCollinear(bridged);
  check('the bridge apex is removed', !cleaned.some((p) => Math.abs(p[0] - 47.57) < 0.01));
  check('the duplicate apex goes with it', cleaned.length <= bridged.length - 3);
  check('removing it barely changes the area',
    Math.abs(Math.abs(clip.signedArea(cleaned)) - Math.abs(clip.signedArea(bridged))) < 0.1);

  check('a redundant midpoint is dropped',
    clip.removeCollinear([[0, 0], [5, 0], [10, 0], [10, 10], [0, 10]]).length === 4);
  check('a plain square is left alone',
    clip.removeCollinear([[0, 0], [10, 0], [10, 10], [0, 10]]).length === 4);
  check('a 1 mm peninsula survives',
    clip.removeCollinear([[0, 0], [10, 0], [10, 5], [30, 5.5], [10, 6], [10, 10], [0, 10]]).length === 7);
  check('a lake island keeps its shape',
    clip.removeCollinear(clip.ellipsePolygon(0, 0, 4, 3, 24)).length === 24);

  // A concave subject whose visible part is two disconnected prongs is exactly
  // the case that makes Sutherland-Hodgman emit a bridge.
  const u = [[0, 0], [10, 0], [10, 10], [7, 10], [7, 3], [3, 3], [3, 10], [0, 10]];
  const band = clip.convexClipEdges([[-5, 6], [15, 6], [15, 15], [-5, 15]]);
  const clipped = clip.clipPolygon(u, band);
  const spurs = clipped.filter((p, i) => {
    const prev = clipped[(i - 1 + clipped.length) % clipped.length];
    const next = clipped[(i + 1) % clipped.length];
    const ax = next[0] - prev[0];
    const ay = next[1] - prev[1];
    const span = Math.hypot(ax, ay);
    if (span < 1e-9) return false;
    return Math.abs(ax * (p[1] - prev[1]) - ay * (p[0] - prev[0])) / span < 0.01;
  });
  check('clipping a concave shape leaves no bridge apex', spurs.length === 0);
  check('the two prongs still enclose the right area',
    Math.abs(Math.abs(clip.signedArea(clipped)) - 24) < 0.01, `${Math.abs(clip.signedArea(clipped))}`);
}

group('clipping artefacts');
{
  // A polygon reaching well past the frame used to survive as a hairline
  // strip along the edge, which reads as a stray line on the coaster.
  const state = stateMod.createDefaultState();
  state.border.scope = 'coaster';
  state.layers.landuseGreen.enabled = true;
  const raw = JSON.parse(fs.readFileSync('assets/demo/sample-city.json', 'utf8'));
  const { features } = osm.parseOverpass(raw);

  const thicknessOf = (ring) => {
    let area = 0;
    let perimeter = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      area += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
      perimeter += Math.hypot(ring[i][0] - ring[j][0], ring[i][1] - ring[j][1]);
    }
    return perimeter > 0 ? Math.abs(area / 2) / (perimeter / 2) : 0;
  };

  let hairlines = 0;
  let edgeStrokes = 0;
  let bridges = 0;
  for (const span of [900, 1200, 2500, 6000, 12000]) {
    state.view.spanMetres = span;
    const layout = layoutMod.computeLayout(state);
    const projection = geo.createProjection({
      lat: state.location.lat, lon: state.location.lon, spanMetres: span, rect: layout.projectionRect,
    });
    const prepared = prepareMod.prepareFeatures(features, { projection, clip: layout.clip, state });
    const pin = renderMod.computePin(state, layout, projection);
    prepareMod.applyKnockouts(
      prepared.byLayer,
      knockoutMod.buildKnockouts({ state, pin, labels: [], worldBounds: layout.clip.bounds })
    );

    const b = layout.clip.bounds;
    for (const bucket of prepared.byLayer.values()) {
      for (const raw of bucket.areas.flatMap((a) => [...a.outers, ...a.holes])) {
        if (thicknessOf(raw) < prepareMod.MIN_FILL_THICKNESS_MM) hairlines++;
        // A bridge apex is emitted twice; leaving the duplicate in place makes
        // every vertex look like it has a zero-distance neighbour.
        const ring = raw.filter((p, i) => {
          const q = raw[(i - 1 + raw.length) % raw.length];
          return Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-9;
        });
        for (let i = 0; i < ring.length; i++) {
          const prev = ring[(i - 1 + ring.length) % ring.length];
          const next = ring[(i + 1) % ring.length];
          const ax = next[0] - prev[0];
          const ay = next[1] - prev[1];
          const span = Math.hypot(ax, ay);
          if (span < 1e-9) continue;
          const off = Math.abs(ax * (ring[i][1] - prev[1]) - ay * (ring[i][0] - prev[0])) / span;
          // Dead on the neighbours' line but millimetres away from both of
          // them is the shape of a bridge apex, never of real coastline: a
          // gently curved edge that far out deviates by twenty times as much.
          const reach = Math.min(
            Math.hypot(ring[i][0] - prev[0], ring[i][1] - prev[1]),
            Math.hypot(ring[i][0] - next[0], ring[i][1] - next[1])
          );
          if (off < 0.004 && reach > 3) bridges++;
        }
      }
      // A stroked outline must never trace the frame itself.
      for (const line of bucket.outlines) {
        for (let i = 1; i < line.length; i++) {
          const [x0, y0] = line[i - 1];
          const [x1, y1] = line[i];
          if (Math.hypot(x1 - x0, y1 - y0) < 4) continue;
          const onEdge =
            (Math.abs(y0 - b.maxY) < 0.12 && Math.abs(y1 - b.maxY) < 0.12) ||
            (Math.abs(y0 - b.minY) < 0.12 && Math.abs(y1 - b.minY) < 0.12) ||
            (Math.abs(x0 - b.minX) < 0.12 && Math.abs(x1 - b.minX) < 0.12) ||
            (Math.abs(x0 - b.maxX) < 0.12 && Math.abs(x1 - b.maxX) < 0.12);
          if (onEdge) edgeStrokes++;
        }
      }
    }
  }
  check('clipping leaves no hairline fills', hairlines === 0, `${hairlines} found`);
  check('clipping leaves no degenerate bridges', bridges === 0, `${bridges} found`);
  check('outlined areas never trace the map frame', edgeStrokes === 0, `${edgeStrokes} found`);

  // The filter must not eat legitimately thin things.
  const narrowButReal = [[0, 0], [40, 0], [40, 0.5], [0, 0.5]];
  check('a 0.5 mm band is thicker than the artefact threshold',
    thicknessOf(narrowButReal) > prepareMod.MIN_FILL_THICKNESS_MM);
  const hairline = [[0, 0], [40, 0], [40, 0.02], [0, 0.02]];
  check('a 0.02 mm strip is below it', thicknessOf(hairline) < prepareMod.MIN_FILL_THICKNESS_MM);
}

// -------------------------------------------------------------- caption size
group('caption size');
{
  const base = stateMod.createDefaultState();
  const full = layoutMod.computeLayout(base);
  const small = stateMod.createDefaultState();
  small.caption.scale = 0.5;
  const shrunk = layoutMod.computeLayout(small);
  check('halving the caption scale halves its height',
    near(shrunk.caption.height, full.caption.height / 2, 1e-6));
  check('a smaller caption gives the map more room', shrunk.mapBox.h > full.mapBox.h);
  check('the extra room equals what the caption gave up',
    near(shrunk.mapBox.h - full.mapBox.h, full.caption.height - shrunk.caption.height, 1e-6));
  check('scaled lines carry their scaled size', near(shrunk.caption.lines[0].size, full.caption.lines[0].size / 2, 1e-9));
  check('letter spacing scales with the text',
    near(shrunk.caption.lines[1].tracking, full.caption.lines[1].tracking / 2, 1e-9));
  const big = stateMod.createDefaultState();
  big.caption.scale = 1.8;
  check('a larger caption takes room from the map', layoutMod.computeLayout(big).mapBox.h < full.mapBox.h);
}

// -------------------------------------------------------- stroke expansion
group('stroke expansion');
{
  // Arc commands carry five flags before their endpoint, so the numbers cannot
  // simply be paired off; walk the commands instead.
  const endpointsOf = (d) => {
    const pts = [];
    for (const m of d.matchAll(/([MLA])([^MLAZ]*)/g)) {
      const nums = (m[2].match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
      if (m[1] === 'A') {
        if (nums.length >= 7) pts.push([nums[5], nums[6]]);
      } else {
        for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
      }
    }
    return pts;
  };
  const bboxOf = (d) => {
    const pts = endpointsOf(d);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  };

  const straight = strokeMod.strokeOutline([[0, 0], [10, 0]], 2, { decimals: 3 });
  check('a straight line becomes a closed shape', straight.startsWith('M') && straight.endsWith('Z'));
  check('the shape is as wide as the stroke', near(bboxOf(straight).maxY - bboxOf(straight).minY, 2, 1e-6));
  check('round caps do not shorten the line', bboxOf(straight).minX <= 0 + 1e-9);
  const butt = strokeMod.strokeOutline([[0, 0], [10, 0]], 2, { cap: 'butt', decimals: 3 });
  check('butt caps stop at the endpoints', near(bboxOf(butt).minX, 0, 1e-6) && near(bboxOf(butt).maxX, 10, 1e-6));
  check('butt caps need no arcs', !butt.includes('A'));

  const corner = strokeMod.strokeOutline([[0, 0], [10, 0], [10, 10]], 2, { decimals: 3 });
  check('a corner still closes', corner.endsWith('Z'));
  check('every arc turns the same way', (corner.match(/A[-\d.]+ [-\d.]+ 0 0 1 /g) || []).length === 0);
  check('no NaN anywhere', !/NaN|Infinity/.test(corner));

  check('a zero-length line becomes a dot', strokeMod.strokeOutline([[5, 5]], 2).includes('A'));
  check('a butt-capped dot draws nothing', strokeMod.strokeOutline([[5, 5]], 2, { cap: 'butt' }) === '');
  check('duplicate points are collapsed',
    strokeMod.strokeOutline([[0, 0], [0, 0], [10, 0]], 2, { decimals: 3 }) === straight);
  check('a whole layer expands in one go',
    strokeMod.strokeOutlines([[[0, 0], [5, 0]], [[0, 5], [5, 5]]], 1).split('M').length === 3);

  const band = pathsMod.roundedRectBandPath({ x: 10, y: 10, w: 80, h: 60 }, 4, 1, 3);
  check('a frame band has an outer and an inner ring', band.split('M').length === 3);
  check('the band inner ring runs the other way',
    (band.match(/0 0 0 /g) || []).length === 4 && (band.match(/0 0 1 /g) || []).length === 4);
  const thickBand = pathsMod.roundedRectBandPath({ x: 10, y: 10, w: 4, h: 4 }, 1, 20, 3);
  check('an over-thick frame collapses to a solid shape', thickBand.split('M').length === 2);
  check('a circular band has two rings', pathsMod.ellipseBandPath(50, 50, 20, 2, 3).split('M').length === 3);
  check('an over-thick circular band is solid', pathsMod.ellipseBandPath(50, 50, 1, 20, 3).split('M').length === 2);
}

// ---------------------------------------------------------------- pin shapes
group('pin shapes');
{
  for (const style of pinshapes.PIN_STYLES) {
    const shape = pinshapes.buildPinShape(style.id, {
      cx: 50, cy: 50, radius: 8, stemLength: 5, textWidth: 22, grow: 0.8,
    });
    const points = shape.pieces.flat();
    const bad =
      /NaN|Infinity/.test(shape.path) ||
      points.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y));
    check(`${style.id} produces finite geometry`, !bad);
    check(`${style.id} has a drawable path`, shape.path.startsWith('M') && shape.path.length > 20);
    check(`${style.id} has at least one convex knockout piece`, shape.pieces.length >= 1);
  }

  // The knockout has to cover the drawn shape, or a hairline of street survives
  // under its edge and fills in the knocked-out letters.
  const covered = (style, samples = 400) => {
    const tight = pinshapes.buildPinShape(style, { cx: 0, cy: 0, radius: 10, stemLength: 6, textWidth: 24, grow: 0 });
    const grown = pinshapes.buildPinShape(style, { cx: 0, cy: 0, radius: 10, stemLength: 6, textWidth: 24, grow: 0.6 });
    const rings = grown.pieces;
    let misses = 0;
    for (let i = 0; i < samples; i++) {
      // Sample the tight shape's own bounding box, keeping points that the
      // un-grown pieces already claim, then require the grown ones to hold them.
      const t = i / samples;
      const x = tight.box.minX + (tight.box.maxX - tight.box.minX) * ((i * 7919) % samples) / samples;
      const y = tight.box.minY + (tight.box.maxY - tight.box.minY) * t;
      const inTight = tight.pieces.some((ring) => clip.pointInRing([x, y], ring));
      if (!inTight) continue;
      if (!rings.some((ring) => clip.pointInRing([x, y], ring))) misses++;
    }
    return misses;
  };
  for (const style of ['disc', 'oval', 'pill', 'heart', 'teardrop']) {
    check(`${style} knockout covers the drawn shape`, covered(style) === 0, `${covered(style)} uncovered samples`);
  }

  const narrow = pinshapes.buildPinShape('oval', { cx: 0, cy: 0, radius: 6, textWidth: 0 });
  const wide = pinshapes.buildPinShape('oval', { cx: 0, cy: 0, radius: 6, textWidth: 40 });
  check('oval stretches to hold longer text', wide.box.maxX - wide.box.minX > narrow.box.maxX - narrow.box.minX);
  check('oval keeps its height when it stretches',
    near(wide.box.maxY - wide.box.minY, narrow.box.maxY - narrow.box.minY, 1e-9));
  const pill = pinshapes.buildPinShape('pill', { cx: 0, cy: 0, radius: 6, textWidth: 40 });
  check('pill stretches too', pill.box.maxX - pill.box.minX > 40);
  const disc = pinshapes.buildPinShape('disc', { cx: 0, cy: 0, radius: 6, textWidth: 40 });
  check('disc grows whole rather than stretching',
    near(disc.box.maxX - disc.box.minX, disc.box.maxY - disc.box.minY, 1e-9) &&
      disc.box.maxX - disc.box.minX > 40);
  const smallDisc = pinshapes.buildPinShape('disc', { cx: 0, cy: 0, radius: 6, textWidth: 0 });
  check('disc keeps the requested size when the text fits',
    near(smallDisc.box.maxX - smallDisc.box.minX, 12, 1e-9));
  const bigHeart = pinshapes.buildPinShape('heart', { cx: 0, cy: 0, radius: 4, textWidth: 30 });
  check('heart grows to hold a long word', bigHeart.box.maxX - bigHeart.box.minX > 30);
  check('minRadiusForText leaves stretchy styles alone', pinshapes.minRadiusForText('oval', 40) === 0);
  check('map pin hangs below the point it marks', pinshapes.pinHeadOffset('teardrop', 8, 5) === -13);
  check('other shapes sit on the point', pinshapes.pinHeadOffset('disc', 8, 5) === 0);

  const heart = pinshapes.buildPinShape('heart', { cx: 0, cy: 0, radius: 10 });
  check('heart is wider than it is tall at the lobes', heart.box.maxX - heart.box.minX >= 19.9);
  check('heart anchors its text above centre', heart.anchorY < 0);
  check('dot is not offered text', !pinshapes.TEXT_STYLES.has('dot'));
  check('oval is offered text', pinshapes.TEXT_STYLES.has('oval'));

  // A pin whose coordinates are off the current view has to say so, or the
  // "show pin" toggle looks like it does nothing.
  const state = stateMod.createDefaultState();
  const layout = layoutMod.computeLayout(state);
  const projection = geo.createProjection({
    lat: state.location.lat, lon: state.location.lon,
    spanMetres: state.view.spanMetres, rect: layout.projectionRect,
  });
  check('a centred pin reports itself on the map',
    renderMod.computePin(state, layout, projection).onMap === true);
  const strayed = stateMod.createDefaultState();
  strayed.pin.followCentre = false;
  strayed.pin.lat = 51.5074;
  strayed.pin.lon = -0.1278;
  check('a pin left in another city reports itself off the map',
    renderMod.computePin(strayed, layout, projection).onMap === false);
  const off = stateMod.createDefaultState();
  off.pin.enabled = false;
  check('no pin at all when it is switched off', renderMod.computePin(off, layout, projection) === null);
}

// ----------------------------------------------------------- caption offsets
group('caption placement');
{
  const base = stateMod.createDefaultState();
  const plain = layoutMod.computeLayout(base);
  const moved = stateMod.createDefaultState();
  moved.caption.offsetX = 6;
  moved.caption.offsetY = -4;
  const shifted = layoutMod.computeLayout(moved);
  check('caption offset moves the caption', near(shifted.caption.top, plain.caption.top - 4, 1e-9) &&
    near(shifted.caption.centerX, plain.caption.centerX + 6, 1e-9));
  check('caption offset leaves the map window alone',
    near(shifted.mapBox.h, plain.mapBox.h, 1e-9) && near(shifted.mapBox.y, plain.mapBox.y, 1e-9));
  check('caption exposes a grab box', plain.caption.box.maxX > plain.caption.box.minX && plain.caption.hasText);
  check('grab box tracks the offset', near(shifted.caption.box.minX, plain.caption.box.minX + 6, 1e-9));

  const nudged = stateMod.createDefaultState();
  nudged.caption.lines[1].offsetX = 5;
  const perLine = layoutMod.computeLayout(nudged);
  check('a single line can be nudged sideways', perLine.caption.box.maxX > plain.caption.box.maxX);

  const empty = stateMod.createDefaultState();
  empty.caption.lines = [];
  check('an empty caption has no grab box', layoutMod.computeLayout(empty).caption.hasText === false);
}

// -------------------------------------------------------------- state & files
group('state and files');
{
  const fresh = stateMod.createDefaultState();
  const round = stateMod.hydrate(JSON.parse(JSON.stringify(fresh)));
  check('state survives a JSON round-trip', JSON.stringify(round) === JSON.stringify(fresh));
  const partial = stateMod.hydrate({ pin: { text: 'Family' }, caption: { lines: [{ text: 'York' }] } });
  check('partial designs merge onto defaults', partial.pin.text === 'Family' && partial.pin.radius === fresh.pin.radius);
  check('restored caption lines get every field', partial.caption.lines[0].lineHeight === fresh.caption.lines[0].lineHeight);
  check('unknown input falls back to defaults', stateMod.hydrate(null).pin.text === fresh.pin.text);
  check('filename is slugified', exportMod.suggestedName(fresh, 'svg') === 'cincinnati-ohio-coaster-100mm.svg');
  check('slugify copes with punctuation', exportMod.slugify('York, Pennsylvania!') === 'york-pennsylvania');

  const store = stateMod.createStore(fresh);
  let seen = 0;
  let lastMeta = null;
  const off = store.subscribe((_, meta) => { seen++; lastMeta = meta; });
  store.set((s) => { s.pin.text = 'Home sweet home'; });
  check('store notifies subscribers', seen === 1 && store.get().pin.text === 'Home sweet home');
  check('tracked changes carry the previous state for undo',
    lastMeta.before?.pin.text === 'Home' && store.get().pin.text === 'Home sweet home');
  store.set((s) => { s.pin.text = 'y'; }, { track: false });
  check('untracked changes carry no history entry', lastMeta.before === null);
  store.set((s) => { s.location.query = 'typing'; }, { silent: true });
  check('silent changes carry no history entry', lastMeta.before === null);
  off();
  store.set((s) => { s.pin.text = 'x'; });
  check('unsubscribe stops notifications', seen === 3);
  check('snapshot is a deep copy', (() => {
    const snap = stateMod.snapshot(store.get());
    snap.caption.lines[0].text = 'changed';
    return store.get().caption.lines[0].text !== 'changed';
  })());
}

// -------------------------------------------------------------------- browser
if (!process.argv.includes('--no-browser')) {
  group('browser');
  let server;
  let browser;
  try {
    const { chromium } = await import('playwright');
    const { resolveChromium } = await import('./chromium.mjs');
    const port = 5199;
    server = spawn(process.execPath, ['server.js', String(port)], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 700));

    browser = await chromium.launch(resolveChromium());
    const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'coaster-'));
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, acceptDownloads: true });
    const page = await ctx.newPage();
    const problems = [];
    page.on('pageerror', (e) => problems.push(e.message));
    page.on('console', (m) => {
      const t = m.text();
      if (m.type() === 'error' && !/ERR_|Failed to load resource|Failed to fetch/.test(t)) problems.push(t);
    });

    await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#preview svg', { timeout: 15000 });
    check('the app boots and draws', true);

    await page.getByRole('button', { name: 'Use demo city' }).click();
    await page.waitForFunction(() => /demo data/.test(document.querySelector('.stats')?.textContent || ''), null, { timeout: 15000 });
    check('demo city loads without a network', true);

    await page.evaluate(() => document.querySelectorAll('details.section').forEach((d) => (d.open = true)));
    await page.getByText('Show labels', { exact: true }).click();
    await page.waitForTimeout(400);
    const labelCount = await page.evaluate(() => document.querySelectorAll('#labels path').length);
    check('labels appear in the preview', labelCount > 5, `${labelCount} label paths`);

    // Every marker shape has to survive a round trip through the real renderer.
    for (const shape of ['Disc', 'Oval', 'Pill', 'Heart', 'Map pin', 'Ring', 'Dot']) {
      await page.getByRole('button', { name: shape, exact: true }).click();
      await page.waitForTimeout(220);
      const paths = await page.locator('#pin path').count();
      const d = await page.locator('#pin path').first().getAttribute('d');
      check(`${shape} marker renders`, paths > 0 && !!d && !/NaN/.test(d));
    }
    await page.getByRole('button', { name: 'Oval', exact: true }).click();
    await page.locator('input[placeholder="Home"]').fill('Family');
    await page.waitForTimeout(400);

    // The oval is the reference-photo shape: it should hug a longer word.
    // Measured with getBBox rather than by parsing path data, which now carries
    // arc flags that cannot be paired off as coordinates.
    const ovalWidth = () =>
      page.evaluate(() => document.querySelector('#pin path').getBBox().width);
    const shortWord = await ovalWidth();
    await page.locator('input[placeholder="Home"]').fill('Grandma and Grandpa');
    await page.waitForTimeout(400);
    check('the oval grows to fit a longer word', (await ovalWidth()) > shortWord);
    await page.locator('input[placeholder="Home"]').fill('Family');
    await page.waitForTimeout(300);

    await page.getByRole('button', { name: 'Add a line' }).click();
    await page.waitForTimeout(300);
    check('caption gains a third line', (await page.locator('.caption-line').count()) === 3);

    await page.getByRole('button', { name: 'Circle', exact: true }).click();
    await page.waitForTimeout(400);
    const circleViewBox = await page.getAttribute('#preview svg', 'viewBox');
    check('circle coaster redraws', circleViewBox === '0 0 100 100');
    await page.getByRole('button', { name: 'Rounded', exact: true }).click();
    await page.waitForTimeout(300);

    // Pan and zoom.
    const before = await page.evaluate(() => JSON.parse(localStorage.getItem('city-map-coaster:design:v1')));
    await page.mouse.move(500, 400);
    await page.mouse.down();
    await page.mouse.move(560, 450, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => JSON.parse(localStorage.getItem('city-map-coaster:design:v1')));
    check('dragging pans the map', after.location.lat !== before.location.lat);
    check('the design persists to localStorage', Boolean(after.coaster));

    // --- the caption size slider is the quick way to reclaim map space
    const mapHeight = () =>
      page.evaluate(() => document.querySelector('#layer-residential path').getBBox().height);
    const captionText = () => page.locator('#caption-height-note').textContent();
    const beforeShrink = await mapHeight();
    const captionSlider = page.locator('#caption-scale input[type=range]');
    await captionSlider.fill('0.5');
    await page.waitForTimeout(500);
    check('shrinking the caption gives the map more height', (await mapHeight()) > beforeShrink);
    check('the panel reports the reserved caption height', /reserves \d/.test(await captionText()));
    await captionSlider.fill('1');
    await page.waitForTimeout(400);

    // --- a pin stranded in another city must not silently vanish
    await page.evaluate(() => {
      const key = 'city-map-coaster:design:v1';
      const design = JSON.parse(localStorage.getItem(key));
      design.pin.enabled = true;
      design.pin.followCentre = false;
      design.pin.lat = 51.5074;
      design.pin.lon = -0.1278;
      localStorage.setItem(key, JSON.stringify(design));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#preview svg');
    await page.getByRole('button', { name: 'Use demo city' }).click();
    await page.waitForFunction(() => /demo data/.test(document.querySelector('.stats')?.textContent || ''));
    await page.evaluate(() => document.querySelectorAll('details.section').forEach((d) => (d.open = true)));
    await page.waitForTimeout(400);
    check('loading a city rescues a stranded pin', (await page.locator('.notice').isVisible()) === false);

    await page.evaluate(() => {
      const key = 'city-map-coaster:design:v1';
      const design = JSON.parse(localStorage.getItem(key));
      design.pin.followCentre = false;
      design.pin.lat = 51.5074;
      design.pin.lon = -0.1278;
      localStorage.setItem(key, JSON.stringify(design));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#preview svg');
    await page.evaluate(() => document.querySelectorAll('details.section').forEach((d) => (d.open = true)));
    await page.waitForTimeout(400);
    check('an off-map pin is called out', await page.locator('.notice').isVisible());

    // Toggling the pin off and on has to put something on screen.
    await page.getByText('Show a pin', { exact: true }).click();
    await page.waitForTimeout(300);
    await page.getByText('Show a pin', { exact: true }).click();
    await page.waitForTimeout(500);
    const pinInView = await page.evaluate(() => {
      const pin = document.querySelector('#pin path');
      if (!pin) return null;
      const svg = document.querySelector('#preview svg').getBoundingClientRect();
      const box = pin.getBoundingClientRect();
      return box.width > 0 && box.left >= svg.left - 1 && box.right <= svg.right + 1 &&
        box.top >= svg.top - 1 && box.bottom <= svg.bottom + 1;
    });
    check('switching the pin on always shows it', pinInView === true);
    check('the off-map notice clears once it is back', (await page.locator('.notice').isVisible()) === false);
    await page.getByRole('button', { name: 'Use demo city' }).click();
    await page.waitForFunction(() => /demo data/.test(document.querySelector('.stats')?.textContent || ''));
    await page.waitForTimeout(300);

    // --- border around the whole face, caption included
    await page.getByRole('button', { name: 'Map + caption', exact: true }).click();
    await page.waitForTimeout(350);
    const borderHeight = () => page.evaluate(() => document.querySelector('#border path').getBBox().height);
    const wholeFaceBorder = await borderHeight();
    await page.getByRole('button', { name: 'Map only', exact: true }).click();
    await page.waitForTimeout(350);
    const mapOnlyBorder = await borderHeight();
    check('the border can enclose the caption too', wholeFaceBorder > mapOnlyBorder + 5,
      `${wholeFaceBorder.toFixed(1)} vs ${mapOnlyBorder.toFixed(1)}`);

    // --- dragging the caption moves only the caption
    const captionBefore = await page.evaluate(() => document.querySelector('#caption path').getAttribute('d'));
    const mapBefore = await page.evaluate(() => document.querySelector('#layer-residential path').getAttribute('d'));
    const captionPoint = await page.evaluate(() => {
      const svg = document.querySelector('#preview svg');
      const box = svg.getBoundingClientRect();
      const caption = document.querySelector('#caption').getBoundingClientRect();
      return { x: caption.left + caption.width / 2, y: caption.top + caption.height / 2, ok: box.width > 0 };
    });
    await page.mouse.move(captionPoint.x, captionPoint.y);
    await page.mouse.down();
    await page.mouse.move(captionPoint.x + 40, captionPoint.y - 12, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(350);
    const captionAfter = await page.evaluate(() => document.querySelector('#caption path').getAttribute('d'));
    const mapAfter = await page.evaluate(() => document.querySelector('#layer-residential path').getAttribute('d'));
    check('dragging the caption moves it', captionBefore !== captionAfter);
    check('dragging the caption leaves the map alone', mapBefore === mapAfter);

    // --- undo and redo
    const offsetNow = await page.evaluate(() => JSON.parse(localStorage.getItem('city-map-coaster:design:v1')).caption.offsetX);
    check('the caption offset was recorded', Math.abs(offsetNow) > 1);
    await page.getByRole('button', { name: /Undo/ }).click();
    await page.waitForTimeout(350);
    const offsetUndone = await page.evaluate(() => JSON.parse(localStorage.getItem('city-map-coaster:design:v1')).caption.offsetX);
    check('undo reverts the caption move', Math.abs(offsetUndone) < Math.abs(offsetNow));
    await page.getByRole('button', { name: /Redo/ }).click();
    await page.waitForTimeout(350);
    const offsetRedone = await page.evaluate(() => JSON.parse(localStorage.getItem('city-map-coaster:design:v1')).caption.offsetX);
    check('redo puts it back', Math.abs(offsetRedone - offsetNow) < 0.01);

    await page.keyboard.press('Control+z');
    await page.waitForTimeout(300);
    check('ctrl+z undoes too',
      Math.abs(await page.evaluate(() => JSON.parse(localStorage.getItem('city-map-coaster:design:v1')).caption.offsetX)) < Math.abs(offsetNow));
    await page.getByRole('button', { name: /Redo/ }).click();
    await page.waitForTimeout(250);

    // --- searching a place fills the caption without any typing
    await page.route('**/nominatim.openstreetmap.org/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            lat: '39.9943', lon: '-76.7298',
            display_name: 'York, York County, Pennsylvania, United States',
            boundingbox: ['39.9', '40.1', '-76.8', '-76.6'],
            address: { city: 'York', state: 'Pennsylvania', country: 'United States' },
          },
        ]),
      })
    );
    await page.locator('input[placeholder="e.g. York, Pennsylvania"]').fill('York PA');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.waitForSelector('.result', { timeout: 10000 });
    await page.locator('.result').first().click();
    await page.waitForTimeout(700);
    const captionLines = await page.evaluate(() =>
      [...document.querySelectorAll('.caption-line input[type=text]')].map((i) => i.value)
    );
    check('searching fills the place name', captionLines[0] === 'York, Pennsylvania', captionLines.join(' | '));
    check('searching fills the coordinates',
      captionLines[1] === '39.9943° N, 76.7298° W', captionLines.join(' | '));
    const centred = await page.evaluate(() => JSON.parse(localStorage.getItem('city-map-coaster:design:v1')).location);
    check('searching recentres the map', Math.abs(centred.lat - 39.9943) < 1e-6);

    // --- reset, and undo of reset
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Reset to defaults' }).click();
    await page.waitForTimeout(500);
    const afterReset = await page.evaluate(() => JSON.parse(localStorage.getItem('city-map-coaster:design:v1')));
    check('reset restores the defaults', afterReset.caption.offsetX === 0 && afterReset.pin.text === 'Home');
    await page.getByRole('button', { name: /Undo/ }).click();
    await page.waitForTimeout(400);
    const afterUndoReset = await page.evaluate(() => JSON.parse(localStorage.getItem('city-map-coaster:design:v1')));
    check('reset itself can be undone', afterUndoReset.pin.text === 'Family');

    const download = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download SVG' }).click(),
    ]).then(([d]) => d);
    const file = path.join(downloads, download.suggestedFilename());
    await download.saveAs(file);
    const svg = fs.readFileSync(file, 'utf8');
    check('export downloads with a sensible name', /\.svg$/.test(download.suggestedFilename()));
    check('exported file is a real SVG', svg.startsWith('<?xml') && svg.includes('<svg'));
    check('exported file is millimetre-sized', /width="100mm"/.test(svg) && /viewBox="0 0 100 100"/.test(svg));
    check('exported file has no live text or clip paths', !svg.includes('<text') && !/clip-?[Pp]ath/.test(svg));

    // Round-trip a saved design.
    const design = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Save design' }).click(),
    ]).then(([d]) => d);
    const designFile = path.join(downloads, design.suggestedFilename());
    await design.saveAs(designFile);
    const parsed = JSON.parse(fs.readFileSync(designFile, 'utf8'));
    check('saved design captures the edits', parsed.pin.text === 'Family' && parsed.caption.lines.length === 3);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#preview svg', { timeout: 15000 });
    const restored = await page.locator('input[placeholder="Home"]').inputValue();
    check('a reload restores the design', restored === 'Family');

    // Outlined geometry has to *look* like the strokes it replaces, or the
    // offsetting maths is wrong in a way no attribute check would catch.
    const bothModes = await page.evaluate(async () => {
      const render = (geometry) => {
        const key = 'city-map-coaster:design:v1';
        const design = JSON.parse(localStorage.getItem(key));
        design.style.geometry = geometry;
        return design;
      };
      return [render('outlines'), render('strokes')];
    });
    const svgs = [];
    for (const design of bothModes) {
      await page.evaluate((d) => {
        localStorage.setItem('city-map-coaster:design:v1', JSON.stringify(d));
      }, design);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#preview svg');
      await page.getByRole('button', { name: 'Use demo city' }).click();
      await page.waitForFunction(() => /demo data/.test(document.querySelector('.stats')?.textContent || ''));
      await page.waitForTimeout(600);
      svgs.push(await page.evaluate(() => document.querySelector('#preview svg').outerHTML));
    }
    const mismatch = await page.evaluate(async ([a, b]) => {
      const draw = (svg) =>
        new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            const c = document.createElement('canvas');
            c.width = 900;
            c.height = 900;
            const ctx = c.getContext('2d');
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, 900, 900);
            ctx.drawImage(img, 0, 0, 900, 900);
            resolve(ctx.getImageData(0, 0, 900, 900).data);
          };
          img.onerror = () => resolve(null);
          img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
        });
      const [pa, pb] = [await draw(a), await draw(b)];
      if (!pa || !pb) return null;
      let differing = 0;
      let ink = 0;
      for (let i = 0; i < pa.length; i += 4) {
        if (pa[i] < 128) ink++;
        if (Math.abs(pa[i] - pb[i]) > 60) differing++;
      }
      return { differing, ink };
    }, svgs);
    check('both geometry modes render the same picture',
      mismatch && mismatch.ink > 1000 && mismatch.differing / mismatch.ink < 0.03,
      mismatch ? `${((100 * mismatch.differing) / mismatch.ink).toFixed(2)}% of ink differs` : 'render failed');

    // --- the vector tile path, end to end in a real browser
    const tileServer2 = spawn(process.execPath, ['tools/mock-tiles.mjs', '5403'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const tileUrl = `http://localhost:${port}/?tiles=${encodeURIComponent('http://localhost:5403/planet')}`;
      await page.goto(tileUrl, { waitUntil: 'domcontentloaded' });
      await page.evaluate(async () => {
        localStorage.setItem('city-map-coaster:design:v1', JSON.stringify({ view: { spanMetres: 2500 } }));
        await new Promise((resolve) => {
          const request = indexedDB.deleteDatabase('city-map-coaster');
          request.onsuccess = request.onerror = request.onblocked = resolve;
        });
      });
      const started = Date.now();
      await page.goto(tileUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () => /vector tiles/.test(document.querySelector('#status')?.textContent || ''),
        null,
        { timeout: 25000 }
      );
      const tileElapsed = Date.now() - started;
      check('the map loads from vector tiles', true);
      check('and does so quickly', tileElapsed < 8000, `${tileElapsed}ms`);
      check('streets are drawn', (await page.locator('#layer-residential path').count()) > 0);
      check('buildings are drawn', (await page.locator('#layer-buildings path').count()) > 0);

      const requestsBefore = (await (await fetch('http://localhost:5403/__log')).json()).served;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () => /from cache/.test(document.querySelector('#status')?.textContent || ''),
        null,
        { timeout: 25000 }
      );
      const requestsAfter = (await (await fetch('http://localhost:5403/__log')).json()).served;
      check('a repeat view fetches no tiles', requestsAfter === requestsBefore);
    } finally {
      tileServer2.kill();
    }

    // --- the real fetching path, pointed at the mock server
    const mockServer = spawn(process.execPath, ['tools/mock-overpass.mjs', '5302', '--delay', '150'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 600));
    try {
      const mockUrl = `http://localhost:${port}/?overpass=${encodeURIComponent('http://localhost:5302/api/interpreter')}`;
      await page.goto(mockUrl, { waitUntil: 'domcontentloaded' });
      // Force the Overpass path, which is now only the fallback.
      await page.evaluate(() => {
        localStorage.setItem('city-map-coaster:design:v1', JSON.stringify({ data: { source: 'overpass' } }));
      });
      await page.evaluate(async () => {
        await new Promise((resolve) => {
          const request = indexedDB.deleteDatabase('city-map-coaster');
          request.onsuccess = request.onerror = request.onblocked = resolve;
        });
      });
      await page.goto(mockUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () => /Loaded [\d,]+ map features/.test(document.querySelector('#status')?.textContent || ''),
        null,
        { timeout: 20000 }
      );
      check('the app loads real map data over the network', true);
      check('streets came through', (await page.locator('#layer-residential path').count()) > 0);

      const firstStatus = await page.locator('#status').textContent();
      check('the first load is not served from cache', !/from cache/.test(firstStatus), firstStatus);

      // Second visit to the same view must not touch the network at all.
      const before = (await (await fetch('http://localhost:5302/__log')).json()).served;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () => /Loaded [\d,]+ map features/.test(document.querySelector('#status')?.textContent || ''),
        null,
        { timeout: 20000 }
      );
      const after = (await (await fetch('http://localhost:5302/__log')).json()).served;
      const cachedStatus = await page.locator('#status').textContent();
      check('a repeat view is served from the cache', /from cache/.test(cachedStatus), cachedStatus);
      check('and makes no further requests', after === before, `${after - before} extra requests`);

      // Streets and buildings are asked for separately so the map can draw early.
      const log = (await (await fetch('http://localhost:5302/__log')).json()).log;
      const buildingQueries = log.filter((e) => /\["building"\]/.test(e.query));
      const streetQueries = log.filter((e) => /\["highway"\]/.test(e.query));
      check('streets and buildings are fetched separately',
        streetQueries.length > 0 && buildingQueries.length > 0 &&
          !streetQueries.some((e) => /\["building"\]/.test(e.query)));
    } finally {
      mockServer.kill();
    }

    check('no unexpected console errors', problems.length === 0, problems.slice(0, 3).join(' | '));
    fs.rmSync(downloads, { recursive: true, force: true });
  } catch (err) {
    check('browser suite ran', false, err.message);
  } finally {
    await browser?.close();
    server?.kill();
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
