// Tips about the viewer's features, shown one at a time in a small pill at
// the bottom while the reader leaves the view idle. Pure and DOM-free: the
// viewer decides when to show one and remembers which were seen.

/**
 * Every tip as { id, parts, needs }: `parts` is the text, a string or
 * { key } for a keycap; `needs` names the feature the file must have for
 * the tip to apply (tour, pii, health, central), null when always.
 * `mod` is the platform's modifier key symbol (⌘ or Ctrl+).
 */
export function tipList(mod) {
  return [
    { id: 'search', parts: [{ key: `${mod}K` }, ' finds any table or column, and runs every command'], needs: null },
    { id: 'several', parts: [{ key: 'Shift' }, '-click more tables to select several and share them as one link'], needs: null },
    { id: 'join', parts: [{ key: `${mod}J` }, ' shows how two tables join, with the SQL'], needs: null },
    { id: 'tour', parts: ['Press ', { key: 'T' }, ' for a tour of every domain'], needs: 'tour' },
    { id: 'neighborhood', parts: ['Double-click a table to see it with the tables around it'], needs: null },
    { id: 'line', parts: ['Click a line to read its relation in one sentence'], needs: null },
    { id: 'back', parts: [{ key: '←' }, ' goes back to the table or view you came from'], needs: null },
    { id: 'copy', parts: [{ key: `${mod}C` }, ' copies the selected table as CREATE TABLE'], needs: null },
    { id: 'pii', parts: ['Press ', { key: 'P' }, ' to see where personal data lives'], needs: 'pii' },
    { id: 'health', parts: ['Press ', { key: 'H' }, ' for schema health: missing keys and indexes'], needs: 'health' },
    { id: 'central', parts: ['Press ', { key: 'S' }, ' to mark the most connected table of each domain'], needs: 'central' },
    { id: 'ranking', parts: ['Ranking lists the tables the rest of the schema leans on most'], needs: null },
    { id: 'link', parts: ['The address follows your selection: copy it to share what you see'], needs: null },
    { id: 'keys', parts: ['Press ', { key: '?' }, ' for every keyboard shortcut'], needs: null },
  ];
}

/**
 * The tip to show next among `tips`: the first one not in `seen` (ids), else
 * the one after `last` (an id, or null), round the list. Null when there
 * are none.
 */
export function nextTip(tips, seen, last) {
  if (tips.length === 0) return null;
  const unseen = tips.find((t) => !seen.includes(t.id));
  if (unseen) return unseen;
  const at = tips.findIndex((t) => t.id === last);
  return tips[(at + 1) % tips.length];
}
