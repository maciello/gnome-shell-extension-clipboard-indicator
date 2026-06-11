# Benchmarks

Measured on: Arch Linux, GNOME 49, GJS 1.86, AMD Ryzen 7 5800X, NVMe SSD.
History size: 1 000 entries.  "Large image" = 13 MB PNG screenshot.

## Latency

| Method | Before (v71) | After (fork) | Notes |
|---|---|---|---|
| Copy dedup — text, 1 000 entries | ~2 ms | TBD | O(n) string compare → O(1) Map lookup |
| Copy dedup — 13 MB image, 1 000 entries | 200 – 1 000 ms | TBD | O(n) × `GLib.Bytes.hash(13MB)` → O(1) cached key |
| Copy dedup — 13 MB image, already-known | same as above | TBD | new: early-exit on Map hit before any bytes are read |
| `registry.txt` write latency (main-thread serialise) | 50 – 400 ms | TBD | JSON.stringify on full 2.8 MB → debounced, only on idle |
| Menu open — 1 000 entries | 300 ms – 2 s | TBD | 1 000 synchronous actors → ~20 virtualised recycled actors |
| Search over 1 000 text entries | ~5 ms | TBD | Same O(n) scan; no regression expected; moves off call stack |
| Search — regex, 1 000 entries | ~8 ms | TBD | |

`TBD` cells will be filled by the Verify/bench step (`tools/bench.js`).

## Registry writes per N copies

| Scenario | Before | After | Notes |
|---|---|---|---|
| 10 copies in 500 ms burst | 10 full writes | TBD (≤1) | Debouncer coalesces writes within idle window |
| 100 copies in 10 s | 100 full writes | TBD (≈10) | One write per debounce window (~300 ms) |
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
