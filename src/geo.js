// Web-Mercator projection helpers and small geodesy utilities.
// All "mercator units" below are metres-at-the-equator; multiply by cos(latitude)
// to get true ground distance at that latitude.

export const EARTH_RADIUS = 6378137;
const DEG = Math.PI / 180;

export function lonToMercX(lon) {
  return EARTH_RADIUS * lon * DEG;
}

export function latToMercY(lat) {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  return EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + (clamped * DEG) / 2));
}

export function mercXToLon(x) {
  return x / EARTH_RADIUS / DEG;
}

export function mercYToLat(y) {
  return (2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2) / DEG;
}

/** Mercator units per metre of true ground distance at a given latitude. */
export function mercScaleAt(lat) {
  return 1 / Math.cos(Math.max(-85, Math.min(85, lat)) * DEG);
}

/**
 * Builds a projector that maps lon/lat onto a millimetre rectangle.
 *
 * `spanMetres` is the true ground width covered by the *shorter* side of the
 * rect, so square coasters and letterbox layouts both frame what you expect.
 */
export function createProjection({ lat, lon, spanMetres, rect }) {
  const cx = lonToMercX(lon);
  const cy = latToMercY(lat);
  const mercSpan = spanMetres * mercScaleAt(lat);
  const shortSide = Math.min(rect.w, rect.h) || 1;
  // millimetres per mercator unit
  const k = shortSide / mercSpan;

  const halfW = rect.w / 2 / k;
  const halfH = rect.h / 2 / k;
  const midX = rect.x + rect.w / 2;
  const midY = rect.y + rect.h / 2;

  const project = (lonDeg, latDeg) => [
    midX + (lonToMercX(lonDeg) - cx) * k,
    midY - (latToMercY(latDeg) - cy) * k,
  ];

  const unproject = (x, y) => [
    mercXToLon(cx + (x - midX) / k),
    mercYToLat(cy - (y - midY) / k),
  ];

  return {
    project,
    unproject,
    /** millimetres per metre of ground at the projection centre */
    mmPerMetre: k * mercScaleAt(lat),
    bounds: {
      south: mercYToLat(cy - halfH),
      north: mercYToLat(cy + halfH),
      west: mercXToLon(cx - halfW),
      east: mercXToLon(cx + halfW),
    },
  };
}

/** Grows a lat/lon bbox by `factor` of its own size on every side. */
export function padBounds(bounds, factor) {
  const dLat = (bounds.north - bounds.south) * factor;
  const dLon = (bounds.east - bounds.west) * factor;
  return {
    south: Math.max(-85, bounds.south - dLat),
    north: Math.min(85, bounds.north + dLat),
    west: bounds.west - dLon,
    east: bounds.east + dLon,
  };
}

export function boundsContain(outer, inner) {
  return (
    outer.south <= inner.south &&
    outer.north >= inner.north &&
    outer.west <= inner.west &&
    outer.east >= inner.east
  );
}

/** Formats a signed decimal degree the way the coaster subtitle wants it. */
export function formatCoordinate(value, axis, decimals = 4) {
  const hemisphere = axis === 'lat' ? (value >= 0 ? 'N' : 'S') : value >= 0 ? 'E' : 'W';
  return `${Math.abs(value).toFixed(decimals)}° ${hemisphere}`;
}
