// Pure parts of the viewer's Download menu: file names and the scale a view
// is rasterized at. Kept free of the DOM so they run under node:test.

// Pixels per SVG unit asked for: sharp on a retina screen and when zoomed in.
export const PIXEL_RATIO = 2;
// Canvas limits. WebKit (Safari) refuses a canvas above about 16.7 million
// pixels; Chrome and Firefox allow far more area but no side above 32767.
// Both are lowered a little: at the exact limit some versions still fail.
export const CANVAS_LIMITS = {
  webkit: { area: 16_000_000, side: 32_000 },
  other: { area: 260_000_000, side: 32_000 },
};

/**
 * Scale (canvas pixels per SVG unit) for a drawing of `w` x `h` units:
 * PIXEL_RATIO when the canvas fits the browser's limits, else the largest
 * scale that fits. `downscaled` says the reader gets less than asked for.
 */
export function canvasScale(w, h, limits) {
  const scale = Math.min(PIXEL_RATIO, Math.sqrt(limits.area / (w * h)), limits.side / w, limits.side / h);
  return { scale, width: Math.max(1, Math.floor(w * scale)), height: Math.max(1, Math.floor(h * scale)), downscaled: scale < PIXEL_RATIO };
}

// Letters and digits of any script survive; everything else becomes one dash.
const slug = (text) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'view';

/**
 * `<db-or-project>-<view>` as a file name without extension: a domain view
 * is named after its database and domain, a neighborhood after its centre
 * table's database and name, an impact view after its changed table (and
 * column), and the views of the whole system after
 * `project` (one database's name, or the project's).
 */
export function exportBaseName(project, view, center = null) {
  if (view.startsWith('domain:')) {
    const [db, ...domain] = view.slice('domain:'.length).split('/');
    return `${slug(db)}-${slug(domain.join('/'))}`;
  }
  if (view === 'neighborhood' && center) {
    // A table id `<db>.<schema>.<table>`, or a polymorphic node `<table id>«name»`.
    const [db, , name] = center.split('.');
    return `${slug(db)}-${slug(name)}-related`;
  }
  if (view === 'impact' && center) {
    // The changed table's id, with `.<column>` when a column changed.
    const [db, , name, ...column] = center.split('.');
    return `${slug(db)}-${slug([name, ...column].join('-'))}-impact`;
  }
  if (view === 'join-path' && center) return `${slug(project)}-join-${slug(center)}`;
  return `${slug(project)}-${view === 'all' ? 'all-tables' : slug(view)}`;
}
