/**
 * bench/serial-bench.js — targeted benchmark for registry-write serialization
 * Measures OLD (full JSON.stringify) vs NEW (incremental serializedRecord cache)
 * Run: gjs -m bench/serial-bench.js
 */
import GLib from 'gi://GLib';
import { ClipboardEntry } from '../src/core/ClipboardEntry.js';

function now() { return GLib.get_monotonic_time() / 1000; }

const CACHE_DIR = GLib.get_home_dir() + '/.cache/clipboard-indicator@tudmotu.com';
const REGISTRY_PATH = CACHE_DIR + '/registry.txt';

const [ok, raw] = GLib.file_get_contents(REGISTRY_PATH);
const records = JSON.parse(new TextDecoder().decode(raw));
const entries = records.map(r => ClipboardEntry.fromRegistryRecord(r));
print(`Loaded ${entries.length} entries`);

const dir = CACHE_DIR;
const ITERS = 300;

// --- warm up ---
for (let i = 0; i < 5; i++) JSON.stringify(entries.map(e => e.toRegistryRecord(dir)));

// OLD: full re-stringify every write
const t0old = now();
for (let i = 0; i < ITERS; i++) {
    JSON.stringify(entries.map(e => e.toRegistryRecord(dir)));
}
const t1old = now();
const oldMs = (t1old - t0old) / ITERS;

// Seed serializedRecord cache (first call per entry fills it)
'[' + entries.map(e => e.serializedRecord(dir)).join(',') + ']';

// Simulate single-change writes: mutate ONE entry each iteration (cache partially warm)
const t0new = now();
for (let i = 0; i < ITERS; i++) {
    entries[0].setTag(i % 2 === 0 ? 'bench' : null); // invalidates cache for entry[0] only
    '[' + entries.map(e => e.serializedRecord(dir)).join(',') + ']';
}
const t1new = now();
const newMs = (t1new - t0new) / ITERS;

print(`OLD full-stringify:  ${oldMs.toFixed(3)} ms`);
print(`NEW incremental:     ${newMs.toFixed(3)} ms`);
print(`Factor:              ${(oldMs/newMs).toFixed(1)}x faster`);
