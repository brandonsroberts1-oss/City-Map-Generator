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
globalThis.fetch = async (url) => {
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
const renderMod = await import('../src/render.js');
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
  check('query carries the bbox', q.includes('1.000000,2.000000,3.000000,4.000000'));
  check('query asks for highways', q.includes('way["highway"]'));
  check('query asks for buildings', q.includes('way["building"]'));
  check('query skips families not requested', !q.includes('waterway'));
  check('query recurses to nodes', q.includes('out body;') && q.includes('>;'));
  check('unknown families are ignored', !overpass.buildQuery({ south: 0, west: 0, north: 1, east: 1 }, ['nope']).includes('nope'));
  check('parseLatLon reads a pasted pair', geocode.parseLatLon('39.9943, -76.7298')?.lat === 39.9943);
  check('parseLatLon rejects out-of-range', geocode.parseLatLon('200, 400') === null);
  check('parseLatLon rejects prose', geocode.parseLatLon('York PA') === null);
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
  check('a knockout exists for the pin and each label', knockouts.length === labels.length + 1);
  prepareMod.applyKnockouts(prepared.byLayer, knockouts);

  // Nothing may survive inside the pin disc.
  const rSq = (state.pin.radius + state.pin.clearance) ** 2;
  let insidePin = 0;
  for (const bucket of prepared.byLayer.values()) {
    for (const geom of [...bucket.lines, ...bucket.outlines, ...bucket.areas.flatMap((a) => a.outers)]) {
      for (const [x, y] of geom) {
        if ((x - pin.x) ** 2 + (y - pin.headY) ** 2 < rSq - 1e-3) insidePin++;
      }
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

  const perLayer = { ...state, style: { ...state.style, exportColors: 'layers' } };
  const coloured = renderMod.renderSvg({ state: perLayer, layout, projection, prepared, labels, pin, mode: 'export' });
  const colours = new Set(coloured.markup.match(/(?:stroke|fill)="#[0-9a-f]{6}"/g) || []);
  check('per-layer export uses several colours', colours.size >= 5, `${colours.size} distinct`);
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
  const off = store.subscribe(() => seen++);
  store.set((s) => { s.pin.text = 'Home sweet home'; });
  check('store notifies subscribers', seen === 1 && store.get().pin.text === 'Home sweet home');
  off();
  store.set((s) => { s.pin.text = 'x'; });
  check('unsubscribe stops notifications', seen === 1);
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

    await page.getByRole('button', { name: 'Map pin', exact: true }).click();
    await page.locator('input[placeholder="Home"]').fill('Family');
    await page.waitForTimeout(400);
    check('pin renders after edits', (await page.locator('#pin path').count()) > 0);

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
