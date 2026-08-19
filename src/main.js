// Wires everything together: store → data → geometry → SVG → screen, plus the
// direct-manipulation bits (pan, zoom, click-to-place-pin) on the preview.

import { createStore, loadSaved, persist, createDefaultState, hydrate, snapshot } from './state.js';
import { LAYER_DATA_NEEDS } from './layers.js';
import { createProjection, padBounds, boundsContain, formatCoordinate } from './geo.js';
import { computeLayout } from './layout.js';
import { prepareFeatures, applyKnockouts } from './prepare.js';
import { buildKnockouts } from './knockouts.js';
import { placeLabels } from './labels.js';
import { renderSvg, computePin } from './render.js';
import { parseOverpass } from './osm.js';
import { fetchOverpass } from './overpass.js';
import { geocode } from './geocode.js';
import { preloadFonts, preloadAll, fontFaceCss } from './typography.js';
import { buildPanel } from './ui.js';
import { downloadSvg, downloadDesign, readDesignFile, suggestedName } from './export.js';

const DEMO_URL = 'assets/demo/sample-city.json';

const dom = {
  panel: document.getElementById('panel'),
  stage: document.getElementById('stage'),
  preview: document.getElementById('preview'),
  status: document.getElementById('status'),
  busy: document.getElementById('busy'),
};

const store = createStore(loadSaved());

/** Cached OSM data plus what it covers, so panning does not refetch needlessly. */
let dataset = { features: [], bounds: null, families: new Set(), source: null };
let placingPin = false;
let fetchController = null;
let fetchTimer = null;
let renderQueued = false;
let panel;

// ------------------------------------------------------------------- history
// Undo works in gestures, not in individual events: dragging a slider for two
// seconds should be one step, not forty. The state from before a burst of
// changes is held back until the burst goes quiet, then committed.
const HISTORY_LIMIT = 80;
const BURST_MS = 450;
const undoStack = [];
const redoStack = [];
let pendingBefore = null;
let burstTimer = null;

function commitBurst() {
  clearTimeout(burstTimer);
  if (!pendingBefore) return;
  undoStack.push(pendingBefore);
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack.length = 0;
  pendingBefore = null;
  refreshHistoryButtons();
}

function recordChange(before) {
  if (!pendingBefore) pendingBefore = before;
  clearTimeout(burstTimer);
  burstTimer = setTimeout(commitBurst, BURST_MS);
  refreshHistoryButtons();
}

function refreshHistoryButtons() {
  panel?.setHistoryState(undoStack.length > 0 || Boolean(pendingBefore), redoStack.length > 0);
}

function applyHistory(next, message) {
  store.replace(hydrate(next), { refetch: true, track: false });
  panel.renderCaptionLines();
  panel.sync();
  refreshHistoryButtons();
  setStatus(message, 'ok');
}

function undo() {
  commitBurst();
  const previous = undoStack.pop();
  if (!previous) {
    setStatus('Nothing left to undo.', 'info');
    return;
  }
  redoStack.push(snapshot(store.get()));
  applyHistory(previous, 'Undone.');
}

function redo() {
  commitBurst();
  const next = redoStack.pop();
  if (!next) {
    setStatus('Nothing to redo.', 'info');
    return;
  }
  undoStack.push(snapshot(store.get()));
  applyHistory(next, 'Redone.');
}

// -------------------------------------------------------------------- status
let statusTimer = null;
function setStatus(message, kind = 'info', sticky = false) {
  dom.status.textContent = message || '';
  dom.status.className = `status status-${kind}` + (message ? ' is-visible' : '');
  clearTimeout(statusTimer);
  if (message && !sticky && kind !== 'error') {
    statusTimer = setTimeout(() => {
      dom.status.classList.remove('is-visible');
    }, 4000);
  }
}
function setBusy(busy, message) {
  dom.busy.classList.toggle('is-visible', Boolean(busy));
  if (message) dom.busy.textContent = message;
}

// ---------------------------------------------------------------- data needs
function requiredFamilies(state) {
  const families = new Set();
  for (const [layerId, family] of Object.entries(LAYER_DATA_NEEDS)) {
    if (state.layers[layerId]?.enabled) families.add(family);
  }
  return families;
}

function neededBounds(state) {
  const layout = computeLayout(state);
  const projection = createProjection({
    lat: state.location.lat,
    lon: state.location.lon,
    spanMetres: state.view.spanMetres,
    rect: layout.projectionRect,
  });
  return projection.bounds;
}

function datasetCovers(state) {
  if (!dataset.bounds) return false;
  if (dataset.source === 'demo') return true;
  const families = requiredFamilies(state);
  for (const family of families) if (!dataset.families.has(family)) return false;
  return boundsContain(dataset.bounds, neededBounds(state));
}

function scheduleFetch(delay = 450) {
  clearTimeout(fetchTimer);
  fetchTimer = setTimeout(() => {
    if (!datasetCovers(store.get())) fetchData();
  }, delay);
}

async function fetchData() {
  const state = store.get();
  const families = requiredFamilies(state);
  if (!families.size) {
    dataset = { features: [], bounds: neededBounds(state), families, source: 'overpass' };
    requestRender();
    return;
  }

  fetchController?.abort();
  fetchController = new AbortController();
  // Fetch a margin around the visible window so small pans stay local.
  const bounds = padBounds(neededBounds(state), 0.3);
  setBusy(true, 'Downloading map data…');

  try {
    const { json } = await fetchOverpass(bounds, [...families], {
      signal: fetchController.signal,
      onProgress: (message) => setBusy(true, message),
    });
    const { features } = parseOverpass(json);
    dataset = { features, bounds, families, source: 'overpass' };
    setBusy(false);
    if (!features.length) {
      setStatus('No map data here — try a larger area or a different place.', 'warn');
    } else {
      setStatus(`Loaded ${features.length.toLocaleString()} map features.`, 'ok');
    }
    requestRender();
  } catch (err) {
    if (err.name === 'AbortError') return;
    setBusy(false);
    console.error(err);
    setStatus(
      `Could not download map data: ${err.message}. Check your connection, or press “Use demo city” to try the app offline.`,
      'error',
      true
    );
  }
}

async function loadDemo() {
  setBusy(true, 'Loading the demo city…');
  try {
    const res = await fetch(DEMO_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const { features } = parseOverpass(json);
    const centre = json.meta?.centre || { lat: 39.1031, lon: -84.512 };
    dataset = {
      features,
      bounds: { south: -90, north: 90, west: -180, east: 180 },
      families: new Set(['roads', 'water', 'waterways', 'buildings', 'green', 'rail']),
      source: 'demo',
    };
    store.set((s) => {
      s.location = { query: 'Sample City', lat: centre.lat, lon: centre.lon, label: 'Sample City', region: 'Ohio' };
      s.view.spanMetres = 6000;
      fillCaption(s);
    });
    panel.renderCaptionLines();
    setBusy(false);
    setStatus('Demo city loaded — synthetic data, no network needed.', 'ok');
  } catch (err) {
    setBusy(false);
    setStatus(`Could not load the demo city: ${err.message}`, 'error', true);
  }
}

// ------------------------------------------------------------------- caption
function fillCaption(state) {
  const place = [state.location.label, state.location.region].filter(Boolean).join(', ');
  const coords = `${formatCoordinate(state.location.lat, 'lat')}, ${formatCoordinate(state.location.lon, 'lon')}`;
  if (state.caption.lines[0]) state.caption.lines[0].text = place;
  if (state.caption.lines[1]) state.caption.lines[1].text = coords;
  state.caption.autoFill = true;
}

// -------------------------------------------------------------------- render
let currentLayout = null;
let currentProjection = null;

function buildFrame(state, mode) {
  const layout = computeLayout(state);
  const projection = createProjection({
    lat: state.location.lat,
    lon: state.location.lon,
    spanMetres: state.view.spanMetres,
    rect: layout.projectionRect,
  });
  const prepared = prepareFeatures(dataset.features, { projection, clip: layout.clip, state });
  const pin = computePin(state, layout, projection);
  const labels = state.labels.enabled
    ? placeLabels(prepared.labelCandidates, {
        clip: layout.clip,
        settings: state.labels,
        reserved: pin ? [pin.box] : [],
      })
    : [];
  applyKnockouts(prepared.byLayer, buildKnockouts({ state, pin, labels, worldBounds: layout.clip.bounds }));
  const { markup, stats } = renderSvg({ state, layout, projection, prepared, labels, pin, mode });
  return { markup, stats, layout, projection, labelCount: labels.length };
}

function render() {
  const state = store.get();
  const started = performance.now();
  try {
    const frame = buildFrame(state, 'preview');
    currentLayout = frame.layout;
    currentProjection = frame.projection;
    dom.preview.innerHTML = frame.markup;
    const svg = dom.preview.querySelector('svg');
    if (svg) {
      svg.removeAttribute('width');
      svg.removeAttribute('height');
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    }
    panel.sync();
    const ms = Math.round(performance.now() - started);
    panel.setStats(
      `${state.coaster.width} × ${state.coaster.shape === 'circle' ? state.coaster.width : state.coaster.height} mm · ` +
        `${frame.stats.layers} engraved layers · ${frame.labelCount} labels · drawn in ${ms} ms` +
        (dataset.source === 'demo' ? ' · demo data' : '')
    );
  } catch (err) {
    console.error(err);
    setStatus(`Something went wrong while drawing: ${err.message}`, 'error', true);
  }
}

function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

// --------------------------------------------------------------- interaction
function clientToMm(event) {
  const svg = dom.preview.querySelector('svg');
  if (!svg || !currentLayout) return null;
  const rect = svg.getBoundingClientRect();
  const scale = currentLayout.width / rect.width;
  return {
    x: (event.clientX - rect.left) * scale,
    y: (event.clientY - rect.top) * (currentLayout.height / rect.height),
    scale,
  };
}

/** True when a millimetre point falls inside the caption's grab area. */
function overCaption(point) {
  const caption = currentLayout?.caption;
  if (!caption?.hasText || !store.get().caption.enabled) return false;
  const pad = 1.5;
  const { box } = caption;
  return (
    point.x >= box.minX - pad &&
    point.x <= box.maxX + pad &&
    point.y >= box.minY - pad &&
    point.y <= box.maxY + pad
  );
}

function setupPreviewInteraction() {
  let drag = null;

  dom.preview.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const point = clientToMm(event);
    if (!point) return;
    if (placingPin) {
      const [lon, lat] = currentProjection.unproject(point.x, point.y);
      store.set((s) => {
        s.pin.lat = lat;
        s.pin.lon = lon;
        s.pin.followCentre = false;
        s.pin.enabled = true;
      });
      setPlacingPin(false);
      setStatus(`Pin placed at ${lat.toFixed(5)}, ${lon.toFixed(5)}.`, 'ok');
      return;
    }
    // Grabbing the caption moves the caption; grabbing anywhere else pans.
    const mode = overCaption(point) ? 'caption' : 'map';
    drag = { x: event.clientX, y: event.clientY, scale: point.scale, moved: false, mode };
    dom.preview.setPointerCapture(event.pointerId);
    dom.preview.classList.add(mode === 'caption' ? 'is-moving-caption' : 'is-dragging');
  });

  dom.preview.addEventListener('pointermove', (event) => {
    if (!drag) {
      // Hover feedback, so it is discoverable that the caption can be dragged.
      const point = clientToMm(event);
      dom.preview.classList.toggle('is-over-caption', !placingPin && Boolean(point) && overCaption(point));
      return;
    }
    if (!currentProjection) return;
    const dxMm = (event.clientX - drag.x) * drag.scale;
    const dyMm = (event.clientY - drag.y) * drag.scale;
    if (Math.abs(dxMm) < 0.05 && Math.abs(dyMm) < 0.05) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
    drag.moved = true;

    if (drag.mode === 'caption') {
      store.set((s) => {
        s.caption.offsetX += dxMm;
        s.caption.offsetY += dyMm;
      });
      return;
    }

    const centre = currentLayout.projectionRect;
    const cx = centre.x + centre.w / 2;
    const cy = centre.y + centre.h / 2;
    const [lon, lat] = currentProjection.unproject(cx - dxMm, cy - dyMm);
    store.set((s) => {
      s.location.lat = lat;
      s.location.lon = lon;
      if (s.caption.autoFill) fillCaption(s);
    }, { refetch: true });
  });

  const endDrag = (event) => {
    if (!drag) return;
    dom.preview.releasePointerCapture?.(event.pointerId);
    dom.preview.classList.remove('is-dragging', 'is-moving-caption');
    if (drag.moved) {
      if (drag.mode === 'caption') panel.sync();
      else panel.renderCaptionLines();
    }
    drag = null;
  };
  dom.preview.addEventListener('pointerup', endDrag);
  dom.preview.addEventListener('pointercancel', endDrag);

  dom.preview.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const factor = Math.exp(event.deltaY * 0.0012);
      store.set((s) => {
        s.view.spanMetres = Math.round(Math.min(60000, Math.max(200, s.view.spanMetres * factor)));
      }, { refetch: true });
    },
    { passive: false }
  );

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && placingPin) {
      setPlacingPin(false);
      return;
    }
    // Leave Ctrl+Z alone while a field has focus so it still undoes typing.
    const editing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (editing || !(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key === 'z' && !event.shiftKey) {
      event.preventDefault();
      undo();
    } else if ((key === 'z' && event.shiftKey) || key === 'y') {
      event.preventDefault();
      redo();
    }
  });
}

function setPlacingPin(active) {
  placingPin = active;
  dom.preview.classList.toggle('is-placing', active);
  panel.setPlacingPin(active);
  if (active) setStatus('Click anywhere on the map to drop the pin.', 'info', true);
}

// ------------------------------------------------------------------- actions
let searchController = null;

const actions = {
  async search(query) {
    const trimmed = (query || '').trim();
    if (!trimmed) return;
    searchController?.abort();
    searchController = new AbortController();
    panel.renderResults(null, { loading: true });
    try {
      const results = await geocode(trimmed, { signal: searchController.signal });
      if (!results.length) {
        panel.renderResults(null, { error: 'Nothing found. Try adding a state or country.' });
        return;
      }
      panel.renderResults(results);
    } catch (err) {
      if (err.name === 'AbortError') return;
      panel.renderResults(null, {
        error: `Search failed: ${err.message}. You can still type coordinates directly.`,
      });
    }
  },

  pickResult(result) {
    store.set((s) => {
      s.location.lat = result.lat;
      s.location.lon = result.lon;
      s.location.label = result.primary || result.display;
      s.location.region = result.secondary || '';
      s.location.query = result.display;
      // Choosing a search result is an explicit "I want this place", so the
      // caption is always rewritten — that is the whole point of searching.
      fillCaption(s);
      if (s.pin.followCentre) {
        s.pin.lat = result.lat;
        s.pin.lon = result.lon;
      }
    }, { refetch: true });
    panel.renderCaptionLines();
    panel.sync();
    setStatus(
      `Centred on ${result.primary || result.display}, and the caption now reads it back.`,
      'ok'
    );
  },

  loadDemo,

  fillCaptionFromLocation() {
    store.set((s) => fillCaption(s));
  },

  togglePlacePin() {
    setPlacingPin(!placingPin);
  },

  undo,
  redo,

  exportSvg() {
    const state = store.get();
    try {
      const frame = buildFrame(state, 'export');
      downloadSvg(frame.markup, suggestedName(state, 'svg'));
      setStatus(
        `Exported ${suggestedName(state, 'svg')} — ${state.coaster.width} × ` +
          `${state.coaster.shape === 'circle' ? state.coaster.width : state.coaster.height} mm at 1:1 scale.`,
        'ok'
      );
    } catch (err) {
      console.error(err);
      setStatus(`Export failed: ${err.message}`, 'error', true);
    }
  },

  saveDesign() {
    downloadDesign(store.get(), suggestedName(store.get(), 'json'));
    setStatus('Design saved. Reopen it any time with “Open design”.', 'ok');
  },

  async loadDesign(file) {
    try {
      const parsed = await readDesignFile(file);
      store.replace(hydrate(parsed), { refetch: true });
      panel.renderCaptionLines();
      panel.sync();
      setStatus('Design loaded.', 'ok');
    } catch (err) {
      setStatus(err.message, 'error', true);
    }
  },

  reset() {
    if (!confirm('Reset every setting to the defaults? You can still undo this afterwards.')) return;
    commitBurst();
    undoStack.push(snapshot(store.get()));
    redoStack.length = 0;
    store.replace(createDefaultState(), { refetch: true, track: false });
    panel.renderCaptionLines();
    panel.sync();
    refreshHistoryButtons();
    setStatus('Back to the default design. Undo will bring your settings back.', 'ok');
  },
};

// ---------------------------------------------------------------------- boot
function fontVariantsInUse(state) {
  const variants = [
    { id: state.labels.font, weight: state.labels.weight, italic: state.labels.italic },
    { id: state.pin.font, weight: state.pin.weight, italic: state.pin.italic },
  ];
  for (const line of state.caption.lines) {
    variants.push({ id: line.font, weight: line.weight, italic: line.italic });
  }
  return variants;
}

async function boot() {
  const style = document.createElement('style');
  style.textContent = fontFaceCss();
  document.head.append(style);

  await preloadFonts(fontVariantsInUse(store.get()));

  panel = buildPanel({ store, actions });
  dom.panel.append(panel.node);
  setupPreviewInteraction();

  store.subscribe((state, meta) => {
    persist(state);
    if (meta.before) recordChange(meta.before);
    // `silent` updates only touch bookkeeping (the search box text), so they
    // do not need the whole coaster redrawn on every keystroke.
    if (!meta.silent) requestRender();
    if (meta.refetch) scheduleFetch();
  });
  refreshHistoryButtons();

  render();
  scheduleFetch(0);

  // The rest of the family arrives in the background; redraw once it lands so
  // switching fonts in the dropdown is instant.
  preloadAll().then(() => requestRender());
}

boot().catch((err) => {
  console.error(err);
  setStatus(`The app failed to start: ${err.message}`, 'error', true);
});
