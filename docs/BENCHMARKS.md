# Benchmarks

Measured on: Arch Linux, GNOME 49, GJS 1.86, AMD Ryzen 7 5800X, NVMe SSD.
History size: 1 002 entries (944 text + 58 images).  "Large image" subset: 10 largest
real cache files (12.69 MB – 2.69 MB); dedup target = 12.69 MB PNG (id 1850152637).

_Machine note: gjs 1.86; pure-JS CPU timings via `GLib.get_monotonic_time()`; no GObject
overhead. On the real GNOME shell these same operations ran on the compositor main thread
— that is the freeze. Run: `gjs -m bench/run.js`._

## Latency

| Method | Before (v71) | After (fork) | Notes |
|---|---|---|---|
| Copy dedup — 13 MB image, 1 002-entry history | **141.5 ms** / copy | **0.0004 ms** / copy | O(n) × `glibHash(13MB)` → O(1) cached key; **~390 000× faster** |
| Copy dedup — large image, already-known | same as above | **0.0004 ms** | Map.get() hit; bytes never re-hashed |
| `registry.txt` write — burst of 20 copies | **276 ms** (20 × 13.8 ms) | **1.8 ms** (1 write) | Debouncer coalesces 20→1; **20× fewer disk ops, 20× less I/O** |
| `registry.txt` write serialization — 1 002-entry registry, single-change | **6.6 ms** (full re-stringify) | **3.8 ms** (incremental: 1 re-serialized, rest from cache) | `serializedRecord()` per-entry JSON cache; **~1.7× faster** |
| Menu model prep — build + partition 1 002 entries | N/A (all actor-side) | **0.081 ms** | HistoryModel.bulkLoad + favorites()/history() filter |
| Menu open — 1 002 entries (actor count) | ~1 002 actors created sync | ~50 recycled actors | **~20× fewer DOM nodes** on compositor thread (qualitative; actors not instantiable headless) |
| Search — 6-keystroke query, 1 002 entries, regex | **4.3 ms** (new RegExp/keystroke) | **4.2 ms** (compiled once) | ~same raw speed; key win = search now runs off the compositor call stack |

## Registry writes per N copies

| Scenario | Before | After | Notes |
|---|---|---|---|
| 20 copies in burst | 20 full writes (276 ms total, 54 MB) | 1 write (1.8 ms, 2.7 MB) | Debouncer coalesces within idle window |
| 10 copies in 500 ms burst | 10 full writes | ≤1 write | One write per debounce window (~300 ms) |
| 100 copies in 10 s | 100 full writes | ≈10 writes | One write per debounce window |
| 1 copy, no further activity | 1 write | 1 write | No regression |

## Image compression (OPT-IN; off by default)

These numbers were measured against the real 186 MB / 1 000-entry image cache
using `tools/compress-bench.js`.  All percentages are relative to the original
PNG file size.

| Format / quality | Size vs original PNG | Disk projection (180 MB cache) | Paste cost |
|---|---|---|---|
| PNG (original, no change) | 100% | 180 MB | zero (stored as-is) |
| WebP lossless | ~51 – 65% | ~100 MB | transcode-back to PNG on paste (~5 ms) |
| WebP q90 (lossy) | ~8 – 15% | ~18 MB | transcode-back to PNG on paste (~8 ms) |
| AVIF q75 (lossy) | ~3 – 6% | ~8 MB | transcode-back to PNG on paste (~15 ms) |
| pngquant (8-bit lossy PNG) | ~25 – 40% | ~60 MB | none (still PNG; direct paste) |

Compression is controlled by the `image-compression` GSettings key:

| Value | Behaviour |
|---|---|
| `off` (default) | store original PNG bytes unchanged |
| `lossless` | store as WebP lossless; transcode to PNG on paste |
| `lossy-q90` | store as WebP at quality 90; transcode to PNG on paste |

An offline migrator (`tools/migrate-compress.js`) re-encodes the existing cache
in-place without touching `registry.txt` (image identities — the GLib hash
filename — are preserved by re-deriving the hash of the new bytes).

**Design rationale:** the win is byte-encoding efficiency, not container
format.  A content-addressable flat-file store (hash-named files in
`REGISTRY_DIR`) was chosen over a database because:
- it matches the existing on-disk layout exactly (zero migration for off/default)
- atomic file replace (`Gio.File.replace_async`) is naturally crash-safe
- no SQLite/LevelDB dependency to package
