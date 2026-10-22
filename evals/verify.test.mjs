// The structural half of the verification eval, without an LLM: on every
// fixture, wrong facts slipped into the expected model must be reported by
// the engine's facts comparison (what `open-erd verify` runs) when they are
// structural, and left to the verifier agent when an AI wrote them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ROOT } from './score.mjs';
import { injectWrongFacts, readExpected, toTexts } from './verify-case.mjs';
import { parseWorkspace } from '../engine/src/model/load.js';
import { compareFacts, describeDelta, readFacts } from '../engine/src/model/facts.js';
import { factsFromModel } from '../engine/test/helpers/facts.js';

const CASES = fs.readdirSync(path.join(ROOT, 'fixtures')).filter((c) => fs.existsSync(path.join(ROOT, 'fixtures', c, 'expected'))).sort();
const CONFIG = 'open-erd.yaml';

function load(caseName, files) {
  const texts = { [CONFIG]: fs.readFileSync(path.join(ROOT, 'fixtures', caseName, 'expected', CONFIG), 'utf8'), ...toTexts(files) };
  const { model, errors } = parseWorkspace(texts);
  assert.deepEqual(errors, [], `${caseName}: the model must stay valid`);
  return model;
}

for (const caseName of CASES) {
  test(`${caseName}: structural wrong facts are reported, AI-written ones are not`, () => {
    const expected = readExpected(caseName);
    const facts = readFacts(factsFromModel(load(caseName, expected)));
    assert.deepEqual(compareFacts(load(caseName, expected), facts).map(describeDelta), [], 'the expected model matches its own facts');

    const { files, injected } = injectWrongFacts(expected);
    const lines = compareFacts(load(caseName, files), facts).map(describeDelta);
    for (const item of injected) {
      const about = item.column ? `column ${item.table}.${item.column}:` : item.relation ? `relation ${item.table}.${item.relation.from.columns.join(', ')} ->` : `table ${item.table}:`;
      const reported = lines.filter((l) => l.startsWith(about));
      if (item.layer === 'structural') assert.ok(reported.length > 0, `${caseName}: ${item.id} not reported:\n${lines.join('\n')}`);
      else assert.deepEqual(reported, [], `${caseName}: ${item.id} is for the verifier agent, not the facts comparison`);
    }
    assert.ok(injected.some((i) => i.id === 'column-type') && injected.some((i) => i.id === 'table-note'));
  });
}
