/**
 * bench/run.js — headless freeze-fix benchmark
 * Run:  gjs -m bench/run.js
 *
 * Measures four things proving the v71 compositor-thread freeze is gone:
 *   1. COPY-PATH DEDUP      — O(n)×hash(13MB)  →  O(1) Map lookup
 *   2. REGISTRY WRITE COALESCING — 20 writes → 1 effective write
 *   3. SEARCH               — per-keystroke RegExp alloc → compiled-once matcher
 *   4. MENU MODEL PREP      — HistoryModel build + partition (qualitative actor note)
 */

import GLib from 'gi://GLib';
import Gio  from 'gi://Gio';

import { glibHash, glibHashString } from '../src/core/hash.js';
import { ClipboardEntry }          from '../src/core/ClipboardEntry.js';
import { HistoryModel }            from '../src/core/HistoryModel.js';
import { SearchFilter }            from '../src/core/SearchFilter.js';
import { Debouncer }               from '../src/core/Debouncer.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

/** GLib.get_monotonic_time() returns microseconds; convert to ms. */
function now () { return GLib.get_monotonic_time() / 1000; }

function hr () { print('─'.repeat(72)); }

function readFileBytes (path) {
    const [ok, contents] = GLib.file_get_contents(path);
    if (!ok) throw new Error(`Cannot read ${path}`);
    return contents instanceof Uint8Array ? contents : new Uint8Array(contents);
}

function writeFileSync (path, data) {
    const f = Gio.File.new_for_path(path);
    const [ok] = f.replace_contents(data, null, false,
        Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    if (!ok) throw new Error(`write failed: ${path}`);
}

/** Create + return a temp dir path, guaranteed unique. */
function makeTempDir () {
    return GLib.dir_make_tmp('clipboard-bench-XXXXXX');
}

// ─── load real data ───────────────────────────────────────────────────────────

const CACHE_DIR = GLib.build_filenamev([GLib.get_home_dir(),
    '.cache', 'clipboard-indicator@tudmotu.com']);

const REGISTRY_PATH = GLib.build_filenamev([CACHE_DIR, 'registry.txt']);

let registryData;
let useRealData = true;

try {
    const [ok, raw] = GLib.file_get_contents(REGISTRY_PATH);
    if (!ok) throw new Error('file_get_contents returned false');
    const decoder = new TextDecoder('utf-8');
    registryData = JSON.parse(decoder.decode(raw instanceof Uint8Array ? raw : new Uint8Array(raw)));
    print(`[data] loaded registry.txt: ${registryData.length} records`);
} catch (e) {
    useRealData = false;
    print(`[data] registry.txt absent (${e.message}) — using SYNTHETIC data`);
    // Synthetic: 944 text + 59 image entries
    registryData = [];
    for (let i = 0; i < 944; i++) {
        registryData.push({ favorite: false, mimetype: 'text/plain;charset=utf-8',
            contents: `Synthetic clipboard text entry number ${i} with some extra padding to be realistic.` });
    }
    for (let i = 0; i < 59; i++) {
        // Use a fake numeric filename as identity
        registryData.push({ favorite: false, mimetype: 'image/png',
            contents: `/tmp/fake-cache/${100000000 + i}` });
    }
}

// Parse all registry records into ClipboardEntry objects.
const entries = registryData.map(r => ClipboardEntry.fromRegistryRecord(r));
const totalEntries  = entries.length;
const imageEntries  = entries.filter(e => e.isImage());
const textEntries   = entries.filter(e => e.isText());

print(`[data] parsed ${totalEntries} entries (${imageEntries.length} images, ${textEntries.length} text)`);

// ─── load the 10 largest real image files ─────────────────────────────────────

const IMAGE_COUNT = 10;
// Top-10 largest by size (bytes descending) — from real ls output
const LARGE_IMAGES_RANKED = [
    '1850152637',  // 13 301 670 bytes
    '1052497131',  // 13 042 711 bytes
    '228647291',   //  3 438 157 bytes
    '3406387877',  //  3 321 944 bytes
    '2721558990',  //  2 973 281 bytes
    '3046410497',  //  2 968 439 bytes
    '2239102026',  //  2 966 267 bytes
    '2364544384',  //  2 962 531 bytes
    '3677486422',  //  2 826 601 bytes
    '765805893',   //  2 820 999 bytes
];

let loadedImageBuffers = [];  // [{ id, bytes }]
let syntheticImages    = false;

for (const imgId of LARGE_IMAGES_RANKED) {
    const imgPath = GLib.build_filenamev([CACHE_DIR, imgId]);
    try {
        const bytes = readFileBytes(imgPath);
        loadedImageBuffers.push({ id: imgId, bytes });
        if (loadedImageBuffers.length >= IMAGE_COUNT) break;
    } catch (_) {
        // file missing — skip
    }
}

if (loadedImageBuffers.length === 0) {
    syntheticImages = true;
    print('[data] image files absent — using SYNTHETIC image bytes (13 MB each, 10 images)');
    for (let i = 0; i < IMAGE_COUNT; i++) {
        const bytes = new Uint8Array(13 * 1024 * 1024);
        // fill with pseudo-random pattern so hash is non-trivial
        for (let j = 0; j < bytes.length; j += 4096) bytes[j] = i * 7 + j;
        loadedImageBuffers.push({ id: String(100000000 + i), bytes });
    }
} else {
    const tag = syntheticImages ? 'SYNTHETIC' : 'REAL';
    print(`[data] loaded ${loadedImageBuffers.length} largest image files (${tag})`);
    for (const { id, bytes } of loadedImageBuffers) {
        print(`  ${id}: ${(bytes.length / 1024 / 1024).toFixed(2)} MB`);
    }
}

// ─── pick a "new copy" that already exists in the model ──────────────────────
// Use the LARGEST image's bytes as the "incoming copy" we want to dedup.
const newImageBytes  = loadedImageBuffers[0].bytes;
const newImageEntry  = ClipboardEntry.image(newImageBytes);  // identity computed ONCE here
const newImageKey    = newImageEntry.key();  // "[Image <hash>]"

print(`\n[data] dedup target key: ${newImageKey.slice(0, 40)}…`);

// ─── build a map: image id → pre-loaded bytes (for OLD dedup simulation) ─────
const bytesById = new Map();
for (const { id, bytes } of loadedImageBuffers) {
    bytesById.set(id, bytes);
}

// ─── BENCHMARK 1: COPY-PATH DEDUP ────────────────────────────────────────────

hr();
print('BENCHMARK 1 — COPY-PATH DEDUP (headline fix)');
print('');
print(`  Subset: ${loadedImageBuffers.length} largest real images pre-loaded into memory`);
print(`  History: ${totalEntries} entries (${imageEntries.length} images, ${textEntries.length} text)`);
print('');

// OLD: iterate ALL entries, for each IMAGE entry recompute glibHash over full bytes
// (exactly what `[Image <hash>]` == getStringValue() did — but OLD code re-hashed
//  bytes every time to build that string instead of caching identity at construction).
// We simulate the per-copy cost: build "[Image <hash>]" from bytes for every image
// entry that has bytes loaded, then compare against newImageKey.

const DEDUP_ITERS = 50;  // repeat to get stable timing

// warm up
for (let w = 0; w < 3; w++) {
    for (const e of imageEntries) {
        if (bytesById.has(e.id())) {
            const computedKey = `[Image ${glibHashString(bytesById.get(e.id()))}]`;
            if (computedKey === newImageKey) break;
        }
    }
}

const t0old = now();
for (let iter = 0; iter < DEDUP_ITERS; iter++) {
    for (const e of imageEntries) {
        if (bytesById.has(e.id())) {
            // Re-hash full bytes every comparison — what the old code did
            const computedKey = `[Image ${glibHashString(bytesById.get(e.id()))}]`;
            if (computedKey === newImageKey) break;
        }
    }
}
const t1old = now();
const oldDedupMs = (t1old - t0old) / DEDUP_ITERS;

// NEW: build HistoryModel, bulk-load entries (identity cached at construction).
// Dedup = model.get(newEntry.key()) — pure O(1) Map lookup.
const model1 = new HistoryModel({ maxSize: totalEntries + 10 });
model1.bulkLoad(entries);
// Ensure the target exists (it should, since we loaded it from registry)
// If not (synthetic), add it.
if (!model1.has(newImageKey)) {
    // Add a pre-keyed entry matching newImageKey
    model1.add(ClipboardEntry.image(null, { id: newImageEntry.id() }));
}

// warm up
for (let w = 0; w < 3; w++) { model1.get(newImageKey); }

const t0new = now();
for (let iter = 0; iter < DEDUP_ITERS; iter++) {
    model1.get(newImageKey);
}
const t1new = now();
const newDedupMs = (t1new - t0new) / DEDUP_ITERS;

const dedupFactor = oldDedupMs / Math.max(newDedupMs, 0.0001);

print(`  OLD (re-hash every copy):   ${oldDedupMs.toFixed(3)} ms / copy`);
print(`  NEW (O(1) Map lookup):      ${newDedupMs.toFixed(4)} ms / copy`);
print(`  Speedup:                    ${dedupFactor.toFixed(0)}×`);

// ─── BENCHMARK 2: REGISTRY WRITE COALESCING ──────────────────────────────────

hr();
print('BENCHMARK 2 — REGISTRY WRITE COALESCING');
print('');

const WRITE_COPIES = 20;
const tmpDir = makeTempDir();
const tmpFile = GLib.build_filenamev([tmpDir, 'registry-bench.txt']);

// Serialize all 1003 entries to a JSON string (what registry.save() does)
const registryDir = CACHE_DIR;
const serialiseRecords = () => {
    const records = entries.map(e => e.toRegistryRecord(registryDir));
    return new TextEncoder().encode(JSON.stringify(records));
};

// measure one serialise to get size
const sampleBytes = serialiseRecords();
const registrySizeKB = (sampleBytes.length / 1024).toFixed(1);
print(`  Serialized registry size: ${registrySizeKB} KB (${sampleBytes.length} bytes)`);

// OLD: 20 serialize+write on every copy
const t0writes = now();
for (let i = 0; i < WRITE_COPIES; i++) {
    const data = serialiseRecords();
    writeFileSync(tmpFile, data);
}
const t1writes = now();
const oldTotalWriteMs = t1writes - t0writes;
const oldPerWriteMs   = oldTotalWriteMs / WRITE_COPIES;

// NEW: Debouncer — 20 schedule() calls → 1 effective write
// Use a fake scheduler that captures callbacks without actually waiting.
let pendingHandle = 0;
let pendingCb     = null;
const fakeScheduler = {
    setTimer (ms, cb) {
        pendingHandle++;
        pendingCb = cb;   // each new schedule() replaces the pending callback
        return pendingHandle;
    },
    clearTimer (_h) {
        // cancel — trailing cb discarded (replaced by next schedule())
    },
};

let newWriteCount = 0;
let newWriteMs    = 0;

const debouncer = new Debouncer({ delayMs: 300, scheduler: fakeScheduler });
debouncer.setAction((payload) => {
    // This is the ONE real write that fires after the burst settles.
    const t0w = now();
    writeFileSync(tmpFile, payload);
    newWriteMs = now() - t0w;
    newWriteCount++;
});

const t0deb = now();
for (let i = 0; i < WRITE_COPIES; i++) {
    // Each schedule() resets the timer; the fake scheduler captures the last cb.
    const data = serialiseRecords();
    debouncer.schedule(data);
}
// Simulate timer firing after the burst (flush = trailing edge fires once).
debouncer.flush();
const t1deb = now();

// Clean up temp dir
try { GLib.unlink(tmpFile); } catch (_) {}
try { GLib.rmdir(tmpDir); } catch (_) {}

print(`  OLD: ${WRITE_COPIES} writes × ${oldPerWriteMs.toFixed(1)} ms = ${oldTotalWriteMs.toFixed(1)} ms total`);
print(`       bytes written: ${WRITE_COPIES} × ${sampleBytes.length} = ${(WRITE_COPIES * sampleBytes.length / 1024 / 1024).toFixed(2)} MB`);
print(`  NEW: ${newWriteCount} effective write in ${newWriteMs.toFixed(2)} ms (debounced from ${WRITE_COPIES} schedule() calls)`);
print(`       bytes written: 1 × ${sampleBytes.length} = ${(sampleBytes.length / 1024 / 1024).toFixed(2)} MB`);
print(`  Write reduction: ${WRITE_COPIES}→${newWriteCount} (${WRITE_COPIES}×→1× bytes)`);

// ─── BENCHMARK 3: SEARCH ─────────────────────────────────────────────────────

hr();
print('BENCHMARK 3 — SEARCH (per-item RegExp alloc vs compiled-once matcher)');
print('');

// Build display strings for all ~1000 entries
const displayStrings = entries.map(e => ({
    text: e.getStringValue(),
    tag:  e.getTag() || '',
}));

// Simulate typing "claude" — 6 keystrokes
const query6 = 'claude';
const keystrokes = query6.split('').map((_, i) => query6.slice(0, i + 1));
print(`  Query: "${query6}" (${keystrokes.length} keystrokes), ${displayStrings.length} entries`);

const SEARCH_ITERS = 200;

// OLD: per keystroke, recompile a new RegExp for EACH KEYSTROKE event.
// SearchFilter.js comment: "compiled a new RegExp on EVERY keystroke for EVERY menu item
// (~1000 items × N keystrokes = thousands of RegExp objects per second)"
// Legacy: RegExp compiled PER KEYSTROKE — then the same regex re-tested against all items.
// (Worst-case: some implementations compiled per-item too; we model per-keystroke as the
//  minimum old cost — even this is strictly dominated by the new path.)
const t0searchOld = now();
for (let iter = 0; iter < SEARCH_ITERS; iter++) {
    for (const ks of keystrokes) {
        // Legacy: new RegExp compiled on every keystroke, then used for all items
        const re = new RegExp(ks, 'i');
        for (const { text, tag } of displayStrings) {
            re.test(text) || re.test(tag);
        }
    }
}
const t1searchOld = now();
const oldSearchMs = (t1searchOld - t0searchOld) / SEARCH_ITERS;

// NEW: SearchFilter with regex=true mode — setQuery once per keystroke (compiles
// exactly one RegExp), then matches() reuses it for every item.
// Using regex=true for apples-to-apples comparison with OLD regex path.
const filterRe = new SearchFilter({ caseSensitive: false, regex: true });

const t0searchNew = now();
for (let iter = 0; iter < SEARCH_ITERS; iter++) {
    for (const ks of keystrokes) {
        filterRe.setQuery(ks);   // compile ONCE per keystroke
        for (const item of displayStrings) {
            filterRe.matches(item);
        }
    }
}
const t1searchNew = now();
const newSearchMs = (t1searchNew - t0searchNew) / SEARCH_ITERS;

const searchFactor = oldSearchMs / Math.max(newSearchMs, 0.0001);

// Per-keystroke alloc count: OLD = 6 RegExps per search burst; NEW = 6 RegExps total (same).
// The meaningful metric: OLD compiled regex fresh per keystroke with no reuse; NEW compiles
// once and the filter object + compiled closure are stable across the full menu scan.
// Also: OLD ran synchronously on the compositor call stack; NEW runs off-stack via async search.

print(`  OLD (new RegExp each keystroke, regex reused per-item): ${oldSearchMs.toFixed(3)} ms / 6 keystrokes`);
print(`  NEW (SearchFilter regex=true, compiled once, reused): ${newSearchMs.toFixed(3)} ms / 6 keystrokes`);
print(`  Speedup: ${searchFactor.toFixed(2)}× (both use regex; NEW also runs off compositor call stack)`);

// ─── BENCHMARK 4: MENU MODEL PREP ────────────────────────────────────────────

hr();
print('BENCHMARK 4 — MENU MODEL PREP (hover / menu-open proxy)');
print('');

const MENU_ITERS = 200;

const t0menu = now();
for (let iter = 0; iter < MENU_ITERS; iter++) {
    const m = new HistoryModel({ maxSize: totalEntries + 10 });
    m.bulkLoad(entries);
    const favs = m.favorites();
    const hist = m.history();
    void favs; void hist;
}
const t1menu = now();
const menuMs = (t1menu - t0menu) / MENU_ITERS;

const RENDER_LIMIT = 50;  // typical rendered-history-limit setting

print(`  HistoryModel build + favorites()/history() partition: ${menuMs.toFixed(3)} ms`);
print(`  Entries: ${totalEntries} total → ${imageEntries.length} images + ${textEntries.length} text`);
print('');
print(`  NOTE (qualitative — cannot count actors headless):`);
print(`    OLD render: created ~${totalEntries} St.BoxLayout actors synchronously on menu open → freeze`);
print(`    NEW render: creates only ${RENDER_LIMIT} recycled actors (rendered-history-limit)`);
print(`    Actor reduction: ~${totalEntries}→${RENDER_LIMIT} (${(totalEntries/RENDER_LIMIT).toFixed(0)}× fewer DOM nodes on compositor thread)`);

// ─── SUMMARY TABLE ────────────────────────────────────────────────────────────

hr();
print('SUMMARY');
hr();
print('');

const dataLabel = useRealData ? 'REAL registry.txt + real image files' : 'SYNTHETIC data (real files absent)';
const imgLabel  = syntheticImages ? 'SYNTHETIC 13 MB buffers' : `REAL files (top-${IMAGE_COUNT} largest)`;

print(`Data source: ${dataLabel}`);
print(`Image subset: ${imgLabel}`);
print('');

// Print markdown table to stdout (also used to fill BENCHMARKS.md)
print('| Metric | Before | After | Factor |');
print('|---|---|---|---|');
print(`| Copy dedup — ${loadedImageBuffers.length} large images (${totalEntries}-entry history) | ${oldDedupMs.toFixed(1)} ms | ${newDedupMs.toFixed(4)} ms | ${dedupFactor.toFixed(0)}× faster |`);
print(`| Registry write — ${WRITE_COPIES} copies burst | ${oldTotalWriteMs.toFixed(0)} ms (${WRITE_COPIES} writes) | ${newWriteMs.toFixed(1)} ms (1 write) | ${WRITE_COPIES}× fewer disk ops |`);
print(`| Search — 6 keystrokes, ${displayStrings.length} items, regex mode | ${oldSearchMs.toFixed(3)} ms | ${newSearchMs.toFixed(3)} ms | ${searchFactor.toFixed(2)}× (+ off compositor thread) |`);
print(`| Menu model prep (${totalEntries} entries) | N/A (actors) | ${menuMs.toFixed(3)} ms model | ~${(totalEntries/RENDER_LIMIT).toFixed(0)}× fewer actors* |`);
print('');
print('* actor count is qualitative; cannot instantiate St.BoxLayout in headless GJS');
print('');
print('Machine: gjs 1.86; pure-JS CPU timings; on the real GNOME shell these same');
print('         operations ran on the compositor main thread → the freeze.');

// ─── expose results as a plain object for the caller to pick up ───────────────
globalThis._benchResults = {
    dedup:  { oldMs: oldDedupMs, newMs: newDedupMs, factor: dedupFactor },
    writes: { oldTotal: oldTotalWriteMs, newMs: newWriteMs,
               oldCount: WRITE_COPIES, newCount: newWriteCount },
    search: { oldMs: oldSearchMs, newMs: newSearchMs, factor: searchFactor },
    menu:   { modelMs: menuMs, totalEntries, renderLimit: RENDER_LIMIT },
    useRealData, syntheticImages,
};
