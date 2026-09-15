// A stand-in for the Overpass API, so the fetching path can be tested without
// depending on (or hammering) the real servers.
//
//   node tools/mock-overpass.mjs 5300 --delay 200
//
// Query string on the endpoint controls the simulated behaviour:
//   ?busy=1      answer 504 immediately
//   ?stall=1     accept the request and never reply (the hang we had in the wild)
//   ?delay=2000  wait this long before replying

import { createServer } from 'http';
import { readFileSync } from 'fs';

const port = Number(process.argv[2] || 5300);
const baseDelay = Number(process.argv[process.argv.indexOf('--delay') + 1]) || 0;

const fixture = JSON.parse(readFileSync('assets/demo/sample-city.json', 'utf8'));
const nodes = new Map();
for (const el of fixture.elements) if (el.type === 'node') nodes.set(el.id, el);

/** The fixture is stored in body+node form; serve it the way `out geom` does. */
function toGeomElements(bbox, wantBuildings) {
  const [south, west, north, east] = bbox;
  const out = [];
  const inBox = (pt) => pt.lat >= south && pt.lat <= north && pt.lon >= west && pt.lon <= east;

  for (const el of fixture.elements) {
    if (el.type === 'way') {
      if (!el.tags) continue;
      if (el.tags.building && !wantBuildings) continue;
      const geometry = (el.nodes || []).map((id) => nodes.get(id)).filter(Boolean)
        .map((n) => ({ lat: n.lat, lon: n.lon }));
      if (!geometry.length || !geometry.some(inBox)) continue;
      out.push({ type: 'way', id: el.id, nodes: el.nodes, geometry, tags: el.tags });
    } else if (el.type === 'relation') {
      const members = (el.members || []).map((m) => {
        const way = fixture.elements.find((w) => w.type === 'way' && w.id === m.ref);
        const geometry = (way?.nodes || []).map((id) => nodes.get(id)).filter(Boolean)
          .map((n) => ({ lat: n.lat, lon: n.lon }));
        return { ...m, geometry };
      });
      if (!members.some((m) => m.geometry.some(inBox))) continue;
      out.push({ type: 'relation', id: el.id, members, tags: el.tags });
    }
  }
  return out;
}

let served = 0;
const log = [];

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname === '/__log') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ served, log }));
    return;
  }
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const query = decodeURIComponent((body.match(/data=([\s\S]*)/) || [, ''])[1].replace(/\+/g, ' '));
    served += 1;
    log.push({ at: Date.now(), endpoint: url.pathname + url.search, bytes: query.length, query });

    if (url.searchParams.get('stall')) return; // never answers, on purpose
    if (url.searchParams.get('busy')) {
      res.writeHead(504, { 'Content-Type': 'text/plain' }).end('server load too high');
      return;
    }
    const bboxMatch = query.match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/);
    const bbox = bboxMatch ? bboxMatch.slice(1, 5).map(Number) : [-90, -180, 90, 180];
    const wantBuildings = /\["building"\]/.test(query);
    const payload = JSON.stringify({ version: 0.6, generator: 'mock', elements: toGeomElements(bbox, wantBuildings) });
    const delay = Number(url.searchParams.get('delay') || baseDelay);
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(payload);
    }, delay);
  });
}).listen(port, () => console.log(`mock overpass on http://localhost:${port}`));
