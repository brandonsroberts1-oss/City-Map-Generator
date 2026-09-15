// A stand-in vector tile server, so the tile path can be tested without
// depending on a public one. Serves the demo city re-tagged into the
// OpenMapTiles schema that real servers use.
//
//   node tools/mock-tiles.mjs 5400

import { createServer } from 'http';
import { readFileSync } from 'fs';
import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';

const port = Number(process.argv[2] || 5400);
const fixture = JSON.parse(readFileSync('assets/demo/sample-city.json', 'utf8'));
const nodes = new Map();
for (const el of fixture.elements) if (el.type === 'node') nodes.set(el.id, el);

const ROAD_CLASS = {
  motorway: 'motorway', trunk: 'trunk', primary: 'primary', secondary: 'secondary',
  tertiary: 'tertiary', residential: 'minor', unclassified: 'minor', service: 'service',
  footway: 'path', path: 'path',
};

/** The fixture's OSM tags, expressed the way a real tile server would. */
function buildLayers() {
  const layers = {
    transportation: [], transportation_name: [], waterway: [], water: [],
    water_name: [], building: [], park: [], landcover: [],
  };
  const coords = (way) => (way.nodes || []).map((id) => nodes.get(id)).filter(Boolean).map((n) => [n.lon, n.lat]);
  const add = (layer, geometry, properties) =>
    layers[layer].push({ type: 'Feature', properties, geometry });

  for (const el of fixture.elements) {
    if (el.type !== 'way' || !el.tags) continue;
    const points = coords(el);
    if (points.length < 2) continue;
    const t = el.tags;
    const closed = points.length > 3 &&
      points[0][0] === points[points.length - 1][0] && points[0][1] === points[points.length - 1][1];

    if (t.highway && ROAD_CLASS[t.highway]) {
      add('transportation', { type: 'LineString', coordinates: points }, { class: ROAD_CLASS[t.highway] });
      if (t.name) {
        add('transportation_name', { type: 'LineString', coordinates: points }, { class: ROAD_CLASS[t.highway], name: t.name });
      }
    } else if (t.waterway) {
      add('waterway', { type: 'LineString', coordinates: points }, { class: t.waterway, name: t.name });
    } else if (t.natural === 'water' && closed) {
      add('water', { type: 'Polygon', coordinates: [points] }, { class: 'lake' });
      if (t.name) add('water_name', { type: 'Point', coordinates: points[0] }, { class: 'lake', name: t.name });
    } else if (t.building && closed) {
      add('building', { type: 'Polygon', coordinates: [points] }, {});
    } else if (t.leisure === 'park' && closed) {
      add('park', { type: 'Polygon', coordinates: [points] }, { class: 'park', name: t.name });
    } else if (t.landuse === 'forest' && closed) {
      add('landcover', { type: 'Polygon', coordinates: [points] }, { class: 'wood', name: t.name });
    }
  }
  const indexes = {};
  for (const [name, features] of Object.entries(layers)) {
    if (!features.length) continue;
    indexes[name] = new geojsonvt({ type: 'FeatureCollection', features }, {
      maxZoom: 14, indexMaxZoom: 14, buffer: 64, tolerance: 1,
    });
  }
  return indexes;
}

const indexes = buildLayers();
let served = 0;

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const cors = { 'Access-Control-Allow-Origin': '*' };

  if (url.pathname === '/__log') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify({ served }));
    return;
  }
  if (url.pathname === '/planet') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        tilejson: '3.0.0',
        tiles: [`http://localhost:${port}/planet/{z}/{x}/{y}.pbf`],
        minzoom: 0,
        maxzoom: 14,
        attribution: 'mock',
      })
    );
    return;
  }
  const match = url.pathname.match(/^\/planet\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
  if (!match) {
    res.writeHead(404, cors).end();
    return;
  }
  served += 1;
  const [z, x, y] = match.slice(1).map(Number);
  const tiles = {};
  for (const [name, index] of Object.entries(indexes)) {
    const tile = index.getTile(z, x, y);
    if (tile && tile.features.length) tiles[name] = tile;
  }
  if (!Object.keys(tiles).length) {
    res.writeHead(204, cors).end();
    return;
  }
  const buffer = vtpbf.fromGeojsonVt(tiles, { version: 2 });
  res.writeHead(200, { ...cors, 'Content-Type': 'application/vnd.mapbox-vector-tile' }).end(Buffer.from(buffer));
}).listen(port, () => console.log(`mock tiles on http://localhost:${port}/planet`));
