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
