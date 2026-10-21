import assert from 'node:assert/strict';
import { test } from 'node:test';
import chrome from './fixtures/chrome-text-widths.json' with { type: 'json' };
import { measureText, truncate } from '../src/text/measure.js';

// Regenerate the fixture with `npm run measure-chrome` after changing the font.
test('measureText matches Chrome within 2%', () => {
  assert.ok(chrome.samples.length >= 20);
  for (const { text, size, weight, width } of chrome.samples) {
    const measured = measureText(text, { size, weight });
    const deviation = Math.abs(measured - width) / width;
    assert.ok(deviation < 0.02, `${JSON.stringify(text)} ${size}px/${weight}: measured ${measured}, Chrome ${width}`);
  }
});

test('bold is wider than regular', () => {
  assert.ok(measureText('created_by', { size: 16, weight: 700 }) > measureText('created_by', { size: 16, weight: 400 }));
});

test('CJK characters are one em wide', () => {
  assert.equal(measureText('請求書', { size: 16 }), 48);
  assert.equal(measureText('ログイン', { size: 10 }), 40);
  assert.equal(measureText('사용자', { size: 12 }), 36);
});

test('characters outside the subset never measure narrower than any Inter glyph', () => {
  assert.ok(measureText('ệ', { size: 16 }) >= measureText('W', { size: 16 }));
});

test('truncate drops trailing spaces before the ellipsis', () => {
  assert.deepEqual(truncate('timestamp with time zone', 80, { size: 12, weight: 700 }), {
    text: 'timestamp\u2026',
    truncated: true,
  });
});

test('truncate keeps text that fits', () => {
  const width = measureText('users', { size: 12 });
  assert.deepEqual(truncate('users', width, { size: 12 }), { text: 'users', truncated: false });
});

test('truncate cuts with an ellipsis and fits the width', () => {
  const max = 80;
  const label = 'snake_case_identifier_with_numbers';
  const result = truncate(label, max, { size: 12, weight: 700 });
  assert.equal(result.truncated, true);
  assert.ok(result.text.endsWith('…'));
  assert.ok(measureText(result.text, { size: 12, weight: 700 }) <= max);
  // One more character would not have fitted.
  const next = label.slice(0, result.text.length);
  assert.ok(measureText(`${next}…`, { size: 12, weight: 700 }) > max);
});

test('truncate handles CJK and astral characters without splitting code points', () => {
  assert.deepEqual(truncate('請求書の明細', 40, { size: 10 }), { text: '請求書…', truncated: true });
  const result = truncate('a😀😀😀😀', 30, { size: 10 });
  assert.equal(result.truncated, true);
  assert.ok(!/[\ud800-\udbff]…$/.test(result.text));
});

test('truncate returns empty text when even the ellipsis does not fit', () => {
  assert.deepEqual(truncate('users', 1, { size: 12 }), { text: '', truncated: true });
});
