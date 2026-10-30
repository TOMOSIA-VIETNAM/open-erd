import { stringify } from 'yaml';
import { columnEntries } from './columns.js';
import { compareStrings, parseYaml } from './load.js';
import { SCHEMA_VERSION, VERIFICATION_FILE, VERIFY_RESULTS, verificationFileSchema } from './schema.js';
import { joinPath, validateNode } from './validate.js';

// The record of the last verification: each fact an AI wrote that the
// verifier agent checked, with its verdict. The skills write it; `validate`,
// `verify` and `render` read it (render as the Verification sheet).

/** `{ verification, errors }` for the text of tests/verification.yaml. */
export function parseVerification(text) {
  const errors = [];
  const data = parseYaml(VERIFICATION_FILE, text, errors);
  if (data === undefined) return { verification: null, errors };
  for (const e of validateNode(data, verificationFileSchema)) errors.push({ file: VERIFICATION_FILE, ...e });
  if (errors.length === 0) {
    const seen = new Set();
    data.facts.forEach((f, i) => {
      if (seen.has(f.fact)) errors.push({ file: VERIFICATION_FILE, path: joinPath(joinPath('facts', i), 'fact'), message: `duplicate fact ${JSON.stringify(f.fact)}` });
      seen.add(f.fact);
    });
  }
  return { verification: errors.length > 0 ? null : data, errors };
}

/** Entries most in need of attention first (VERIFY_RESULTS order), then by fact. */
export function sortedFacts(verification) {
  return [...verification.facts].sort((a, b) => VERIFY_RESULTS.indexOf(a.result) - VERIFY_RESULTS.indexOf(b.result) || compareStrings(a.fact, b.fact));
}

/**
 * The file's text for `verification`, entries sorted, so the same verdicts
 * always give the same bytes whatever order they were collected in.
 */
export function serializeVerification(verification) {
  return (
    '# Last verification of the facts an AI wrote into the model (see skills/_shared/rules.md, "Verification").\n' +
    stringify({ schema_version: SCHEMA_VERSION, facts: sortedFacts(verification) })
  );
}

/** `verify: confirmed N, fixed M, unverifiable K` (`, wrong W` when some stayed wrong): the commit message line. */
export function verificationSummary(verification) {
  const count = (result) => verification.facts.filter((f) => f.result === result).length;
  const wrong = count('wrong');
  return `verify: confirmed ${count('confirmed')}, fixed ${count('fixed')}, unverifiable ${count('unverifiable')}${wrong > 0 ? `, wrong ${wrong}` : ''}`;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The record without the facts that name a table or column the profile
 * dropped from `shown` (`full` is the model before the profile): a verdict
 * line quotes the model path of what it checked, so it would otherwise name
 * a hidden table or PII column.
 */
export function verificationFor(verification, full, shown) {
  const kept = new Map(shown.tables.map((t) => [t.id, new Set(columnEntries(t).map((e) => e.path))]));
  const dropped = [];
  for (const t of full.tables) {
    if (!kept.has(t.id)) dropped.push(t.id);
    else for (const { path } of columnEntries(t)) if (!kept.get(t.id).has(path)) dropped.push(`${t.id}.${path}`);
  }
  if (dropped.length === 0) return verification;
  // A path ends at a non-name character, so `orders` does not match `orders_archive`.
  const names = new RegExp(`(?<![\\w.])(?:${dropped.map(escapeRegExp).join('|')})(?!\\w)`);
  return { ...verification, facts: verification.facts.filter((f) => !names.test(f.fact)) };
}
