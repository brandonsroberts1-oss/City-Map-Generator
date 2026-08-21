// Shared SVG path builders. Kept separate from layout and pin geometry so both
// emit identical rounded corners and arcs.

export function fmt(n, decimals = 3) {
  const v = Number(n.toFixed(decimals));
  return Object.is(v, -0) ? 0 : v;
}

/** `reverse` traces the same shape the other way round, for punching holes. */
export function roundedRectPath(rect, radius, decimals = 3, reverse = false) {
  const r = Math.max(0, Math.min(radius, Math.min(rect.w, rect.h) / 2));
  const { x, y, w, h } = rect;
  const f = (n) => fmt(n, decimals);
  if (r < 0.001) {
    return reverse
      ? `M${f(x)} ${f(y)}V${f(y + h)}H${f(x + w)}V${f(y)}Z`
      : `M${f(x)} ${f(y)}H${f(x + w)}V${f(y + h)}H${f(x)}Z`;
  }
  if (reverse) {
    return (
      `M${f(x + r)} ${f(y)}` +
      `A${f(r)} ${f(r)} 0 0 0 ${f(x)} ${f(y + r)}` +
      `V${f(y + h - r)}A${f(r)} ${f(r)} 0 0 0 ${f(x + r)} ${f(y + h)}` +
      `H${f(x + w - r)}A${f(r)} ${f(r)} 0 0 0 ${f(x + w)} ${f(y + h - r)}` +
      `V${f(y + r)}A${f(r)} ${f(r)} 0 0 0 ${f(x + w - r)} ${f(y)}Z`
    );
  }
  return (
    `M${f(x + r)} ${f(y)}` +
    `H${f(x + w - r)}A${f(r)} ${f(r)} 0 0 1 ${f(x + w)} ${f(y + r)}` +
    `V${f(y + h - r)}A${f(r)} ${f(r)} 0 0 1 ${f(x + w - r)} ${f(y + h)}` +
    `H${f(x + r)}A${f(r)} ${f(r)} 0 0 1 ${f(x)} ${f(y + h - r)}` +
    `V${f(y + r)}A${f(r)} ${f(r)} 0 0 1 ${f(x + r)} ${f(y)}Z`
  );
}

export function ellipsePath(cx, cy, rx, ry, decimals = 3, reverse = false) {
  const f = (n) => fmt(n, decimals);
  const sweep = reverse ? 0 : 1;
  return (
    `M${f(cx - rx)} ${f(cy)}` +
    `A${f(rx)} ${f(ry)} 0 0 ${sweep} ${f(cx + rx)} ${f(cy)}` +
    `A${f(rx)} ${f(ry)} 0 0 ${sweep} ${f(cx - rx)} ${f(cy)}Z`
  );
}

/**
 * A rounded-rectangle frame as a filled ring: the outer edge traced one way and
 * the inner edge the other, so nonzero fill leaves the middle open. A stroked
 * rectangle would come into xTool as a hairline with no thickness at all.
 */
export function roundedRectBandPath(rect, radius, width, decimals = 3) {
  const half = width / 2;
  const outer = { x: rect.x - half, y: rect.y - half, w: rect.w + width, h: rect.h + width };
  const inner = {
    x: rect.x + half,
    y: rect.y + half,
    w: Math.max(0, rect.w - width),
    h: Math.max(0, rect.h - width),
  };
  if (inner.w <= 0 || inner.h <= 0) return roundedRectPath(outer, radius + half, decimals);
  return (
    roundedRectPath(outer, radius + half, decimals) +
    roundedRectPath(inner, Math.max(0, radius - half), decimals, true)
  );
}

/** The circular equivalent, for round coasters and ring-style pins. */
export function ellipseBandPath(cx, cy, r, width, decimals = 3) {
  const half = width / 2;
  const inner = r - half;
  if (inner <= 0) return ellipsePath(cx, cy, r + half, r + half, decimals);
  return (
    ellipsePath(cx, cy, r + half, r + half, decimals) +
    ellipsePath(cx, cy, inner, inner, decimals, true)
  );
}
