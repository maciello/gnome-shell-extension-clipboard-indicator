/* Tests for src/core/CacheGC.js — pure ESM, no gi imports. */

import { suite, test, assert, assertEqual, assertDeepEqual } from '../harness.js';
import { planCacheGC, isBookkeepingFile } from '../../src/core/CacheGC.js';

suite('CacheGC › isBookkeepingFile');

test('registry.txt is bookkeeping', () => {
    assert(isBookkeepingFile('registry.txt'));
});

test('registry.txt~ is bookkeeping', () => {
    assert(isBookkeepingFile('registry.txt~'));
});

test('registry.txt.backup is bookkeeping', () => {
    assert(isBookkeepingFile('registry.txt.backup'));
});

test('image hash filename is NOT bookkeeping', () => {
    assert(!isBookkeepingFile('12345678'));
});

test('arbitrary name is NOT bookkeeping', () => {
    assert(!isBookkeepingFile('somefile.png'));
});

// ---------------------------------------------------------------------------

suite('CacheGC › planCacheGC');

test('empty inputs produce empty outputs', () => {
    const result = planCacheGC({ diskFiles: [], referencedIds: [] });
    assertDeepEqual(result.orphans, []);
    assertDeepEqual(result.keep, []);
    assertDeepEqual(result.stats, { totalFiles: 0, referenced: 0, orphanCount: 0 });
});

test('orphan detection — unreferenced file becomes orphan', () => {
    const result = planCacheGC({
        diskFiles: ['111', '222', '333'],
        referencedIds: ['222'],
    });
    assertDeepEqual(result.orphans.sort(), ['111', '333']);
    assertDeepEqual(result.keep, ['222']);
    assertEqual(result.stats.orphanCount, 2);
});

test('referenced files are always kept', () => {
    const result = planCacheGC({
        diskFiles: ['aaa', 'bbb'],
        referencedIds: ['aaa', 'bbb'],
    });
    assertDeepEqual(result.orphans, []);
    assertEqual(result.keep.length, 2);
});

test('protected ids kept even when not in referencedIds', () => {
    const result = planCacheGC({
        diskFiles: ['favImg', 'normalImg'],
        referencedIds: [],
        options: { protect: ['favImg'] },
    });
    assertDeepEqual(result.orphans, ['normalImg']);
    assertDeepEqual(result.keep, ['favImg']);
});

test('bookkeeping files never orphaned even if passed in diskFiles', () => {
    const result = planCacheGC({
        diskFiles: ['registry.txt', 'registry.txt~', 'registry.txt.backup', 'orphan'],
        referencedIds: [],
    });
    assertDeepEqual(result.orphans, ['orphan']);
    const kept = result.keep.sort();
    assertDeepEqual(kept, ['registry.txt', 'registry.txt.backup', 'registry.txt~'].sort());
});

test('Set input for referencedIds works like array', () => {
    const result = planCacheGC({
        diskFiles: ['x', 'y', 'z'],
        referencedIds: new Set(['x']),
    });
    assertDeepEqual(result.orphans.sort(), ['y', 'z']);
    assertDeepEqual(result.keep, ['x']);
});

test('Set input for options.protect works like array', () => {
    const result = planCacheGC({
        diskFiles: ['a', 'b'],
        referencedIds: new Set(),
        options: { protect: new Set(['a']) },
    });
    assertDeepEqual(result.orphans, ['b']);
    assertDeepEqual(result.keep, ['a']);
});

test('stats.referenced reflects referencedIds size, not intersection', () => {
    // referenced may point to files not on disk; size should still be reported
    const result = planCacheGC({
        diskFiles: ['disk1'],
        referencedIds: ['disk1', 'notOnDisk1', 'notOnDisk2'],
    });
    assertEqual(result.stats.referenced, 3);
    assertEqual(result.stats.totalFiles, 1);
    assertEqual(result.stats.orphanCount, 0);
});

test('stats.totalFiles excludes nothing — raw diskFiles.length', () => {
    const result = planCacheGC({
        diskFiles: ['registry.txt', 'img1', 'img2'],
        referencedIds: [],
    });
    // diskFiles has 3 entries; registry.txt is kept, img1/img2 are orphans
    assertEqual(result.stats.totalFiles, 3);
    assertEqual(result.stats.orphanCount, 2);
});

test('protect and referenced overlap — file kept once', () => {
    const result = planCacheGC({
        diskFiles: ['shared'],
        referencedIds: ['shared'],
        options: { protect: ['shared'] },
    });
    assertDeepEqual(result.orphans, []);
    assertDeepEqual(result.keep, ['shared']);
});

test('no options object still works (default empty protect)', () => {
    const result = planCacheGC({
        diskFiles: ['lonely'],
        referencedIds: [],
    });
    assertDeepEqual(result.orphans, ['lonely']);
    assertDeepEqual(result.keep, []);
});
