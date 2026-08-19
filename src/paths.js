// Shared SVG path builders. Kept separate from layout and pin geometry so both
// emit identical rounded corners and arcs.

export function fmt(n, decimals = 3) {
  const v = Number(n.toFixed(decimals));
  return Object.is(v, -0) ? 0 : v;
}

export function roundedRectPath(rect, radius, decimals = 3) {
  const r = Math.max(0, Math.min(radius, Math.min(rect.w, rect.h) / 2));
  const { x, y, w, h } = rect;
  const f = (n) => fmt(n, decimals);
  if (r < 0.001) return `M${f(x)} ${f(y)}H${f(x + w)}V${f(y + h)}H${f(x)}Z`;
  return (
    `M${f(x + r)} ${f(y)}` +
    `H${f(x + w - r)}A${f(r)} ${f(r)} 0 0 1 ${f(x + w)} ${f(y + r)}` +
    `V${f(y + h - r)}A${f(r)} ${f(r)} 0 0 1 ${f(x + w - r)} ${f(y + h)}` +
    `H${f(x + r)}A${f(r)} ${f(r)} 0 0 1 ${f(x)} ${f(y + h - r)}` +
    `V${f(y + r)}A${f(r)} ${f(r)} 0 0 1 ${f(x + r)} ${f(y)}Z`
  );
}

export function ellipsePath(cx, cy, rx, ry, decimals = 3) {
  const f = (n) => fmt(n, decimals);
  return (
    `M${f(cx - rx)} ${f(cy)}` +
    `A${f(rx)} ${f(ry)} 0 0 1 ${f(cx + rx)} ${f(cy)}` +
    `A${f(rx)} ${f(ry)} 0 0 1 ${f(cx - rx)} ${f(cy)}Z`
  );
}
