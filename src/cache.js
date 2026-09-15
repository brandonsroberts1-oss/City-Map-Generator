// A small IndexedDB cache of downloaded map data.
//
// Overpass is the slowest part of the app by a wide margin, so the fastest
// request is the one that never happens: reopening a design, nudging the map
// back where it was, or switching a layer off and on again should all be
// instant. Entries are matched by coverage rather than by exact key, so a
// slightly smaller view of an area already downloaded is a hit.

const DB_NAME = 'city-map-coaster';
const STORE = 'datasets';
const VERSION = 1;
const MAX_ENTRIES = 12;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    let request;
    try {
      request = indexedDB.open(DB_NAME, VERSION);
    } catch {
      return resolve(null);
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    // Private browsing, a blocked origin, a quota refusal — all just mean no
    // cache, never a broken app.
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function transact(db, mode, run) {
  return new Promise((resolve) => {
    let tx;
    try {
      tx = db.transaction(STORE, mode);
    } catch {
      return resolve(null);
    }
    const store = tx.objectStore(STORE);
    let result = null;
    try {
      run(store, (value) => {
        result = value;
      });
    } catch {
      return resolve(null);
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => resolve(null);
    tx.onabort = () => resolve(null);
  });
}

const covers = (outer, inner) =>
  outer.south <= inner.south &&
  outer.north >= inner.north &&
  outer.west <= inner.west &&
  outer.east >= inner.east;

/** Roughly how much bigger the cached area is than the one being asked for. */
function wastage(outer, inner) {
  const outerArea = (outer.north - outer.south) * (outer.east - outer.west);
  const innerArea = (inner.north - inner.south) * (inner.east - inner.west);
  return innerArea > 0 ? outerArea / innerArea : Infinity;
}

/**
 * @returns {Promise<{elements: Array, bounds: object, families: string[]}|null>}
 *   the tightest cached entry that covers `bounds` and includes every family.
 */
export async function findCached({ bounds, families, source }) {
  const db = await openDb();
  if (!db) return null;
  const wanted = [...families];
  const entries = await transact(db, 'readonly', (store, done) => {
    const request = store.getAll();
    request.onsuccess = () => done(request.result || []);
  });
  if (!entries?.length) return null;

  let best = null;
  for (const entry of entries) {
    if (!entry.bounds || !Array.isArray(entry.families)) continue;
    if (source && entry.source !== source) continue;
    if (!wanted.every((family) => entry.families.includes(family))) continue;
    if (!covers(entry.bounds, bounds)) continue;
    const waste = wastage(entry.bounds, bounds);
    if (!best || waste < best.waste) best = { entry, waste };
  }
  if (!best) return null;

  // Touch it so the eviction pass keeps what is actually being used.
  await transact(db, 'readwrite', (store) => {
    store.put({ ...best.entry, usedAt: Date.now() });
  });
  return best.entry;
}

export async function putCached({ bounds, families, source, features }) {
  const db = await openDb();
  if (!db) return false;
  const now = Date.now();
  const stored = await transact(db, 'readwrite', (store, done) => {
    store.add({ bounds, families: [...families], source, features, storedAt: now, usedAt: now });
    done(true);
  });
  if (stored) await evict(db);
  return Boolean(stored);
}

async function evict(db) {
  await transact(db, 'readwrite', (store) => {
    const request = store.getAll();
    request.onsuccess = () => {
      const entries = request.result || [];
      if (entries.length <= MAX_ENTRIES) return;
      entries
        .sort((a, b) => (a.usedAt || 0) - (b.usedAt || 0))
        .slice(0, entries.length - MAX_ENTRIES)
        .forEach((entry) => store.delete(entry.id));
    };
  });
}

export async function clearCache() {
  const db = await openDb();
  if (!db) return false;
  await transact(db, 'readwrite', (store) => store.clear());
  return true;
}

export async function cacheSize() {
  const db = await openDb();
  if (!db) return 0;
  const count = await transact(db, 'readonly', (store, done) => {
    const request = store.count();
    request.onsuccess = () => done(request.result);
  });
  return count || 0;
}
