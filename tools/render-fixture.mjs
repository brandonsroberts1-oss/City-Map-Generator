// Headless render of the demo fixture straight to an SVG file, so the geometry
// pipeline can be checked without a browser.
//   node tools/render-fixture.mjs out.svg [--preset name]

import { createRequire } from 'module';
import fs from 'fs';

const require = createRequire(import.meta.url);
globalThis.opentype = require('opentype.js');
globalThis.fetch = async (u) => {
  const b = fs.readFileSync(u.replace(/^\//, ''));
  return { ok: true, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
};

const { createDefaultState } = await import('../src/state.js');
const { parseOverpass } = await import('../src/osm.js');
const { computeLayout } = await import('../src/layout.js');
const { createProjection } = await import('../src/geo.js');
const { prepareFeatures, applyKnockouts } = await import('../src/prepare.js');
const { buildKnockouts } = await import('../src/knockouts.js');
const { placeLabels } = await import('../src/labels.js');
const { renderSvg, computePin } = await import('../src/render.js');
const { preloadAll } = await import('../src/typography.js');

await preloadAll();

const state = createDefaultState();
state.location = { query: 'Sample City', lat: 39.1031, lon: -84.512, label: 'Sample City', region: 'Ohio' };
state.caption.lines[0].text = 'Sample City, Ohio';
state.caption.lines[1].text = '39.1031° N, 84.5120° W';
state.labels.enabled = true;
state.layers.landuseGreen.enabled = true;

const presets = {
  default: () => {},
  labels: (s) => {
    s.labels.enabled = true;
    s.labels.maxLabels = 30;
  },
  circle: (s) => {
    s.coaster.shape = 'circle';
    s.border.scope = 'coaster';
  },
  outline: (s) => {
    s.layers.buildings.mode = 'outline';
    s.layers.water.mode = 'outline';
    s.pin.style = 'teardrop';
  },
  noborder: (s) => {
    s.border.enabled = false;
    s.coaster.margin = 0;
    s.pin.enabled = false;
  },
};

const presetName = process.argv.includes('--preset')
  ? process.argv[process.argv.indexOf('--preset') + 1]
  : 'default';
(presets[presetName] || presets.default)(state);

const raw = JSON.parse(fs.readFileSync('assets/demo/sample-city.json', 'utf8'));
const t0 = Date.now();
const { features, counts } = parseOverpass(raw);
const tParse = Date.now();

const layout = computeLayout(state);
const projection = createProjection({
  lat: state.location.lat,
  lon: state.location.lon,
  spanMetres: state.view.spanMetres,
  rect: layout.projectionRect,
});
const prepared = prepareFeatures(features, { projection, clip: layout.clip, state });
const pin = computePin(state, layout, projection);
const labels = state.labels.enabled
  ? placeLabels(prepared.labelCandidates, {
      clip: layout.clip,
      settings: state.labels,
      reserved: pin ? [pin.box] : [],
    })
  : [];
const knockouts = buildKnockouts({
  state,
  pin,
  labels,
  worldBounds: layout.clip.bounds,
});
applyKnockouts(prepared.byLayer, knockouts);
const tPrep = Date.now();

for (const mode of ['preview', 'export']) {
  const { markup, stats } = renderSvg({ state, layout, projection, prepared, labels, pin, mode });
  const out = (process.argv[2] || 'out.svg').replace(/\.svg$/, `.${mode}.svg`);
  fs.writeFileSync(out, markup);
  if (mode === 'export') {
    console.log(
      `${presetName}: parse ${tParse - t0}ms, prepare ${tPrep - tParse}ms | features ${features.length} | ` +
        `layers ${stats.layers} | labels ${labels.length} | ${out} ${(markup.length / 1024).toFixed(0)}KB`
    );
  }
}
console.log('  counts:', JSON.stringify(counts));
console.log('  prepared:', [...prepared.byLayer].map(([k, v]) => `${k}:${v.lines.length || v.areas.length}`).join(' '));
console.log('  labels:', labels.slice(0, 8).map((l) => l.text).join(' | '));
