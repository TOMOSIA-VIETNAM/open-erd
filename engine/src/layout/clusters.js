import { measureText } from '../text/measure.js';

// Frame padding is deliberately not a multiple of GRID: frame borders then sit
// between router tracks, so a relation line never runs along a border.
export const CLUSTER_PADDING = 35;
// Extra room above the tables for the domain label.
export const CLUSTER_PADDING_TOP = 55;
// Minimum free space between two tables, and between two cluster frames. The
// router keeps lines 30 px away from boxes, so 80 px leaves three tracks.
export const TABLE_GAP = 80;
export const CLUSTER_GAP = 80;
export const CLUSTER_PAD = { left: CLUSTER_PADDING, top: CLUSTER_PADDING_TOP, right: CLUSTER_PADDING, bottom: CLUSTER_PADDING };

// Database frames wrap cluster frames. Their padding is a multiple of GRID, so
// their borders also sit between router tracks.
export const DB_PAD = { left: 40, top: 70, right: 40, bottom: 40 };
export const DB_GAP = 120;
// Space around stubs in a domain view. A stub line runs from its table across
// the frame padding and this gap; 100 px leaves room beside the end markers
// for a "cross-DB" label, and between two stubs several router tracks.
export const STUB_GAP = 100;

export const LABEL_FONT = { size: 14, weight: 700 };
export const LABEL_OFFSET = { x: 16, y: 28 };
const LABEL_HEIGHT = 20;

/** Cluster a table belongs to: one per domain per database. */
export function clusterKey(table) {
  return `${table.id.split('.')[0]}/${table.domain}`;
}

export function clusterLabel(key) {
  return key.slice(key.indexOf('/') + 1);
}

export function boundingBox(boxes) {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return {
    x,
    y,
    w: Math.max(...boxes.map((b) => b.x + b.w)) - x,
    h: Math.max(...boxes.map((b) => b.y + b.h)) - y,
  };
}

export function padFrame(b, pad) {
  return { x: b.x - pad.left, y: b.y - pad.top, w: b.w + pad.left + pad.right, h: b.h + pad.top + pad.bottom };
}

/** Cluster frame drawn around the given table boxes. */
export function frameAround(boxes) {
  return padFrame(boundingBox(boxes), CLUSTER_PAD);
}

/** Area covered by the domain label; the router treats it as an obstacle. */
export function labelBox(frame, key) {
  return {
    x: frame.x + LABEL_OFFSET.x,
    y: frame.y + LABEL_OFFSET.y - LABEL_HEIGHT / 2 - 4,
    w: Math.ceil(measureText(clusterLabel(key), LABEL_FONT)) + 8,
    h: LABEL_HEIGHT + 8,
  };
}

export const DB_LABEL_FONT = { size: 15, weight: 700 };
export const ENGINE_FONT = { size: 11, weight: 700 };
const ENGINE_NAMES = { postgresql: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', mongodb: 'MongoDB', sqlite: 'SQLite', sqlserver: 'SQL Server', oracle: 'Oracle', dynamodb: 'DynamoDB' };
const DB_ICON = { w: 14, h: 16 };

/** Engine name as printed on the database frame; unknown engines as written. */
function engineName(engine) {
  return ENGINE_NAMES[engine] ?? engine;
}

/**
 * Header of a database frame: a cylinder icon, the database name and an
 * engine pill. Returns positions for the renderer and the area the router
 * must avoid.
 */
export function dbLabel(frame, database, engine) {
  const cy = frame.y + 32;
  const icon = { x: frame.x + 18, y: cy - DB_ICON.h / 2, ...DB_ICON };
  const nameX = icon.x + icon.w + 9;
  const nameW = Math.ceil(measureText(database, DB_LABEL_FONT));
  const engineText = engineName(engine);
  const pill = { x: nameX + nameW + 10, y: cy - 9, w: Math.ceil(measureText(engineText, ENGINE_FONT)) + 14, h: 18 };
  return {
    cy,
    icon,
    name: { x: nameX, text: database },
    engine: { text: engineText, x: pill.x + pill.w / 2 },
    pill,
    box: { x: icon.x - 6, y: cy - 14, w: pill.x + pill.w + 6 - (icon.x - 6), h: 28 },
  };
}
