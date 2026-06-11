/* tests/core/registry-fidelity.test.js
 *
 * THE DATA-SAFETY PROOF.
 *
 * Reads the user's real registry.txt (if present), parses every record, and
 * verifies that ClipboardEntry.fromRegistryRecord(record).toRegistryRecord(dir)
 * is byte-identical to JSON.stringify(record).
 *
 * A single mismatch is a real data-loss bug.
 */

import GLib from 'gi://GLib';

import { suite, test, assert, assertEqual } from '../harness.js';
import { ClipboardEntry } from '../../src/core/ClipboardEntry.js';

suite('registry-fidelity');

test('every record in the real registry.txt survives a round-trip unchanged', () => {
    const CACHE_DIR = GLib.get_home_dir() +
        '/.cache/clipboard-indicator@tudmotu.com';
    const REGISTRY_PATH = `${CACHE_DIR}/registry.txt`;

    if (!GLib.file_test(REGISTRY_PATH, GLib.FileTest.EXISTS)) {
        print('    (skipped: registry.txt absent)');
        return;
    }

    let ok = false;
    let rawBytes;
    try {
        [ok, rawBytes] = GLib.file_get_contents(REGISTRY_PATH);
    } catch (e) {
        print(`    (skipped: cannot read registry.txt: ${e.message})`);
        return;
    }

    if (!ok || !rawBytes) {
        print('    (skipped: GLib.file_get_contents returned no data)');
        return;
    }

    const rawJson = new TextDecoder().decode(rawBytes);
    let records;
    try {
        records = JSON.parse(rawJson);
    } catch (e) {
        print(`    (skipped: registry.txt is not valid JSON: ${e.message})`);
        return;
    }

    if (!Array.isArray(records)) {
        print('    (skipped: registry.txt top-level is not an array)');
        return;
    }

    let verified = 0;
    let failures = 0;

    for (let i = 0; i < records.length; i++) {
        const record = records[i];

        // Determine registryDir: for images it is the directory part of
        // record.contents; for text any dir will do (contents is the text).
        let registryDir;
        if (record.mimetype && record.mimetype.startsWith('image/') &&
                typeof record.contents === 'string') {
            const lastSlash = record.contents.lastIndexOf('/');
            registryDir = lastSlash === -1 ? '.' : record.contents.slice(0, lastSlash);
        } else {
            registryDir = CACHE_DIR;
        }

        let entry;
        try {
            entry = ClipboardEntry.fromRegistryRecord(record);
        } catch (e) {
            failures++;
            print(`    FAIL record[${i}]: fromRegistryRecord threw: ${e.message}`);
            continue;
        }

        const back = entry.toRegistryRecord(registryDir);
        const expected = JSON.stringify(record);
        const actual   = JSON.stringify(back);

        if (actual !== expected) {
            failures++;
            if (failures <= 3) {
                print(`    FAIL record[${i}]:`);
                print(`      expected: ${expected.slice(0, 200)}`);
                print(`      got:      ${actual.slice(0, 200)}`);
            }
        } else {
            verified++;
        }
    }

    print(`    (verified ${verified} / ${records.length} records byte-identical)`);

    assertEqual(failures, 0,
        `${failures} record(s) failed the round-trip — data-loss risk!`);
    assert(verified > 0,
        'must have verified at least 1 record when registry.txt is present');
});
