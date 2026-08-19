// The map's vocabulary: which OSM tags become which engravable layer, what it
// is called in the UI, how thick it draws by default, and whether the exporter
// treats it as a stroked line or a filled shape.
//
// `order` is paint order, low to high, so buildings sit under roads and the pin
// sits on top of everything.

export const LINE = 'line';
export const AREA = 'area';

export const LAYERS = [
  {
    id: 'landuseGreen',
    group: 'Landscape',
    label: 'Parks & green space',
    kind: AREA,
    order: 10,
    defaults: { enabled: false, mode: 'outline', weight: 0.16, opacity: 1 },
    minAreaMm2: 1.5,
  },
  {
    id: 'water',
    group: 'Water',
    label: 'Lakes, rivers & bays',
    kind: AREA,
    order: 20,
    defaults: { enabled: true, mode: 'fill', weight: 0.2, opacity: 1 },
    minAreaMm2: 0.3,
  },
  {
    id: 'buildings',
    group: 'Structures',
    label: 'Buildings & houses',
    kind: AREA,
    order: 30,
    defaults: { enabled: true, mode: 'fill', weight: 0.12, opacity: 1 },
    minAreaMm2: 0.12,
  },
  {
    id: 'riverLine',
    group: 'Water',
    label: 'Rivers',
    kind: LINE,
    order: 40,
    defaults: { enabled: true, weight: 0.55 },
  },
  {
    id: 'streamLine',
    group: 'Water',
    label: 'Streams & canals',
    kind: LINE,
    order: 41,
    defaults: { enabled: true, weight: 0.22 },
  },
  {
    id: 'rail',
    group: 'Transport',
    label: 'Railways',
    kind: LINE,
    order: 50,
    defaults: { enabled: false, weight: 0.2 },
  },
  {
    id: 'path',
    group: 'Roads',
    label: 'Paths & footways',
    kind: LINE,
    order: 60,
    defaults: { enabled: false, weight: 0.12 },
  },
  {
    id: 'service',
    group: 'Roads',
    label: 'Service roads & alleys',
    kind: LINE,
    order: 61,
    defaults: { enabled: false, weight: 0.14 },
  },
  {
    id: 'residential',
    group: 'Roads',
    label: 'Residential streets',
    kind: LINE,
    order: 62,
    defaults: { enabled: true, weight: 0.2 },
  },
  {
    id: 'tertiary',
    group: 'Roads',
    label: 'Minor roads',
    kind: LINE,
    order: 63,
    defaults: { enabled: true, weight: 0.28 },
  },
  {
    id: 'secondary',
    group: 'Roads',
    label: 'Secondary roads',
    kind: LINE,
    order: 64,
    defaults: { enabled: true, weight: 0.36 },
  },
  {
    id: 'primary',
    group: 'Roads',
    label: 'Primary roads',
    kind: LINE,
    order: 65,
    defaults: { enabled: true, weight: 0.46 },
  },
  {
    id: 'motorway',
    group: 'Roads',
    label: 'Motorways & highways',
    kind: LINE,
    order: 66,
    defaults: { enabled: true, weight: 0.6 },
  },
];

export const LAYERS_BY_ID = new Map(LAYERS.map((l) => [l.id, l]));

export const LAYER_GROUPS = ['Roads', 'Water', 'Structures', 'Landscape', 'Transport'];

/**
 * Which Overpass feature families each layer needs. Queries are assembled from
 * the union of these so turning off buildings really does stop downloading them
 * — on a dense city that is most of the payload.
 */
export const LAYER_DATA_NEEDS = {
  motorway: 'roads',
  primary: 'roads',
  secondary: 'roads',
  tertiary: 'roads',
  residential: 'roads',
  service: 'roads',
  path: 'roads',
  rail: 'rail',
  water: 'water',
  riverLine: 'waterways',
  streamLine: 'waterways',
  buildings: 'buildings',
  landuseGreen: 'green',
};

const HIGHWAY_CLASS = {
  motorway: 'motorway',
  motorway_link: 'motorway',
  trunk: 'motorway',
  trunk_link: 'motorway',
  primary: 'primary',
  primary_link: 'primary',
  secondary: 'secondary',
  secondary_link: 'secondary',
  tertiary: 'tertiary',
  tertiary_link: 'tertiary',
  unclassified: 'tertiary',
  residential: 'residential',
  living_street: 'residential',
  road: 'residential',
  service: 'service',
  track: 'service',
  footway: 'path',
  path: 'path',
  cycleway: 'path',
  pedestrian: 'path',
  steps: 'path',
  bridleway: 'path',
  corridor: 'path',
};

const RAIL_VALUES = new Set([
  'rail',
  'light_rail',
  'subway',
  'tram',
  'narrow_gauge',
  'monorail',
  'funicular',
]);

const WATER_AREA_NATURAL = new Set(['water', 'bay', 'strait', 'wetland']);
const WATER_AREA_LANDUSE = new Set(['reservoir', 'basin']);
const GREEN_LEISURE = new Set([
  'park',
  'garden',
  'golf_course',
  'nature_reserve',
  'pitch',
  'playground',
  'common',
  'dog_park',
]);
const GREEN_LANDUSE = new Set([
  'grass',
  'forest',
  'meadow',
  'village_green',
  'recreation_ground',
  'cemetery',
  'allotments',
  'orchard',
  'vineyard',
  'greenfield',
]);
const GREEN_NATURAL = new Set(['wood', 'scrub', 'heath', 'grassland', 'sand', 'beach']);

const RIVER_WATERWAY = new Set(['river']);
const STREAM_WATERWAY = new Set(['stream', 'canal', 'ditch', 'drain', 'brook', 'tidal_channel']);

/**
 * Maps an OSM tag bag onto a layer id, returning null for anything we do not
 * engrave. `isClosed` disambiguates riverbank polygons from river centrelines.
 */
export function classify(tags, isClosed) {
  if (!tags) return null;

  if (tags.building && tags.building !== 'no') return 'buildings';
  if (tags['building:part']) return 'buildings';

  if (tags.natural && WATER_AREA_NATURAL.has(tags.natural)) return 'water';
  if (tags.landuse && WATER_AREA_LANDUSE.has(tags.landuse)) return 'water';
  if (tags.waterway === 'riverbank' || tags.waterway === 'dock') return 'water';
  if (tags.water) return 'water';

  if (tags.waterway) {
    if (RIVER_WATERWAY.has(tags.waterway)) return isClosed ? 'water' : 'riverLine';
    if (STREAM_WATERWAY.has(tags.waterway)) return 'streamLine';
    return null;
  }

  if (tags.highway) {
    const cls = HIGHWAY_CLASS[tags.highway];
    return cls || null;
  }

  if (tags.railway && RAIL_VALUES.has(tags.railway)) return 'rail';

  if (tags.leisure && GREEN_LEISURE.has(tags.leisure)) return 'landuseGreen';
  if (tags.landuse && GREEN_LANDUSE.has(tags.landuse)) return 'landuseGreen';
  if (tags.natural && GREEN_NATURAL.has(tags.natural)) return 'landuseGreen';

  return null;
}

/** Label category for a classified feature, or null when it should stay unlabelled. */
export function labelCategory(layerId) {
  if (['motorway', 'primary', 'secondary', 'tertiary', 'residential'].includes(layerId)) {
    return 'streets';
  }
  if (layerId === 'water' || layerId === 'riverLine' || layerId === 'streamLine') return 'water';
  if (layerId === 'landuseGreen') return 'parks';
  return null;
}

export function defaultLayerState() {
  const out = {};
  for (const layer of LAYERS) out[layer.id] = { ...layer.defaults };
  return out;
}
