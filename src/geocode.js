// Place search. Nominatim is tried first because its results carry the tidy
// "City, State" names the coaster caption wants; Photon is the fallback since
// it handles house numbers well and rate-limits less aggressively.

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const PHOTON = 'https://photon.komoot.io/api/';

function titleFromNominatim(item) {
  const a = item.address || {};
  const place = a.city || a.town || a.village || a.hamlet || a.suburb || a.municipality || a.county;
  const region = a.state || a.province || a.region;
  const road = a.road ? [a.house_number, a.road].filter(Boolean).join(' ') : null;
  const primary = road || place || item.name || item.display_name.split(',')[0];
  const secondary = road && place ? place : region;
  return {
    primary: primary || '',
    secondary: secondary || a.country || '',
  };
}

async function searchNominatim(query, signal) {
  const url = `${NOMINATIM}?q=${encodeURIComponent(
    query
  )}&format=jsonv2&addressdetails=1&limit=6&accept-language=en`;
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const data = await res.json();
  return data.map((item) => {
    const { primary, secondary } = titleFromNominatim(item);
    return {
      lat: parseFloat(item.lat),
      lon: parseFloat(item.lon),
      display: item.display_name,
      primary,
      secondary,
      bbox: item.boundingbox
        ? {
            south: parseFloat(item.boundingbox[0]),
            north: parseFloat(item.boundingbox[1]),
            west: parseFloat(item.boundingbox[2]),
            east: parseFloat(item.boundingbox[3]),
          }
        : null,
    };
  });
}

async function searchPhoton(query, signal) {
  const res = await fetch(`${PHOTON}?q=${encodeURIComponent(query)}&limit=6&lang=en`, { signal });
  if (!res.ok) throw new Error(`Photon HTTP ${res.status}`);
  const data = await res.json();
  return (data.features || []).map((f) => {
    const p = f.properties || {};
    const road = p.street ? [p.housenumber, p.street].filter(Boolean).join(' ') : null;
    const place = p.city || p.town || p.village || p.district || p.county;
    const primary = road || p.name || place || '';
    const secondary = road && place ? place : p.state || p.country || '';
    return {
      lat: f.geometry.coordinates[1],
      lon: f.geometry.coordinates[0],
      display: [primary, secondary, p.country].filter(Boolean).join(', '),
      primary,
      secondary,
      bbox: p.extent
        ? { west: p.extent[0], north: p.extent[1], east: p.extent[2], south: p.extent[3] }
        : null,
    };
  });
}

/** Accepts "39.9943, -76.7298" and skips the network entirely for it. */
export function parseLatLon(query) {
  const m = query
    .trim()
    .match(/^(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lon = parseFloat(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return {
    lat,
    lon,
    display: `${lat}, ${lon}`,
    primary: `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
    secondary: '',
    bbox: null,
  };
}

export async function geocode(query, { signal } = {}) {
  const direct = parseLatLon(query);
  if (direct) return [direct];
  try {
    const results = await searchNominatim(query, signal);
    if (results.length) return results;
  } catch (err) {
    if (err.name === 'AbortError') throw err;
  }
  return searchPhoton(query, signal);
}
