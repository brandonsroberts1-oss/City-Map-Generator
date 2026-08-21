// The single source of truth for a design. Everything the renderer needs lives
// here, so a design can be saved, shared as JSON, or restored from localStorage
// as one object.

import { defaultLayerState } from './layers.js';

export const STORAGE_KEY = 'city-map-coaster:design:v1';

export const COASTER_PRESETS = [
  { id: 'slate-100', label: 'Slate square 100 × 100 mm', width: 100, height: 100, shape: 'rounded' },
  { id: 'slate-95', label: 'Slate square 95 × 95 mm', width: 95, height: 95, shape: 'rounded' },
  { id: 'slate-4in', label: 'Square 4 × 4 in (101.6 mm)', width: 101.6, height: 101.6, shape: 'rounded' },
  { id: 'round-100', label: 'Round Ø 100 mm', width: 100, height: 100, shape: 'circle' },
  { id: 'round-4in', label: 'Round Ø 4 in (101.6 mm)', width: 101.6, height: 101.6, shape: 'circle' },
  { id: 'tile-150', label: 'Tile 150 × 150 mm', width: 150, height: 150, shape: 'rounded' },
  { id: 'plaque-a5', label: 'Plaque 148 × 210 mm (A5)', width: 148, height: 210, shape: 'rounded' },
];

export function captionLine(overrides = {}) {
  return {
    id: Math.random().toString(36).slice(2, 9),
    text: '',
    font: 'playfair-display',
    weight: 400,
    italic: false,
    size: 6,
    tracking: 0,
    lineHeight: 1.32,
    textCase: 'none',
    align: 'center',
    offsetX: 0,
    ...overrides,
  };
}

export function createDefaultState() {
  return {
    version: 1,
    location: {
      query: 'Cincinnati, Ohio',
      lat: 39.1031,
      lon: -84.512,
      label: 'Cincinnati',
      region: 'Ohio',
    },
    view: {
      spanMetres: 6000,
    },
    coaster: {
      preset: 'slate-100',
      width: 100,
      height: 100,
      shape: 'rounded',
      cornerRadius: 4,
      margin: 5,
      cutLine: false,
    },
    border: {
      enabled: true,
      scope: 'map',
      thickness: 0.9,
      radius: 4,
      padding: 1.2,
    },
    mapArea: {
      aspect: 'fill',
      cornerRadius: 4,
    },
    layers: defaultLayerState(),
    detail: {
      simplifyMm: 0.04,
      minBuildingMm2: 0.12,
      strokeScale: 1,
      lineCap: 'round',
    },
    labels: {
      enabled: false,
      streets: true,
      water: true,
      parks: true,
      font: 'montserrat',
      weight: 400,
      italic: false,
      size: 1.6,
      tracking: 0.06,
      textCase: 'none',
      maxLabels: 22,
      minFeatureMm: 12,
      clearSpace: true,
      haloMm: 0.3,
    },
    pin: {
      enabled: true,
      lat: 39.1031,
      lon: -84.512,
      followCentre: true,
      style: 'oval',
      radius: 6,
      strokeWidth: 0.6,
      text: 'Home',
      font: 'playfair-display',
      weight: 400,
      italic: false,
      textSize: 3.4,
      tracking: 0,
      textCase: 'none',
      textOffsetY: 0,
      knockout: true,
      clearSpace: true,
      clearance: 0.8,
      stemLength: 5,
    },
    caption: {
      enabled: true,
      autoFill: true,
      scale: 1,
      gap: 3,
      offsetX: 0,
      offsetY: 0,
      lines: [
        captionLine({ text: 'Cincinnati, Ohio', size: 7, weight: 400, tracking: 0.1 }),
        captionLine({ text: '39.1031° N, 84.5120° W', size: 5.2, tracking: 0.16 }),
      ],
    },
    style: {
      previewTheme: 'slate',
      geometry: 'outlines',
      exportColors: 'mono',
      exportInk: '#000000',
    },
  };
}

/** Deep merge that keeps unknown saved keys from clobbering new defaults. */
function merge(base, patch) {
  if (Array.isArray(base) || Array.isArray(patch)) return patch ?? base;
  if (typeof base !== 'object' || base === null) return patch ?? base;
  if (typeof patch !== 'object' || patch === null) return base;
  const out = { ...base };
  for (const key of Object.keys(patch)) out[key] = merge(base[key], patch[key]);
  return out;
}

export function hydrate(saved) {
  const base = createDefaultState();
  if (!saved || typeof saved !== 'object') return base;
  const merged = merge(base, saved);
  // Caption lines are replaced wholesale, but must still carry every field.
  if (Array.isArray(saved.caption?.lines)) {
    merged.caption.lines = saved.caption.lines.map((l) => ({ ...captionLine(), ...l }));
  }
  return merged;
}

export function loadSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? hydrate(JSON.parse(raw)) : createDefaultState();
  } catch {
    return createDefaultState();
  }
}

export function persist(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* private browsing, quota, etc. — not worth interrupting the user for */
  }
}

export function snapshot(state) {
  return JSON.parse(JSON.stringify(state));
}

/**
 * Minimal observable store: `set` mutates via a callback then notifies.
 *
 * Every tracked change hands listeners a copy of the state as it was *before*
 * the mutation, which is what the undo history is built from. Pass
 * `{ track: false }` for changes that should not create an undo step — undo and
 * redo themselves, most obviously.
 */
export function createStore(initial) {
  let state = initial;
  const listeners = new Set();
  const notify = (meta) => {
    for (const fn of listeners) fn(state, meta);
  };
  return {
    get: () => state,
    set(mutator, meta = {}) {
      const before = meta.track === false || meta.silent ? null : snapshot(state);
      mutator(state);
      notify({ ...meta, before });
    },
    replace(next, meta = {}) {
      const before = meta.track === false ? null : snapshot(state);
      state = next;
      notify({ ...meta, before });
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
