// The command palette: one box (⌘K) finds tables and columns and runs the
// viewer's commands (join path, tour, downloads, highlights, ...). Pure
// functions over plain lists, so matching and ordering are tested without a
// browser.

/**
 * `a > b`, `a -> b` or `a → b`: the two table names of a join path query
 * ({ from, to }, either may be empty while typed), or null for any other text.
 */
export function parseJoinQuery(text) {
  const m = /^(.*?)\s*(?:->|→|>)\s*(.*)$/.exec(text.trim());
  return m ? { from: m[1].trim(), to: m[2].trim() } : null;
}

const words = (text) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * The commands matching `query`, each as { command, score }: score 0 when a
 * word of its label starts with the query, 1 when the label or one of its
 * `keywords` contains it. Best score first, then the commands' own order.
 * An empty query keeps every command (score 0).
 * `commands`: [{ label, keywords?: [string] }].
 */
export function matchCommands(query, commands) {
  const q = query.trim().toLowerCase();
  const scored = commands.map((command) => {
    if (!q) return { command, score: 0 };
    const label = command.label.toLowerCase();
    if (label.startsWith(q) || words(label).some((w) => w.startsWith(q))) return { command, score: 0 };
    if (label.includes(q) || (command.keywords ?? []).some((k) => k.toLowerCase().includes(q))) return { command, score: 1 };
    return null;
  });
  return scored.filter(Boolean).sort((a, b) => a.score - b.score);
}

/**
 * Whether the matching commands are listed above the tables and columns:
 * only when a command's label word starts with the query and no table or
 * column name (`names`) does, so Enter keeps opening the table a reader
 * typed the start of.
 */
export function commandsFirst(query, matches, names) {
  const q = query.trim().toLowerCase();
  return Boolean(q) && matches[0]?.score === 0 && !names.some((n) => n.toLowerCase().startsWith(q));
}
