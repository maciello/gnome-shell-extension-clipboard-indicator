/* tests/core/ClipboardEntry.test.js
 *
 * Unit tests for src/core/ClipboardEntry.js
 *
 * Covers:
 *   - text / image factory methods
 *   - isText / isImage / mimetype / isFavorite / getTag
 *   - key() === getStringValue() for text; image key format
 *   - equals() true/false
 *   - setText / setTag mutations
 *   - toRegistryRecord produces correct shape and key order
 *   - fromRegistryRecord round-trips for text, tagged-text, image
 */

import { suite, test, assert, assertEqual, assertDeepEqual } from '../harness.js';
import { ClipboardEntry } from '../../src/core/ClipboardEntry.js';
import { glibHashString } from '../../src/core/hash.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const TINY_PNG = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde,
]);

const PNG_ID = glibHashString(TINY_PNG);

// ---------------------------------------------------------------------------
// Text factory
// ---------------------------------------------------------------------------

suite('ClipboardEntry › text factory');

test('ClipboardEntry.text creates a text entry', () => {
    const e = ClipboardEntry.text('hello');
    assert(e.isText(), 'isText() must be true');
    assert(!e.isImage(), 'isImage() must be false');
});

test('text entry has default mimetype text/plain;charset=utf-8', () => {
    const e = ClipboardEntry.text('hi');
    assertEqual(e.mimetype(), 'text/plain;charset=utf-8');
});

test('text entry isFavorite defaults false', () => {
    const e = ClipboardEntry.text('x');
    assert(!e.isFavorite(), 'isFavorite must default false');
});

test('text entry isFavorite can be set true', () => {
    const e = ClipboardEntry.text('x', { favorite: true });
    assert(e.isFavorite(), 'isFavorite must be true when constructed with favorite:true');
});

test('text entry getTag defaults null', () => {
    const e = ClipboardEntry.text('x');
    assertEqual(e.getTag(), null);
});

test('text entry getTag returns provided tag', () => {
    const e = ClipboardEntry.text('x', { tag: 'work' });
    assertEqual(e.getTag(), 'work');
});

test('text key() equals getStringValue()', () => {
    const e = ClipboardEntry.text('hello world');
    assertEqual(e.key(), e.getStringValue());
    assertEqual(e.key(), 'hello world');
});

// ---------------------------------------------------------------------------
// Image factory
// ---------------------------------------------------------------------------

suite('ClipboardEntry › image factory');

test('ClipboardEntry.image creates an image entry', () => {
    const e = ClipboardEntry.image(TINY_PNG);
    assert(e.isImage(), 'isImage() must be true');
    assert(!e.isText(), 'isText() must be false');
});

test('image entry default mimetype is image/png', () => {
    const e = ClipboardEntry.image(TINY_PNG);
    assertEqual(e.mimetype(), 'image/png');
});

test('image key is [Image <id>]', () => {
    const e = ClipboardEntry.image(TINY_PNG);
    assertEqual(e.key(), `[Image ${PNG_ID}]`);
});

test('image key equals getStringValue()', () => {
    const e = ClipboardEntry.image(TINY_PNG);
    assertEqual(e.key(), e.getStringValue());
});

test('image id equals glibHashString(bytes)', () => {
    const e = ClipboardEntry.image(TINY_PNG);
    assertEqual(e.id(), PNG_ID);
});

// ---------------------------------------------------------------------------
// equals()
// ---------------------------------------------------------------------------

suite('ClipboardEntry › equals');

test('equals returns true for two text entries with same content', () => {
    const a = ClipboardEntry.text('same');
    const b = ClipboardEntry.text('same');
    assert(a.equals(b), 'same text must be equal');
});

test('equals returns false for text entries with different content', () => {
    const a = ClipboardEntry.text('foo');
    const b = ClipboardEntry.text('bar');
    assert(!a.equals(b), 'different text must not be equal');
});

test('equals returns true for two image entries with same bytes', () => {
    const a = ClipboardEntry.image(TINY_PNG);
    const b = ClipboardEntry.image(TINY_PNG);
    assert(a.equals(b), 'same image bytes must be equal');
});

test('equals returns false for image vs text', () => {
    const a = ClipboardEntry.image(TINY_PNG);
    const b = ClipboardEntry.text('not an image');
    assert(!a.equals(b), 'image must not equal text');
});

test('equals returns false for null', () => {
    const a = ClipboardEntry.text('x');
    assert(!a.equals(null));
});

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

suite('ClipboardEntry › setText');

test('setText updates key and getStringValue', () => {
    const e = ClipboardEntry.text('old');
    e.setText('new');
    assertEqual(e.key(), 'new');
    assertEqual(e.getStringValue(), 'new');
});

test('setText is a no-op for image entries', () => {
    const e = ClipboardEntry.image(TINY_PNG);
    const originalKey = e.key();
    e.setText('irrelevant');
    assertEqual(e.key(), originalKey, 'image key must not change after setText');
});

suite('ClipboardEntry › setTag');

test('setTag updates getTag', () => {
    const e = ClipboardEntry.text('x');
    e.setTag('label');
    assertEqual(e.getTag(), 'label');
});

test('setTag with falsy clears tag to null', () => {
    const e = ClipboardEntry.text('x', { tag: 'old' });
    e.setTag('');
    assertEqual(e.getTag(), null);
});

// ---------------------------------------------------------------------------
// toRegistryRecord
// ---------------------------------------------------------------------------

suite('ClipboardEntry › toRegistryRecord');

test('text record has favorite, mimetype, contents keys in that order', () => {
    const e = ClipboardEntry.text('hello');
    const rec = e.toRegistryRecord('/some/dir');
    const keys = Object.keys(rec);
    assertDeepEqual(keys, ['favorite', 'mimetype', 'contents']);
});

test('text record contents equals the text', () => {
    const e = ClipboardEntry.text('hello world');
    const rec = e.toRegistryRecord('/some/dir');
    assertEqual(rec.contents, 'hello world');
    assertEqual(rec.favorite, false);
    assertEqual(rec.mimetype, 'text/plain;charset=utf-8');
});

test('tagged text record has tag key after contents', () => {
    const e = ClipboardEntry.text('hello', { tag: 'work' });
    const rec = e.toRegistryRecord('/some/dir');
    const keys = Object.keys(rec);
    assertDeepEqual(keys, ['favorite', 'mimetype', 'contents', 'tag']);
    assertEqual(rec.tag, 'work');
});

test('image record contents is ${registryDir}/${id}', () => {
    const e = ClipboardEntry.image(TINY_PNG);
    const rec = e.toRegistryRecord('/cache/dir');
    assertEqual(rec.contents, `/cache/dir/${PNG_ID}`);
    assertEqual(rec.mimetype, 'image/png');
});

test('image record has favorite, mimetype, contents keys in that order', () => {
    const e = ClipboardEntry.image(TINY_PNG);
    const rec = e.toRegistryRecord('/d');
    const keys = Object.keys(rec);
    assertDeepEqual(keys, ['favorite', 'mimetype', 'contents']);
});

// ---------------------------------------------------------------------------
// fromRegistryRecord round-trips
// ---------------------------------------------------------------------------

suite('ClipboardEntry › fromRegistryRecord round-trips');

test('plain text record round-trips', () => {
    const record = {
        favorite: false,
        mimetype: 'text/plain;charset=utf-8',
        contents: 'round-trip text',
    };
    const entry = ClipboardEntry.fromRegistryRecord(record);
    const back = entry.toRegistryRecord('/any/dir');
    assertEqual(JSON.stringify(back), JSON.stringify(record));
});

test('text record with tag round-trips', () => {
    const record = {
        favorite: true,
        mimetype: 'text/plain;charset=utf-8',
        contents: 'tagged content',
        tag: 'my-tag',
    };
    const entry = ClipboardEntry.fromRegistryRecord(record);
    const back = entry.toRegistryRecord('/any/dir');
    assertEqual(JSON.stringify(back), JSON.stringify(record));
});

test('image record round-trips', () => {
    const REGISTRY_DIR = '/some/dir';
    const record = {
        favorite: true,
        mimetype: 'image/png',
        contents: `${REGISTRY_DIR}/123456`,
        tag: 'x',
    };
    const entry = ClipboardEntry.fromRegistryRecord(record);
    const back = entry.toRegistryRecord(REGISTRY_DIR);
    assertEqual(JSON.stringify(back), JSON.stringify(record));
});

test('fromRegistryRecord sets isImage for image mimetype', () => {
    const record = {
        favorite: false,
        mimetype: 'image/png',
        contents: '/dir/9999',
    };
    const entry = ClipboardEntry.fromRegistryRecord(record);
    assert(entry.isImage(), 'must be recognised as image');
    assert(!entry.isText(), 'must not be recognised as text');
});

test('fromRegistryRecord sets isText for text mimetype', () => {
    const record = {
        favorite: false,
        mimetype: 'text/plain;charset=utf-8',
        contents: 'hello',
    };
    const entry = ClipboardEntry.fromRegistryRecord(record);
    assert(entry.isText(), 'must be recognised as text');
});
