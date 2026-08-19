// Works out where everything sits on the coaster, in millimetres, before any
// map data is involved. Everything downstream (projection, clipping, caption
// baselines) reads its geometry from here.

import { roundedRectPolygon, ellipsePolygon, convexClipEdges } from './clip.js';
import { measureText, getLoadedFont, applyTextCase } from './typography.js';
import { roundedRectPath, ellipsePath } from './paths.js';

function deflate(rect, amount) {
  return {
    x: rect.x + amount,
    y: rect.y + amount,
    w: Math.max(0.01, rect.w - amount * 2),
    h: Math.max(0.01, rect.h - amount * 2),
  };
}

/** Intersects several convex regions by concatenating their half-planes. */
function intersectConvex(regions) {
  const edges = [];
  let bounds = null;
  for (const region of regions) {
    edges.push(...region.edges);
    if (!bounds) bounds = { ...region.bounds };
    else {
      bounds.minX = Math.max(bounds.minX, region.bounds.minX);
      bounds.minY = Math.max(bounds.minY, region.bounds.minY);
      bounds.maxX = Math.min(bounds.maxX, region.bounds.maxX);
      bounds.maxY = Math.min(bounds.maxY, region.bounds.maxY);
    }
  }
  return { edges, bounds };
}

function halfPlaneAbove(y, rectBounds) {
  // Keeps everything with smaller y (higher on the page) than the cut line.
  return {
    edges: [{ nx: 0, ny: -1, c: y }],
    bounds: { ...rectBounds, maxY: Math.min(rectBounds.maxY, y) },
  };
}

/** Height and per-line baselines for the caption block. */
export function measureCaption(caption) {
  const lines = [];
  let total = 0;
  for (const line of caption.lines) {
    if (!line.text || !line.text.trim()) {
      if (line.blankKeepsSpace !== false) total += line.size * line.lineHeight;
      continue;
    }
    const font = getLoadedFont(line.font, line.weight, line.italic);
    const text = applyTextCase(line.text, line.textCase);
    const metrics = measureText(font, text, line.size, line.tracking);
    const advance = line.size * line.lineHeight;
    lines.push({ ...line, text, metrics, advance, offsetY: total });
    total += advance;
  }
  return { lines, height: total };
}

/**
 * Assembles the caption block and the box a pointer has to be inside to grab it.
 *
 * The block's position already carries the user's nudge, but the map window is
 * measured from the un-nudged position, so dragging the caption moves only the
 * caption.
 */
function buildCaptionBlock(metrics, placement) {
  const { top, centerX, left, right } = placement;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const line of metrics.lines) {
    const anchor = line.align === 'left' ? left : line.align === 'right' ? right : centerX;
    const offset = line.offsetX || 0;
    const start =
      line.align === 'left' ? anchor : line.align === 'right' ? anchor - line.metrics.width : anchor - line.metrics.width / 2;
    minX = Math.min(minX, start + offset);
    maxX = Math.max(maxX, start + offset + line.metrics.width);
  }
  const hasText = metrics.lines.length > 0;
  return {
    ...metrics,
    top,
    centerX,
    left,
    right,
    box: hasText
      ? { minX, maxX, minY: top, maxY: top + metrics.height }
      : { minX: 0, maxX: 0, minY: 0, maxY: 0 },
    hasText,
  };
}

/**
 * @returns layout geometry in millimetres for the whole coaster.
 */
export function computeLayout(state) {
  const { coaster, border, caption, mapArea } = state;
  const W = coaster.width;
  const H = coaster.shape === 'circle' ? coaster.width : coaster.height;
  const coasterRect = { x: 0, y: 0, w: W, h: H };
  const isCircle = coaster.shape === 'circle';
  const coasterRadius = isCircle ? W / 2 : coaster.cornerRadius;

  const content = deflate(coasterRect, coaster.margin);
  const contentRadius = Math.max(0, coasterRadius - coaster.margin);

  const captionMetrics = caption.enabled ? measureCaption(caption) : { lines: [], height: 0 };
  const captionHeight = captionMetrics.height;
  const captionGap = captionHeight > 0 ? caption.gap : 0;

  // The border sits either around the map alone (as in the reference coasters)
  // or around the whole face including the caption.
  const borderOnMap = border.enabled && border.scope === 'map';
  const borderOnCoaster = border.enabled && border.scope === 'coaster';

  let frame = content;
  let frameRadius = contentRadius;
  if (borderOnCoaster) {
    frame = deflate(content, border.thickness / 2);
    frameRadius = Math.max(0, contentRadius - border.thickness / 2);
  }

  const innerPad = borderOnCoaster ? border.thickness / 2 + border.padding : 0;
  const inner = deflate(frame, innerPad);
  const innerRadius = Math.max(0, frameRadius - innerPad);

  const centreX = W / 2;
  const centreY = H / 2;
  // Radius the artwork may actually use, once the margin and border are taken.
  const usableRadius = Math.max(
    1,
    contentRadius - (border.enabled ? border.thickness + border.padding : 0)
  );

  let mapBox = {
    x: inner.x,
    y: inner.y,
    w: inner.w,
    h: Math.max(1, inner.h - captionHeight - captionGap),
  };

  if (mapArea.aspect === 'square' && !isCircle) {
    const side = Math.min(mapBox.w, mapBox.h);
    mapBox = { x: mapBox.x + (mapBox.w - side) / 2, y: mapBox.y, w: side, h: side };
  }

  let captionTop = mapBox.y + mapBox.h + captionGap;
  let captionLeft = inner.x;
  let captionRight = inner.x + inner.w;

  if (isCircle) {
    // On a round coaster the caption has to sit inside the disc, not inside the
    // square that encloses it. Each line is only allowed as low as the chord
    // that is still wide enough to hold it, so a short line can drop further
    // than a long one and the block as a whole never runs off the edge.
    const inset = Math.max(1.5, usableRadius * 0.07);
    const pad = Math.max(1, usableRadius * 0.04);
    let captionBottom = centreY + usableRadius - inset;

    for (const line of captionMetrics.lines) {
      const halfWidth = line.metrics.width / 2 + pad;
      const chordY = centreY + Math.sqrt(Math.max(0, usableRadius * usableRadius - halfWidth * halfWidth));
      // Convert "this line's bottom edge" back into a limit on the whole block.
      const limit = chordY - line.offsetY - line.advance + captionHeight;
      captionBottom = Math.min(captionBottom, limit);
    }

    captionTop = captionHeight > 0 ? captionBottom - captionHeight : captionBottom;
    mapBox = {
      x: centreX - usableRadius,
      y: centreY - usableRadius,
      w: usableRadius * 2,
      h: Math.max(1, captionTop - captionGap - (centreY - usableRadius)),
    };
    // Left/right alignment follows the chord at the caption's widest row.
    const dy = Math.max(Math.abs(captionTop - centreY), Math.abs(captionBottom - centreY));
    const halfChord = Math.sqrt(Math.max(0, usableRadius * usableRadius - dy * dy));
    captionLeft = centreX - halfChord;
    captionRight = centreX + halfChord;
  }

  // Where the visible map frame is drawn, and where map geometry gets cut off.
  let mapFrameRect = mapBox;
  let mapFrameRadius = isCircle ? 0 : mapArea.cornerRadius;
  if (borderOnMap && !isCircle) {
    mapFrameRect = deflate(mapBox, border.thickness / 2);
    mapFrameRadius = Math.max(0, mapArea.cornerRadius - border.thickness / 2);
  }

  const clipInset = borderOnMap && !isCircle ? border.thickness / 2 + border.padding : 0;
  const clipRect = deflate(mapFrameRect, clipInset);
  const clipRadius = Math.max(0, mapFrameRadius - clipInset);

  let clip;
  let clipPathD;
  if (isCircle) {
    const circle = convexClipEdges(ellipsePolygon(centreX, centreY, usableRadius, usableRadius, 180));
    clip =
      captionHeight > 0
        ? intersectConvex([circle, halfPlaneAbove(captionTop - captionGap * 0.5, circle.bounds)])
        : circle;
    clipPathD = ellipsePath(centreX, centreY, usableRadius, usableRadius);
  } else {
    clip = convexClipEdges(roundedRectPolygon(clipRect, clipRadius, 18));
    clipPathD = roundedRectPath(clipRect, clipRadius);
  }

  let borderPath = null;
  if (border.enabled) {
    const circleBorderR = Math.max(1, contentRadius - border.thickness / 2);
    borderPath = isCircle
      ? ellipsePath(centreX, centreY, circleBorderR, circleBorderR)
      : borderOnMap
        ? roundedRectPath(mapFrameRect, mapFrameRadius)
        : roundedRectPath(frame, frameRadius);
  }

  const cutPath = coaster.cutLine
    ? isCircle
      ? ellipsePath(centreX, centreY, W / 2, H / 2)
      : roundedRectPath(coasterRect, coaster.cornerRadius)
    : null;

  return {
    width: W,
    height: H,
    isCircle,
    coasterRect,
    coasterRadius,
    coasterPath: isCircle
      ? ellipsePath(centreX, centreY, W / 2, H / 2)
      : roundedRectPath(coasterRect, coaster.cornerRadius),
    content,
    mapBox,
    mapRect: isCircle ? { x: 0, y: 0, w: W, h: H } : clipRect,
    projectionRect: isCircle
      ? { x: 0, y: 0, w: W, h: H }
      : clipRect,
    clip,
    clipPathD,
    borderPath,
    borderWidth: border.thickness,
    caption: buildCaptionBlock(captionMetrics, {
      top: captionTop + caption.offsetY,
      centerX: (isCircle ? centreX : inner.x + inner.w / 2) + caption.offsetX,
      left: captionLeft + caption.offsetX,
      right: captionRight + caption.offsetX,
    }),
    cutPath,
  };
}

export { roundedRectPath, ellipsePath };
