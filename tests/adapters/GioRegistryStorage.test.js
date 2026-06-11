/* tests/adapters/GioRegistryStorage.test.js
 *
 * Integration tests for GioRegistryStorage.  Run standalone with:
 *   gjs -m tests/adapters/GioRegistryStorage.test.js
 *
 * Uses gi://GLib and gi://Gio for real filesystem I/O against a temp dir.
 * Does NOT import gi://St, gi://Clutter, gi://Meta, or any shell resource.
 *
 * Each test creates an isolated temp dir (GLib.dir_make_tmp), then cleans it
 * up in a finally block.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { suite, test, assert, assertEqual, assertDeepEqual, run } from '../harness.js';
import { GioRegistryStorage } from '../../src/adapters/GioRegistryStorage.js';
import { ClipboardEntry } from '../../src/core/ClipboardEntry.js';
import { glibHashString } from '../../src/core/hash.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal settings double.
 * @param {{ historySize?: number, cacheSizeMB?: number }} opts
 * @returns {{ getInt(key: string): number }}
 */
function fakeSettings ({ historySize = 50, cacheSizeMB = 10 } = {}) {
    return {
        getInt (key) {
            if (key === 'history-size') return historySize;
            if (key === 'cache-size') return cacheSizeMB;
            throw new Error(`fakeSettings: unknown key "${key}"`);
        },
    };
}

/**
 * Create a GioRegistryStorage whose registry dir is redirected to `tmpDir`
 * via the `_registryDir` test-override accepted by the constructor.
 *
 * @param {string} tmpDir
 * @param {object} [settingsOpts]
 * @returns {GioRegistryStorage}
 */
function makeTestStorage (tmpDir, settingsOpts = {}) {
    return new GioRegistryStorage(
        'test-uuid',
        fakeSettings(settingsOpts),
        { _registryDir: tmpDir }
    );
}

/**
 * Recursively delete `dirPath` and everything inside it (sync).
 * Silently ignores errors (used only in finally blocks).
 *
 * @param {string} dirPath
 */
function rmdirSync (dirPath) {
    try {
        const dir = Gio.file_new_for_path(dirPath);
        const enumerator = dir.enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null
        );
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const child = enumerator.get_child(info);
            if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                rmdirSync(child.get_path());
            } else {
                child.delete(null);
            }
        }
        enumerator.close(null);
        dir.delete(null);
    } catch (_) { /* ignore */ }
}

/**
 * Wait `ms` milliseconds using a real GLib timeout source.
 * Needed to let the debounce timer fire naturally.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep (ms) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

// ---------------------------------------------------------------------------
// Tiny PNG bytes (1×1 red pixel) used as a stand-in for a real image.
// ---------------------------------------------------------------------------

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
// Tests — registry round-trip
// ---------------------------------------------------------------------------

suite('GioRegistryStorage › read / write');

test('write then read produces byte-identical serialised records', async () => {
    const tmpDir = GLib.dir_make_tmp('grs-test-XXXXXX');
    try {
        const storage = makeTestStorage(tmpDir);
        const imageId = glibHashString(TINY_PNG);

        // Three canonical records: plain text, favorited+tagged text, image.
        const records = [
            { favorite: false, mimetype: 'text/plain;charset=utf-8', contents: 'hello world' },
            { favorite: true,  mimetype: 'text/plain;charset=utf-8', contents: 'favorited', tag: 'work' },
            { favorite: false, mimetype: 'image/png', contents: `${tmpDir}/${imageId}` },
        ];

        // Write image bytes so read() doesn't drop the entry.
        await storage.writeImageBytes(imageId, TINY_PNG, { mimetype: 'image/png' });

        // Build entries and persist.
        const entries = records.map(r => ClipboardEntry.fromRegistryRecord(r));
        await storage.write(entries);

        // Read back and re-serialise.
        const readback = await storage.read();
        assertEqual(readback.length, records.length, 'entry count must match');

        const serialised = readback.map(e => e.toRegistryRecord(tmpDir));
        assertDeepEqual(serialised, records, 'round-trip must be byte-identical');

        // Also verify the raw on-disk JSON.
        const file = Gio.file_new_for_path(tmpDir + '/registry.txt');
        const [, rawBytes] = file.load_contents(null);
        const rawJson = new TextDecoder().decode(rawBytes);
        assertEqual(rawJson, JSON.stringify(records), 'on-disk JSON must equal JSON.stringify(records)');
    } finally {
        rmdirSync(tmpDir);
    }
});

test('read() returns [] when registry.txt does not exist', async () => {
    const tmpDir = GLib.dir_make_tmp('grs-test-XXXXXX');
    try {
        const storage = makeTestStorage(tmpDir);
        const entries = await storage.read();
        assertDeepEqual(entries, []);
    } finally {
        rmdirSync(tmpDir);
    }
});

test('read() drops image entries whose cache file is missing', async () => {
    const tmpDir = GLib.dir_make_tmp('grs-test-XXXXXX');
    try {
        const storage = makeTestStorage(tmpDir);
        const imageId = glibHashString(TINY_PNG);

        // Write registry referencing an image but do NOT write the image file.
        const records = [
            { favorite: false, mimetype: 'text/plain;charset=utf-8', contents: 'keep me' },
            { favorite: false, mimetype: 'image/png', contents: `${tmpDir}/${imageId}` },
        ];
        await storage.write(records.map(r => ClipboardEntry.fromRegistryRecord(r)));

        const readback = await storage.read();
        assertEqual(readback.length, 1, 'image entry with no cache file must be dropped');
        assertEqual(readback[0].getStringValue(), 'keep me');
    } finally {
        rmdirSync(tmpDir);
    }
});

test('read() trims oldest non-favorites beyond history-size, keeps favorites', async () => {
    const tmpDir = GLib.dir_make_tmp('grs-test-XXXXXX');
    try {
        // history-size = 2; we write 4 non-favorites + 1 favorite.
        const storage = makeTestStorage(tmpDir, { historySize: 2 });
        const records = [
            { favorite: false, mimetype: 'text/plain;charset=utf-8', contents: 'entry1' },
            { favorite: false, mimetype: 'text/plain;charset=utf-8', contents: 'entry2' },
            { favorite: false, mimetype: 'text/plain;charset=utf-8', contents: 'entry3' },
            { favorite: false, mimetype: 'text/plain;charset=utf-8', contents: 'entry4' },
            { favorite: true,  mimetype: 'text/plain;charset=utf-8', contents: 'fav1' },
        ];
        await storage.write(records.map(r => ClipboardEntry.fromRegistryRecord(r)));

        const readback = await storage.read();
        const nonFavs = readback.filter(e => !e.isFavorite());
        const favs    = readback.filter(e =>  e.isFavorite());

        assertEqual(nonFavs.length, 2, 'non-favorites must be trimmed to historySize');
        assertEqual(favs.length,    1, 'favorites must never be trimmed');

        // Oldest non-favorites (entry3, entry4) must be dropped; newest kept.
        assertEqual(nonFavs[0].getStringValue(), 'entry1');
        assertEqual(nonFavs[1].getStringValue(), 'entry2');
    } finally {
        rmdirSync(tmpDir);
    }
});

test('read() backs up and returns [] when file >= cache-size MB', async () => {
    const tmpDir = GLib.dir_make_tmp('grs-test-XXXXXX');
    try {
        // cache-size = 0 MB means even a tiny file triggers the backup guard.
        const storage = makeTestStorage(tmpDir, { cacheSizeMB: 0 });
        await storage.write([ClipboardEntry.text('some content')]);

        const readback = await storage.read();
        assertDeepEqual(readback, [], 'oversized file must return []');

        assert(GLib.file_test(tmpDir + '/registry.txt~', GLib.FileTest.EXISTS), 'backup must be created');
        assert(!GLib.file_test(tmpDir + '/registry.txt', GLib.FileTest.EXISTS), 'original must be moved away');
    } finally {
        rmdirSync(tmpDir);
    }
});

// ---------------------------------------------------------------------------
// Tests — image byte cache
// ---------------------------------------------------------------------------

suite('GioRegistryStorage › image cache');

test('writeImageBytes + readImageBytes round-trip', async () => {
    const tmpDir = GLib.dir_make_tmp('grs-test-XXXXXX');
    try {
        const storage = makeTestStorage(tmpDir);
        const id = glibHashString(TINY_PNG);

        await storage.writeImageBytes(id, TINY_PNG, { mimetype: 'image/png' });
        const readback = await storage.readImageBytes(id);

        assert(readback !== null, 'readImageBytes must return bytes, not null');
        assertEqual(readback.length, TINY_PNG.length, 'byte count must match');
        for (let i = 0; i < TINY_PNG.length; i++) {
            assertEqual(readback[i], TINY_PNG[i], `byte[${i}] mismatch`);
        }
    } finally {
        rmdirSync(tmpDir);
    }
});

test('readImageBytes returns null for a missing file', async () => {
    const tmpDir = GLib.dir_make_tmp('grs-test-XXXXXX');
    try {
        const storage = makeTestStorage(tmpDir);
        const result = await storage.readImageBytes('9999999999');
        assertEqual(result, null);
    } finally {
        rmdirSync(tmpDir);
    }
});

test('deleteImage removes the file; second call is a no-op', async () => {
    const tmpDir = GLib.dir_make_tmp('grs-test-XXXXXX');
    try {
        const storage = makeTestStorage(tmpDir);
        const id = glibHashString(TINY_PNG);

        await storage.writeImageBytes(id, TINY_PNG);
        assert(GLib.file_test(tmpDir + '/' + id, GLib.FileTest.EXISTS), 'file must exist before deleteImage');

        await storage.deleteImage(id);
        assert(!GLib.file_test(tmpDir + '/' + id, GLib.FileTest.EXISTS), 'file must be gone after deleteImage');

        // Second delete on a missing file must not throw.
        await storage.deleteImage(id);
    } finally {
        rmdirSync(tmpDir);
    }
});

test('listImageFiles excludes registry bookkeeping filenames', async () => {
    const tmpDir = GLib.dir_make_tmp('grs-test-XXXXXX');
    try {
        const storage = makeTestStorage(tmpDir);
        const id = glibHashString(TINY_PNG);

        await storage.writeImageBytes(id, TINY_PNG);
        await storage.write([ClipboardEntry.text('text')]);   // creates registry.txt

        const files = await storage.listImageFiles();
        assert(files.includes(id), 'image id must appear in listImageFiles');
        assert(!files.includes('registry.txt'), 'registry.txt must be excluded');
        assert(!files.includes('registry.txt~'), 'backup must be excluded');
    } finally {
        rmdirSync(tmpDir);
    }
});

test('listImageFiles returns [] when directory does not exist', async () => {
    const tmpDir = GLib.dir_make_tmp('grs-test-XXXXXX');
    const subDir = tmpDir + '/nonexistent-subdir';
    try {
        const storage = makeTestStorage(subDir);
        const files = await storage.listImageFiles();
        assertDeepEqual(files, []);
    } finally {
        rmdirSync(tmpDir);
    }
});

// ---------------------------------------------------------------------------
// Tests — debounce coalescing
// ---------------------------------------------------------------------------

suite('GioRegistryStorage › debounce');

test('multiple writeDebounced calls coalesce: flush() writes the LAST snapshot', async () => {
    const tmpDir = GLib.dir_make_tmp('grs-test-XXXXXX');
    try {
        const storage = makeTestStorage(tmpDir);

        // Rapid calls with different payloads.
        storage.writeDebounced([ClipboardEntry.text('snap1')]);
        storage.writeDebounced([ClipboardEntry.text('snap2')]);
        storage.writeDebounced([ClipboardEntry.text('snap3')]);

        // The file must NOT exist yet — no synchronous write.
        assert(!GLib.file_test(tmpDir + '/registry.txt', GLib.FileTest.EXISTS),
               'file must not be written before debounce window expires');

        // flush() forces the write and waits for completion.
        await storage.flush();

        assert(GLib.file_test(tmpDir + '/registry.txt', GLib.FileTest.EXISTS),
               'file must exist after flush()');

        // Only the last snapshot (snap3) should have been written.
        const file = Gio.file_new_for_path(tmpDir + '/registry.txt');
        const [, rawBytes] = file.load_contents(null);
        const json = new TextDecoder().decode(rawBytes);
        const parsed = JSON.parse(json);

        assertEqual(parsed.length, 1, 'exactly one entry (snap3) should be in the file');
        assertEqual(parsed[0].contents, 'snap3', 'last writeDebounced payload must win');
    } finally {
        rmdirSync(tmpDir);
    }
});

test('flush() resolves after the write, file has correct content', async () => {
    const tmpDir = GLib.dir_make_tmp('grs-test-XXXXXX');
    try {
        const storage = makeTestStorage(tmpDir);
        storage.writeDebounced([ClipboardEntry.text('flush-test')]);

        let resolved = false;
        await storage.flush().then(() => { resolved = true; });

        assert(resolved, 'flush() promise must resolve');

        const file = Gio.file_new_for_path(tmpDir + '/registry.txt');
        const [, rawBytes] = file.load_contents(null);
        const parsed = JSON.parse(new TextDecoder().decode(rawBytes));
        assertEqual(parsed[0].contents, 'flush-test');
    } finally {
        rmdirSync(tmpDir);
    }
});

test('flush() on empty queue is a no-op (no error, no file created)', async () => {
    const tmpDir = GLib.dir_make_tmp('grs-test-XXXXXX');
    try {
        const storage = makeTestStorage(tmpDir);
        await storage.flush(); // nothing pending — must not throw
        assert(!GLib.file_test(tmpDir + '/registry.txt', GLib.FileTest.EXISTS),
               'no file should be created by flush() when queue is empty');
    } finally {
        rmdirSync(tmpDir);
    }
});

test('debounce window fires naturally after ~750 ms', async () => {
    const tmpDir = GLib.dir_make_tmp('grs-test-XXXXXX');
    try {
        const storage = makeTestStorage(tmpDir);
        storage.writeDebounced([ClipboardEntry.text('auto-fired')]);

        // Wait longer than 750 ms so the timer fires on its own.
        await sleep(950);

        assert(GLib.file_test(tmpDir + '/registry.txt', GLib.FileTest.EXISTS),
               'file must be written after the debounce window expires naturally');

        const file = Gio.file_new_for_path(tmpDir + '/registry.txt');
        const [, rawBytes] = file.load_contents(null);
        const parsed = JSON.parse(new TextDecoder().decode(rawBytes));
        assertEqual(parsed[0].contents, 'auto-fired');
    } finally {
        rmdirSync(tmpDir);
    }
});

// ---------------------------------------------------------------------------
// Self-contained entry point.
// Run with: gjs -m tests/adapters/GioRegistryStorage.test.js
// ---------------------------------------------------------------------------

const _failed = await run();
if (_failed > 0) {
    try {
        const { exit } = await import('system');
        exit(1);
    } catch {
        // Not under gjs — ignore.
    }
}
