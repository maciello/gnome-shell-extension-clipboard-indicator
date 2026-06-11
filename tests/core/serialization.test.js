/* tests/core/serialization.test.js
 *
 * Verifies that incremental serialization via ClipboardEntry.serializedRecord()
 * produces byte-identical output to JSON.stringify(entries.map(e=>e.toRegistryRecord(dir))),
 * and that cache invalidation works correctly on mutation.
 */

import { suite, test, assert, assertEqual } from '../harness.js';
import { ClipboardEntry } from '../../src/core/ClipboardEntry.js';
import { glibHashString } from '../../src/core/hash.js';

const DIR = '/tmp/test-registry-dir';

// Tiny PNG bytes (1×1 red pixel) for image entry tests.
const TINY_PNG = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
    0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc,
    0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
    0x44, 0xae, 0x42, 0x60, 0x82,
]);

// ---------------------------------------------------------------------------

suite('serialization › incremental vs full stringify');

test('empty array: incremental equals JSON.stringify', () => {
    const entries = [];
    const incremental = entries.length === 0
        ? '[]'
        : '[' + entries.map(e => e.serializedRecord(DIR)).join(',') + ']';
    const full = JSON.stringify(entries.map(e => e.toRegistryRecord(DIR)));
    assertEqual(incremental, full, 'empty array must produce []');
});

test('plain text entry: incremental is byte-identical to full stringify', () => {
    const entries = [ClipboardEntry.text('hello world')];
    const incremental = '[' + entries.map(e => e.serializedRecord(DIR)).join(',') + ']';
    const full = JSON.stringify(entries.map(e => e.toRegistryRecord(DIR)));
    assertEqual(incremental, full);
});

test('favorited+tagged text entry: incremental is byte-identical to full stringify', () => {
    const entries = [
        ClipboardEntry.text('favorited text', { favorite: true, tag: 'work' }),
    ];
    const incremental = '[' + entries.map(e => e.serializedRecord(DIR)).join(',') + ']';
    const full = JSON.stringify(entries.map(e => e.toRegistryRecord(DIR)));
    assertEqual(incremental, full);
});

test('image entry: incremental is byte-identical to full stringify', () => {
    const imageId = glibHashString(TINY_PNG);
    const entries = [ClipboardEntry.image(TINY_PNG, { mimetype: 'image/png' })];
    const incremental = '[' + entries.map(e => e.serializedRecord(DIR)).join(',') + ']';
    const full = JSON.stringify(entries.map(e => e.toRegistryRecord(DIR)));
    assertEqual(incremental, full);
});

test('mixed entries (text, tagged, image): incremental is byte-identical to full stringify', () => {
    const imageId = glibHashString(TINY_PNG);
    const entries = [
        ClipboardEntry.text('plain'),
        ClipboardEntry.text('tagged', { favorite: true, tag: 'dev' }),
        ClipboardEntry.image(TINY_PNG, { mimetype: 'image/png' }),
    ];
    const incremental = '[' + entries.map(e => e.serializedRecord(DIR)).join(',') + ']';
    const full = JSON.stringify(entries.map(e => e.toRegistryRecord(DIR)));
    assertEqual(incremental, full);
});

// ---------------------------------------------------------------------------

suite('serialization › cache invalidation on mutation');

test('setText invalidates serialized cache', () => {
    const entry = ClipboardEntry.text('original');
    const before = entry.serializedRecord(DIR);

    entry.setText('mutated');

    const after = entry.serializedRecord(DIR);
    assert(before !== after, 'setText must invalidate the serialized cache');
    assertEqual(after, JSON.stringify(entry.toRegistryRecord(DIR)));
});

test('setTag invalidates serialized cache', () => {
    const entry = ClipboardEntry.text('some text');
    const before = entry.serializedRecord(DIR);

    entry.setTag('newtag');

    const after = entry.serializedRecord(DIR);
    assert(before !== after, 'setTag must invalidate the serialized cache');
    assertEqual(after, JSON.stringify(entry.toRegistryRecord(DIR)));
});

test('setFavorite invalidates serialized cache', () => {
    const entry = ClipboardEntry.text('fav text');
    const before = entry.serializedRecord(DIR);

    entry.setFavorite(true);

    const after = entry.serializedRecord(DIR);
    assert(before !== after, 'setFavorite must invalidate the serialized cache');
    assertEqual(after, JSON.stringify(entry.toRegistryRecord(DIR)));
});

test('set favorite (setter) invalidates serialized cache', () => {
    const entry = ClipboardEntry.text('setter test');
    const before = entry.serializedRecord(DIR);

    entry.favorite = true;

    const after = entry.serializedRecord(DIR);
    assert(before !== after, 'set favorite must invalidate the serialized cache');
    assertEqual(after, JSON.stringify(entry.toRegistryRecord(DIR)));
});

test('cache hit: repeated calls without mutation return same string', () => {
    const entry = ClipboardEntry.text('stable');
    const first = entry.serializedRecord(DIR);
    const second = entry.serializedRecord(DIR);
    assertEqual(first, second, 'repeated serializedRecord must return same string');
});

test('cache is keyed by registryDir: different dirs produce independent results', () => {
    const entry = ClipboardEntry.image(TINY_PNG, { mimetype: 'image/png' });
    const dir1 = '/tmp/dir-a';
    const dir2 = '/tmp/dir-b';
    const s1 = entry.serializedRecord(dir1);
    const s2 = entry.serializedRecord(dir2);
    assert(s1 !== s2, 'different registryDirs must produce different serialized paths');
    assertEqual(s1, JSON.stringify(entry.toRegistryRecord(dir1)));
    assertEqual(s2, JSON.stringify(entry.toRegistryRecord(dir2)));
});
