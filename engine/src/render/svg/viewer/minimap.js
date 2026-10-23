// Minimap geometry, pure so node:test can check it. The minimap shows the
// whole current view scaled down, with a rectangle for the part on screen.
// "World" is the view's own coordinate space; the camera maps it to screen
// pixels as screen = world * s + (x, y).

/**
 * Size of a minimap `width` px wide for a view of `bounds` ({ x, y, w, h }),
 * its height following the view's shape but never above `maxHeight`, and
 * the scale from world to minimap px. Returns { w, h, scale }.
 */
export function minimapSize(bounds, width, maxHeight) {
  const scale = Math.min(width / bounds.w, maxHeight / bounds.h);
  return { w: Math.round(bounds.w * scale), h: Math.round(bounds.h * scale), scale };
}

/**
 * The world rectangle on screen: the viewport below the toolbar (`top` px),
 * left of a side panel `right` px wide when one is open.
 */
export function visibleRect(cam, viewport, top = 0, right = 0) {
  return { x: -cam.x / cam.s, y: (top - cam.y) / cam.s, w: (viewport.w - right) / cam.s, h: (viewport.h - top) / cam.s };
}

/** Whether all of `bounds` is inside `rect`, give or take one px. */
export function fitsInside(bounds, rect) {
  return bounds.x >= rect.x - 1 && bounds.y >= rect.y - 1 && bounds.x + bounds.w <= rect.x + rect.w + 1 && bounds.y + bounds.h <= rect.y + rect.h + 1;
}

/**
 * The camera that centres world point `p` in the visible area (see
 * visibleRect), keeping the scale.
 */
export function centreOn(p, cam, viewport, top = 0, right = 0) {
  return { s: cam.s, x: (viewport.w - right) / 2 - p.x * cam.s, y: top + (viewport.h - top) / 2 - p.y * cam.s };
}

/**
 * The camera that shows box `focus` in the visible area below the toolbar
 * (`top` px): at scale 1 when it fits there with `pad` px above and below,
 * else shrunk to fit, but never below `minScale` (where its text is still
 * readable). Centred; when even `minScale` is too large, its top sits `pad`
 * px under `top` and its bottom runs off the area.
 */
export function frameFocus(focus, viewport, top, minScale, pad) {
  const h = viewport.h - top;
  const s = Math.max(minScale, Math.min(1, (h - 2 * pad) / focus.h));
  const y = focus.h * s + 2 * pad <= h ? top + h / 2 - (focus.y + focus.h / 2) * s : top + pad - focus.y * s;
  return { s, x: viewport.w / 2 - (focus.x + focus.w / 2) * s, y };
}
