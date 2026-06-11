/* tests/core/HistoryModel.test.js
 *
 * Pure-core tests — no gi imports.  Run with:
 *   gjs -m tests/run.js
 */

import { suite, test, assert, assertEqual, assertDeepEqual } from '../harness.js';
import { ClipboardEntry } from '../../src/core/ClipboardEntry.js';
import { HistoryModel } from '../../src/core/HistoryModel.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function text (str, opts) {
    return ClipboardEntry.text(str, opts);
}

function image (id, opts) {
    // Use a tiny deterministic Uint8Array so we can build images without gi.
    // We supply explicit `id` to keep tests reproducible regardless of hash impl.
    const bytes = new Uint8Array([1, 2, 3, id & 0xff]);
    return ClipboardEntry.image(bytes, opts);
}

function makeModel (maxSize = 5) {
    return new HistoryModel({ maxSize });
}

// ---------------------------------------------------------------------------
suite('HistoryModel › construction');
// ---------------------------------------------------------------------------

test('default maxSize is 15', () => {
    const m = new HistoryModel();
    assertEqual(m.maxSize, 15);
    assertEqual(m.size, 0);
});

test('custom maxSize', () => {
    const m = makeModel(7);
    assertEqual(m.maxSize, 7);
});

test('setting maxSize does not auto-trim', () => {
    const m = makeModel(10);
    for (let i = 0; i < 6; i++) m.add(text(`item${i}`));
    m.maxSize = 3;
    assertEqual(m.size, 6, 'size unchanged after setting maxSize without trim()');
});

// ---------------------------------------------------------------------------
suite('HistoryModel › add / dedup');
// ---------------------------------------------------------------------------

test('add inserts entry and returns {added:true, entry}', () => {
    const m = makeModel();
    const e = text('hello');
    const result = m.add(e);
    assert(result.added, 'should be added');
    assert(result.entry === e, 'returned entry matches');
    assertEqual(m.size, 1);
});

test('add inserts at front (index 0)', () => {
    const m = makeModel();
    m.add(text('first'));
    m.add(text('second'));
    m.add(text('third'));
    const all = m.all();
    assertEqual(all[0].key(), 'third');
    assertEqual(all[1].key(), 'second');
    assertEqual(all[2].key(), 'first');
});

test('O(1) dedup: adding same key returns {added:false, existing}', () => {
    const m = makeModel();
    const e1 = text('dup');
    m.add(e1);
    const e2 = text('dup'); // same key, different object
    const result = m.add(e2);
    assert(!result.added, 'should NOT be added');
    assert(result.existing === e1, 'existing should be the first object');
    assertEqual(m.size, 1, 'size must stay 1');
});

test('dedup does not change order', () => {
    const m = makeModel();
    m.add(text('a'));
    m.add(text('b'));
    m.add(text('a')); // duplicate of first
    assertEqual(m.all()[0].key(), 'b', 'b stays at front');
    assertEqual(m.all()[1].key(), 'a', 'a stays at original position');
    assertEqual(m.size, 2);
});

test('has() returns correct booleans', () => {
    const m = makeModel();
    m.add(text('x'));
    assert(m.has('x'));
    assert(!m.has('y'));
});

test('get() returns correct entry or undefined', () => {
    const m = makeModel();
    const e = text('hello');
    m.add(e);
    assert(m.get('hello') === e);
    assertEqual(m.get('missing'), undefined);
});

test('image entry dedup via key', () => {
    const bytes = new Uint8Array([10, 20, 30]);
    const e1 = ClipboardEntry.image(bytes, { mimetype: 'image/png' });
    const e2 = ClipboardEntry.image(bytes, { mimetype: 'image/png' }); // same bytes => same key
    const m = makeModel();
    m.add(e1);
    const res = m.add(e2);
    assert(!res.added, 'duplicate image must not be added');
    assertEqual(m.size, 1);
});

// ---------------------------------------------------------------------------
suite('HistoryModel › remove');
// ---------------------------------------------------------------------------

test('remove deletes entry from array and index', () => {
    const m = makeModel();
    const a = text('a');
    const b = text('b');
    m.add(a);
    m.add(b);
    const removed = m.remove(a);
    assert(removed, 'should return true');
    assertEqual(m.size, 1);
    assert(!m.has('a'));
    assert(m.has('b'));
});

test('remove returns false for unknown entry', () => {
    const m = makeModel();
    const res = m.remove(text('ghost'));
    assert(!res);
});

test('remove middle entry keeps order', () => {
    const m = makeModel();
    m.add(text('a'));
    m.add(text('b'));
    m.add(text('c'));
    m.remove(text('b'));
    const keys = m.all().map(e => e.key());
    assertDeepEqual(keys, ['c', 'a']);
});

// ---------------------------------------------------------------------------
suite('HistoryModel › moveToFront');
// ---------------------------------------------------------------------------

test('moveToFront reorders entry to index 0', () => {
    const m = makeModel();
    const a = text('a');
    m.add(a);
    m.add(text('b'));
    m.add(text('c'));
    const moved = m.moveToFront(a);
    assert(moved, 'should return true');
    assertEqual(m.all()[0].key(), 'a');
});

test('moveToFront on already-front is no-op', () => {
    const m = makeModel();
    const a = text('a');
    m.add(text('b'));
    m.add(a);
    m.moveToFront(a);
    assertEqual(m.all()[0].key(), 'a');
    assertEqual(m.size, 2);
});

test('moveToFront returns false for unknown entry', () => {
    const m = makeModel();
    const res = m.moveToFront(text('x'));
    assert(!res);
});

test('moveToFront preserves all other entries', () => {
    const m = makeModel();
    ['a', 'b', 'c', 'd'].forEach(k => m.add(text(k)));
    m.moveToFront(text('b'));
    const keys = m.all().map(e => e.key());
    assertDeepEqual(keys, ['b', 'd', 'c', 'a']);
});

// ---------------------------------------------------------------------------
suite('HistoryModel › favorites() / history() partitioning');
// ---------------------------------------------------------------------------

test('history() returns only non-favorites, newest-first', () => {
    const m = makeModel();
    m.add(text('a'));
    m.add(text('b', { favorite: true }));
    m.add(text('c'));
    const h = m.history().map(e => e.key());
    assertDeepEqual(h, ['c', 'a']);
});

test('favorites() returns only favorites, newest-first', () => {
    const m = makeModel();
    m.add(text('a'));
    m.add(text('b', { favorite: true }));
    m.add(text('c', { favorite: true }));
    const f = m.favorites().map(e => e.key());
    assertDeepEqual(f, ['c', 'b']);
});

test('all() interleaves favorites and history by recency', () => {
    const m = makeModel();
    m.add(text('a'));
    m.add(text('b', { favorite: true }));
    m.add(text('c'));
    const keys = m.all().map(e => e.key());
    assertDeepEqual(keys, ['c', 'b', 'a']);
});

// ---------------------------------------------------------------------------
suite('HistoryModel › setFavorite');
// ---------------------------------------------------------------------------

test('setFavorite(entry, true) marks entry as favorite', () => {
    const m = makeModel();
    const e = text('x');
    m.add(e);
    m.setFavorite(e, true);
    assert(m.get('x').isFavorite());
    assertEqual(m.favorites().length, 1);
    assertEqual(m.history().length, 0);
});

test('setFavorite(entry, false) un-favorites an entry', () => {
    const m = makeModel();
    const e = text('x', { favorite: true });
    m.add(e);
    m.setFavorite(e, false);
    assert(!m.get('x').isFavorite());
    assertEqual(m.history().length, 1);
    assertEqual(m.favorites().length, 0);
});

test('setFavorite on unknown key is a no-op', () => {
    const m = makeModel();
    // Should not throw
    m.setFavorite(text('ghost'), true);
    assertEqual(m.size, 0);
});

// ---------------------------------------------------------------------------
suite('HistoryModel › trim');
// ---------------------------------------------------------------------------

test('trim removes oldest non-favorites until history().length <= maxSize', () => {
    const m = makeModel(3);
    m.add(text('a'));
    m.add(text('b'));
    m.add(text('c'));
    m.add(text('d'));
    m.add(text('e'));
    // history has 5 entries, maxSize=3 → should remove 2 oldest
    const removed = m.trim();
    assertEqual(removed.length, 2);
    assertEqual(m.history().length, 3);
    // oldest are 'a' and 'b'
    const removedKeys = removed.map(e => e.key()).sort();
    assertDeepEqual(removedKeys, ['a', 'b']);
});

test('trim never removes favorites', () => {
    const m = makeModel(2);
    m.add(text('fav1', { favorite: true }));
    m.add(text('fav2', { favorite: true }));
    m.add(text('h1'));
    m.add(text('h2'));
    m.add(text('h3'));
    // history has 3, maxSize=2 → trim 1 oldest non-fav ('h1')
    const removed = m.trim();
    assertEqual(removed.length, 1);
    assertEqual(removed[0].key(), 'h1');
    assertEqual(m.favorites().length, 2);
    assertEqual(m.history().length, 2);
});

test('trim returns removed entries (for caller to delete image files)', () => {
    const m = makeModel(1);
    m.add(text('keep'));
    m.add(text('drop'));
    const removed = m.trim();
    assertEqual(removed.length, 1);
    assertEqual(removed[0].key(), 'keep');
});

test('trim does not remove entries when within maxSize', () => {
    const m = makeModel(5);
    m.add(text('a'));
    m.add(text('b'));
    const removed = m.trim();
    assertEqual(removed.length, 0);
    assertEqual(m.size, 2);
});

test('trim with only favorites and history within limit is a no-op', () => {
    const m = makeModel(3);
    m.add(text('fav', { favorite: true }));
    m.add(text('h1'));
    m.add(text('h2'));
    const removed = m.trim();
    assertEqual(removed.length, 0);
    assertEqual(m.size, 3);
});

test('trim removes oldest non-fav when mixed with favorites interspersed', () => {
    const m = makeModel(2);
    // Insert newest-first: e → fav → d → c (in add order newest-first in array)
    m.add(text('c'));
    m.add(text('d'));
    m.add(text('fav', { favorite: true }));
    m.add(text('e'));
    // history: e, d, c (3 entries) → trim 1 → oldest is 'c'
    const removed = m.trim();
    assertEqual(removed.length, 1);
    assertEqual(removed[0].key(), 'c');
    assertEqual(m.history().length, 2);
    assert(m.has('fav'), 'fav must survive');
});

// ---------------------------------------------------------------------------
suite('HistoryModel › clear');
// ---------------------------------------------------------------------------

test('clear removes all non-favorites by default', () => {
    const m = makeModel();
    m.add(text('a'));
    m.add(text('b', { favorite: true }));
    m.add(text('c'));
    const removed = m.clear();
    assertEqual(removed.length, 2);
    assertEqual(m.size, 1);
    assert(m.has('b'));
    assert(!m.has('a'));
    assert(!m.has('c'));
});

test('clear with keepFavorites=false removes everything', () => {
    const m = makeModel();
    m.add(text('a', { favorite: true }));
    m.add(text('b'));
    const removed = m.clear({ keepFavorites: false });
    assertEqual(removed.length, 2);
    assertEqual(m.size, 0);
});

test('clear with keepKeys preserves those entries', () => {
    const m = makeModel();
    m.add(text('a'));
    m.add(text('b'));
    m.add(text('c'));
    const removed = m.clear({ keepFavorites: false, keepKeys: ['b'] });
    assertEqual(removed.length, 2);
    assertEqual(m.size, 1);
    assert(m.has('b'));
    assert(!m.has('a'));
    assert(!m.has('c'));
});

test('clear keeps both favorites and keepKeys entries', () => {
    const m = makeModel();
    m.add(text('a', { favorite: true }));
    m.add(text('b'));
    m.add(text('c'));
    const removed = m.clear({ keepFavorites: true, keepKeys: ['c'] });
    assertEqual(removed.length, 1);
    assertEqual(removed[0].key(), 'b');
    assert(m.has('a'));
    assert(m.has('c'));
    assert(!m.has('b'));
});

test('clear on empty model returns empty array', () => {
    const m = makeModel();
    const removed = m.clear();
    assertEqual(removed.length, 0);
    assertEqual(m.size, 0);
});

// ---------------------------------------------------------------------------
suite('HistoryModel › bulkLoad / fromRegistry');
// ---------------------------------------------------------------------------

test('bulkLoad resets state and loads entries newest-first', () => {
    const m = makeModel();
    m.add(text('old'));
    m.bulkLoad([text('newest'), text('middle'), text('oldest')]);
    assertEqual(m.size, 3);
    const keys = m.all().map(e => e.key());
    assertDeepEqual(keys, ['newest', 'middle', 'oldest']);
    assert(!m.has('old'), 'prior state should be discarded');
});

test('bulkLoad skips duplicate keys (first occurrence wins)', () => {
    const m = makeModel();
    m.bulkLoad([text('a'), text('b'), text('a')]); // 'a' appears twice
    assertEqual(m.size, 2);
    assertEqual(m.all()[0].key(), 'a');
    assertEqual(m.all()[1].key(), 'b');
});

test('fromRegistry static factory creates model with correct maxSize', () => {
    const entries = [text('x'), text('y')];
    const m = HistoryModel.fromRegistry(entries, { maxSize: 42 });
    assertEqual(m.maxSize, 42);
    assertEqual(m.size, 2);
    const keys = m.all().map(e => e.key());
    assertDeepEqual(keys, ['x', 'y']);
});

// ---------------------------------------------------------------------------
suite('HistoryModel › image entries');
// ---------------------------------------------------------------------------

test('image entry dedup by key (not by object reference)', () => {
    const bytes = new Uint8Array([255, 0, 128, 64]);
    const e1 = ClipboardEntry.image(bytes);
    const e2 = ClipboardEntry.image(bytes); // identical bytes => identical key
    const m = makeModel();
    m.add(e1);
    const res = m.add(e2);
    assert(!res.added, 'should detect duplicate image');
    assert(res.existing === e1);
    assertEqual(m.size, 1);
});

test('image entries with different bytes are independent', () => {
    const e1 = ClipboardEntry.image(new Uint8Array([1, 2, 3]));
    const e2 = ClipboardEntry.image(new Uint8Array([4, 5, 6]));
    const m = makeModel();
    m.add(e1);
    m.add(e2);
    assertEqual(m.size, 2);
});

test('trim removes image entries and returns them for file cleanup', () => {
    const m = makeModel(1);
    const img1 = ClipboardEntry.image(new Uint8Array([1]));
    const img2 = ClipboardEntry.image(new Uint8Array([2]));
    m.add(img1);
    m.add(img2);
    // history has 2 entries, maxSize=1 → trim 1 oldest (img1)
    const removed = m.trim();
    assertEqual(removed.length, 1);
    assertEqual(removed[0].key(), img1.key());
});
