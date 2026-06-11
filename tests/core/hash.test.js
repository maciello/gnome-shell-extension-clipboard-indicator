/* tests/core/hash.test.js
 *
 * Unit tests for src/core/hash.js — glibHash and glibHashString.
 *
 * Includes:
 *   - Fixed-vector tests (empty array, known small buffer).
 *   - Golden tests against real cache files whose names ARE glibHash results.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { suite, test, assert, assertEqual } from '../harness.js';
import { glibHash, glibHashString } from '../../src/core/hash.js';

// ---------------------------------------------------------------------------
// Fixed-vector tests — purely deterministic, no filesystem access
// ---------------------------------------------------------------------------

suite('hash › fixed vectors');

test('glibHash of empty Uint8Array is 5381 (djb2 init value)', () => {
    const h = glibHash(new Uint8Array(0));
    // djb2 starts at 5381; with no bytes the loop never runs.
    assertEqual(h, 5381);
});

test('glibHash returns an unsigned 32-bit number', () => {
    const h = glibHash(new Uint8Array([0x01, 0x02, 0x03, 0x04, 0xFF]));
    assert(Number.isInteger(h), 'result must be an integer');
    assert(h >= 0, 'result must be non-negative (unsigned)');
    assert(h <= 0xFFFFFFFF, 'result must fit in 32 bits');
});

test('glibHash of [0x61] ("a") is stable across calls', () => {
    const a = glibHash(new Uint8Array([0x61]));
    const b = glibHash(new Uint8Array([0x61]));
    assertEqual(a, b, 'same input must produce same output');
});

test('glibHash of "hello" bytes matches verified value', () => {
    // "hello" = [104, 101, 108, 108, 111]
    // All bytes < 128 so treated identically as signed and unsigned.
    // djb2 uses *32-bit* imul at each step, so intermediate products are
    // truncated before the next multiplication — this gives a different result
    // from the unbounded djb2 formula.  Value verified by running glibHash
    // directly in gjs.
    const h = glibHash(new Uint8Array([104, 101, 108, 108, 111]));
    assertEqual(h, 261238937);
});

test('glibHashString returns String(glibHash(bytes))', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    assertEqual(glibHashString(bytes), String(glibHash(bytes)));
});

test('glibHash treats bytes >= 128 as signed (wraps via b - 256)', () => {
    // A single byte 0xFF: sb = 0xFF - 256 = -1
    // h = ((5381 * 33 + (-1)) >>> 0) = (177573 - 1) >>> 0 = 177572
    const h = glibHash(new Uint8Array([0xFF]));
    assertEqual(h, 177572);
});

// ---------------------------------------------------------------------------
// Golden tests — verify against real on-disk cache files
// ---------------------------------------------------------------------------

suite('hash › golden (real cache files)');

test('glibHash matches filenames of real cache files', async () => {
    const CACHE_DIR = GLib.get_home_dir() +
        '/.cache/clipboard-indicator@tudmotu.com';

    // Check if the cache directory exists.
    if (!GLib.file_test(CACHE_DIR, GLib.FileTest.IS_DIR)) {
        print('    (skipped: cache dir absent)');
        return;
    }

    // Enumerate up to 5 files whose names are pure decimal digits.
    const dir = Gio.file_new_for_path(CACHE_DIR);
    let enumerator;
    try {
        enumerator = dir.enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null
        );
    } catch (e) {
        print(`    (skipped: cannot open cache dir: ${e.message})`);
        return;
    }

    const pureDigits = /^\d+$/;
    const candidates = [];
    let info;
    while ((info = enumerator.next_file(null)) !== null && candidates.length < 5) {
        const name = info.get_name();
        if (pureDigits.test(name) && info.get_file_type() === Gio.FileType.REGULAR) {
            candidates.push(name);
        }
    }
    enumerator.close(null);

    if (candidates.length === 0) {
        print('    (skipped: no numeric cache files found)');
        return;
    }

    let verified = 0;
    for (const filename of candidates) {
        const path = `${CACHE_DIR}/${filename}`;
        let ok = false;
        let bytes;
        try {
            [ok, bytes] = GLib.file_get_contents(path);
        } catch (e) {
            print(`    (skipped file ${filename}: ${e.message})`);
            continue;
        }
        if (!ok || !bytes) {
            print(`    (skipped file ${filename}: could not read)`);
            continue;
        }
        // bytes is already a Uint8Array in gjs
        const computed = String(glibHash(bytes));
        assertEqual(computed, filename,
            `glibHash of ${filename}: expected ${filename} got ${computed}`);
        verified++;
    }

    assert(verified > 0, 'must have verified at least one golden file');
    print(`    (verified ${verified} golden cache file(s))`);
});
