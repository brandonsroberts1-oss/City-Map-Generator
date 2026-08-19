// Generates a synthetic "Sample City" in Overpass JSON so the app has something
// to draw when it is offline, and so the render pipeline can be tested without
// hitting the real API.
//
//   node tools/make-fixture.mjs > assets/demo/sample-city.json

import { writeFileSync } from 'fs';

const CENTER = { lat: 39.1031, lon: -84.512 };
const SPAN_M = 9000;
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LON = 111320 * Math.cos((CENTER.lat * Math.PI) / 180);

let nodeId = 1;
let wayId = 1;
let relId = 1;
const elements = [];

// Deterministic PRNG so regenerating the fixture does not churn the diff.
let seed = 20240517;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const jitter = (amount) => (rnd() - 0.5) * 2 * amount;

const toLonLat = (x, y) => ({
  lon: CENTER.lon + x / M_PER_DEG_LON,
  lat: CENTER.lat + y / M_PER_DEG_LAT,
});

function addWay(points, tags) {
  const nodes = points.map(([x, y]) => {
    const id = nodeId++;
    const { lon, lat } = toLonLat(x, y);
    elements.push({ type: 'node', id, lon: +lon.toFixed(7), lat: +lat.toFixed(7) });
    return id;
  });
  const id = wayId++;
  elements.push({ type: 'way', id, nodes, tags });
  return id;
}

function closedWay(points, tags) {
  return addWay([...points, points[0]], tags);
}

/** A gently wandering line, used for rivers and the odd curving avenue. */
function meander(x0, y0, x1, y1, steps, amplitude, phase = 0) {
  const pts = [];
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  const nx = -dy / len;
  const ny = dx / len;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const wave = Math.sin(t * Math.PI * 2.2 + phase) * amplitude + Math.sin(t * Math.PI * 5.7 + phase) * amplitude * 0.3;
    pts.push([x0 + dx * t + nx * wave, y0 + dy * t + ny * wave]);
  }
  return pts;
}

const HALF = SPAN_M / 2;

// ---------------------------------------------------------------- river
const riverCentre = meander(-HALF * 1.1, -900, HALF * 1.1, 700, 60, 900);
addWay(riverCentre, { waterway: 'river', name: 'Sample River' });

const riverBank = [
  ...riverCentre.map(([x, y]) => [x, y + 150]),
  ...riverCentre.map(([x, y]) => [x, y - 150]).reverse(),
];
closedWay(riverBank, { natural: 'water', name: 'Sample River' });

for (let i = 0; i < 6; i++) {
  const startX = -HALF + i * (SPAN_M / 6) + jitter(300);
  const anchor = riverCentre[Math.round(((startX + HALF) / SPAN_M) * 60)] || riverCentre[30];
  const dir = i % 2 === 0 ? 1 : -1;
  addWay(meander(startX, anchor[1] + dir * 2600, anchor[0], anchor[1] + dir * 200, 18, 220, i), {
    waterway: 'stream',
    name: `${['Mill', 'Fox', 'Cedar', 'Trout', 'Beaver', 'Willow'][i]} Creek`,
  });
}

// ---------------------------------------------------------------- lakes
function lake(cx, cy, rx, ry, name, wobble = 0.18) {
  const pts = [];
  for (let i = 0; i < 46; i++) {
    const a = (i / 46) * Math.PI * 2;
    const r = 1 + Math.sin(a * 3 + cx) * wobble + Math.sin(a * 5 + cy) * wobble * 0.5;
    pts.push([cx + Math.cos(a) * rx * r, cy + Math.sin(a) * ry * r]);
  }
  closedWay(pts, { natural: 'water', name });
}
lake(-2600, 2400, 620, 430, 'Mirror Lake');
lake(3100, -2500, 480, 560, 'Quarry Pond');

// ---------------------------------------------------------------- parks
function park(cx, cy, w, h, name, tags = { leisure: 'park' }) {
  const pts = [];
  const steps = 30;
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const r = 1 + Math.sin(a * 4 + cx * 0.001) * 0.12;
    pts.push([cx + (Math.cos(a) * w * r) / 2, cy + (Math.sin(a) * h * r) / 2]);
  }
  closedWay(pts, { ...tags, name });
}
park(-1500, -2100, 1500, 1100, 'Riverside Park');
park(2400, 2200, 1800, 1300, 'Highland Commons');
park(-3400, -300, 900, 2400, 'Greenway Reserve', { landuse: 'forest' });
park(600, 3100, 1100, 800, 'Memorial Green');

// ---------------------------------------------------------------- streets
const STREET_NAMES = [
  'Vine', 'Walnut', 'Elm', 'Race', 'Plum', 'Central', 'Court', 'Liberty',
  'Sycamore', 'Broadway', 'Pike', 'Reading', 'Spring', 'Clay', 'Pleasant',
];
const AVENUE_NAMES = [
  'First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth',
  'Ninth', 'Tenth', 'Eleventh', 'Twelfth', 'Liberty', 'Findlay', 'Mercer',
];

const GRID_STEP = 260;
const DOWNTOWN = { x0: -2400, x1: 2600, y0: 300, y1: 3400 };

const northSouth = [];
for (let x = DOWNTOWN.x0, i = 0; x <= DOWNTOWN.x1; x += GRID_STEP, i++) {
  const cls = i % 6 === 0 ? 'secondary' : i % 3 === 0 ? 'tertiary' : 'residential';
  const pts = [];
  for (let y = DOWNTOWN.y0; y <= DOWNTOWN.y1; y += 120) pts.push([x + jitter(6), y]);
  addWay(pts, { highway: cls, name: `${STREET_NAMES[i % STREET_NAMES.length]} Street` });
  northSouth.push(x);
}
const eastWest = [];
for (let y = DOWNTOWN.y0, i = 0; y <= DOWNTOWN.y1; y += GRID_STEP, i++) {
  const cls = i % 5 === 0 ? 'secondary' : i % 3 === 0 ? 'tertiary' : 'residential';
  const pts = [];
  for (let x = DOWNTOWN.x0; x <= DOWNTOWN.x1; x += 120) pts.push([x, y + jitter(6)]);
  addWay(pts, { highway: cls, name: `${AVENUE_NAMES[i % AVENUE_NAMES.length]} Avenue` });
  eastWest.push(y);
}

// Suburban curves south of the river, plus the odd cul-de-sac.
for (let i = 0; i < 46; i++) {
  const y0 = -1400 - i * 90;
  const x0 = -HALF * 0.95 + (i % 5) * 400;
  addWay(meander(x0, y0, x0 + 2400 + (i % 7) * 300, y0 - 260 + jitter(200), 14, 130, i * 0.7), {
    highway: i % 8 === 0 ? 'tertiary' : 'residential',
    name: `${['Maple', 'Oak', 'Chestnut', 'Laurel', 'Aspen', 'Birch', 'Cypress'][i % 7]} ${
      ['Drive', 'Lane', 'Court', 'Way', 'Ridge'][i % 5]
    }`,
  });
}
for (let i = 0; i < 30; i++) {
  const x0 = -HALF * 0.9 + i * 280;
  addWay(meander(x0, -1500, x0 + jitter(500), -4200, 12, 160, i), {
    highway: i % 6 === 0 ? 'tertiary' : 'residential',
    name: `${['Hillcrest', 'Meadow', 'Sunset', 'Fern', 'Poplar'][i % 5]} ${['Road', 'Trail', 'Terrace'][i % 3]}`,
  });
}

// Arterials, motorway and ring road.
addWay(meander(-HALF * 1.1, 2800, HALF * 1.1, 1400, 30, 260), { highway: 'primary', name: 'Central Parkway' });
addWay(meander(-HALF * 1.1, -3000, HALF * 1.1, -3600, 26, 300), { highway: 'primary', name: 'Columbia Parkway' });
addWay(meander(-200, HALF * 1.1, 900, -HALF * 1.1, 40, 420), { highway: 'primary', name: 'Reading Road' });
addWay(meander(-HALF * 1.15, -2000, HALF * 1.15, -1500, 34, 520), { highway: 'motorway', name: 'Interstate 71' });
addWay(meander(-3800, HALF * 1.15, -3200, -HALF * 1.15, 34, 460), { highway: 'motorway', name: 'Interstate 75' });
addWay(meander(2600, -HALF * 1.1, 4200, HALF * 1.1, 30, 380), { highway: 'secondary', name: 'Madison Road' });

// Rail lines and a few paths through the parks.
addWay(meander(-HALF * 1.1, -700, HALF * 1.1, -1200, 30, 180), { railway: 'rail', name: 'Union Subdivision' });
addWay(meander(-1400, -2100, 2400, 2200, 24, 700), { highway: 'footway', name: 'Riverwalk Trail' });

// ---------------------------------------------------------------- buildings
function buildingRect(cx, cy, w, h, rot) {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const corners = [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ];
  return corners.map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]);
}

for (let i = 0; i < northSouth.length - 1; i++) {
  for (let j = 0; j < eastWest.length - 1; j++) {
    const bx = northSouth[i];
    const by = eastWest[j];
    const dense = Math.hypot(bx, by - 1800) < 1500;
    const count = dense ? 8 : 4;
    for (let k = 0; k < count; k++) {
      const w = dense ? 55 + rnd() * 70 : 26 + rnd() * 26;
      const h = dense ? 45 + rnd() * 70 : 22 + rnd() * 22;
      const px = bx + 45 + rnd() * (GRID_STEP - 110);
      const py = by + 45 + rnd() * (GRID_STEP - 110);
      closedWay(buildingRect(px, py, w, h, jitter(0.06)), { building: 'yes' });
    }
  }
}
for (let i = 0; i < 900; i++) {
  const x = -HALF * 0.95 + rnd() * SPAN_M * 0.95;
  const y = -1500 - rnd() * 2700;
  closedWay(buildingRect(x, y, 20 + rnd() * 16, 16 + rnd() * 14, jitter(0.4)), { building: 'house' });
}

// A civic block with a courtyard, so multipolygon handling gets exercised.
const outerA = buildingRect(-1000, 2600, 320, 220, 0);
const outerRing = [...outerA, outerA[0]];
const innerA = buildingRect(-1000, 2600, 150, 90, 0);
const innerRing = [...innerA, innerA[0]];
const outerWayId = addWay(outerRing, {});
const innerWayId = addWay(innerRing, {});
elements.push({
  type: 'relation',
  id: relId++,
  tags: { type: 'multipolygon', building: 'civic', name: 'Sample City Hall' },
  members: [
    { type: 'way', ref: outerWayId, role: 'outer' },
    { type: 'way', ref: innerWayId, role: 'inner' },
  ],
});

const payload = {
  version: 0.6,
  generator: 'city-map-coaster fixture generator',
  meta: { note: 'Synthetic data. Not a real place.', centre: CENTER, spanMetres: SPAN_M },
  elements,
};

const out = process.argv[2] || 'assets/demo/sample-city.json';
writeFileSync(out, JSON.stringify(payload));
console.error(
  `wrote ${out}: ${elements.length} elements (${elements.filter((e) => e.type === 'way').length} ways)`
);
