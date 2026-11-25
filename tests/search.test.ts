import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { findInRuns, searchQuery, type SearchRun } from '../src/pdf/search';

function find(runs: SearchRun[], query: string, matchCase = false, wholeWords = false) {
  return findInRuns(runs, searchQuery(query, matchCase), { matchCase, wholeWords });
}

test('maps a multiline phrase back to the exact substrings of split PDF runs', () => {
  const matches = find([{ str: 'a red', hasEOL: true }, { str: '  fo' }, { str: 'x runs' }], 'RED fox');
  assert.deepEqual(matches, [{ spans: [{ run: 0, start: 2, end: 5 }, { run: 1, start: 0, end: 4 }, { run: 2, start: 0, end: 1 }] }]);
});

test('matches Arabic with optional vowel marks, Kashida, and presentation forms', () => {
  const str = 'الــسَّلام ﻋﻠﻴﻜﻢ';
  assert.deepEqual(find([{ str }], 'السلام عليكم'), [{ spans: [{ run: 0, start: 0, end: str.length }] }]);
});

test('handles canonical accents, ligatures, full-width type and case folding', () => {
  for (const [text, query] of [['cafe\u0301', 'CAFÉ'], ['oﬃce', 'office'], ['ＰＤＦ', 'pdf'], ['Straße', 'STRASSE'], ['ΟΣ', 'ος']])
    assert.equal(find([{ str: text }], query).length, 1);
  assert.equal(find([{ str: 'Résumé' }], 'résumé', true).length, 0);
});

test('uses script-aware word boundaries and preserves meaningful marks', () => {
  assert.equal(find([{ str: 'catalog cat Cat' }], 'cat', false, true).length, 2);
  assert.equal(find([{ str: 'ภาษาไทย' }], 'ไทย', false, true).length, 1);
  assert.equal(find([{ str: 'किताब' }], 'कतब').length, 0);
  assert.equal(find([{ str: '中', hasEOL: true }, { str: '文' }], '中文').length, 1);
  assert.equal(find([{ str: 'abc' }], '  ').length, 0);
});
test('finds a word across a typeset hyphen at a line break', () => {
  for (const hyphen of ['-', '\u00ad']) {
    const runs = [{ str: 'inter' + hyphen }, { str: '', hasEOL: true }, { str: 'national' }];
    assert.equal(find(runs, 'international').length, 1);
    if (hyphen === '-') assert.equal(find(runs, 'inter-national').length, 1);
  }
  assert.equal(find([{ str: 're-enter' }], 'reenter').length, 0);
});
