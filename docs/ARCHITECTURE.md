# Architecture — Clipboard Indicator fork (maciello)

## Problem: why the original freezes

The upstream extension runs every hot path synchronously on the GNOME Shell
compositor main loop (Clutter's GLib event loop).  Three operations compound
into perceptible freezes of 200 ms – 2 s:

| Root cause | Mechanism | Measured impact |
|---|---|---|
| O(n) image dedup | `getStringValue()` calls `GLib.Bytes.new(this.#bytes).hash()` on every `equals()` check; with 1 000 history entries and a 13 MB screenshot this is **13 GB** of hashed bytes per copy | 200 ms – 1 s per copy |
| Full registry rewrite | `writeToFile()` serialises all entries → `JSON.stringify` → writes the full 2.8 MB `registry.txt` on **every** copy, synchronously via an async fire-and-forget that still blocks JSON serialisation on the main thread | 50 – 400 ms per copy |
| 1 000 synchronous menu actors | `_buildMenu` → `_addEntry` loop: each entry creates ~15 GObject actors (PopupMenuItem + ~7 buttons + labels + icons) synchronously before the menu can be shown | 300 ms – 2 s on menu open |

---

## Solution: ports-and-adapters (hexagonal architecture)

All domain logic lives in pure JS modules with **no gi imports**.  GLib/Gio/St
touch only thin adapters at the edges.  This makes each layer independently
testable and prevents gi calls from sneaking back into hot paths.

```
┌─────────────────────────────────────────────────────────────────┐
│  composition root  (extension.js)                               │
│  wires ports to adapters, holds GNOME lifecycle (enable/disable)│
└───────┬─────────────────────────────────────────────────────────┘
        │ owns
        ▼
┌───────────────────────────┐      ┌──────────────────────────────┐
│  ui/  (St/Clutter)        │      │  adapters/  (gi only)        │
│  ClipboardMenu            │      │  RegistryAdapter  (Gio/GLib) │
│  HistoryMenuSection       │      │  ClipboardAdapter (St)       │
│  SearchBar                │      │  ImageCacheAdapter (Gio)     │
└───────┬───────────────────┘      └───────────┬──────────────────┘
        │ calls ports                           │ implements ports
        ▼                                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  ports/  (plain JS interfaces — just JSDoc shapes)              │
│  IHistoryModel   IRegistryStore   IClipboardRead/Write          │
│  IImageCache     ISearchFilter                                  │
└───────┬─────────────────────────────────────────────────────────┘
        │ implemented by core
        ▼
┌─────────────────────────────────────────────────────────────────┐
│  core/  (pure JS — zero gi imports)                             │
│  ClipboardEntry   hash   HistoryModel   SearchFilter            │
│  Debouncer        CacheGC                                       │
└─────────────────────────────────────────────────────────────────┘
```

---

## Module map

### core/ — pure, headless, testable under plain `gjs -m`

| Module | Responsibility | Freeze fix |
|---|---|---|
| `hash.js` | `glibHash(u8)→uint32`, `glibHashString(u8)→string`. Reproduces GLib's `g_bytes_hash` in pure JS so image identity is computable without allocating `GLib.Bytes`. | Eliminates the gi allocation in the dedup hot path |
| `ClipboardEntry.js` | Immutable value object. Text key = the text string. Image key = `glibHash` computed **once** at construction (or taken from the on-disk filename). `equals()` and `key()` are O(1) string comparisons — bytes are **never re-hashed**. Also owns `toRegistryRecord`/`fromRegistryRecord` as pure transforms. | O(n) re-hash → O(1) key compare |
| `HistoryModel.js` _(planned)_ | Ordered ring-buffer (max N non-favourite entries). `add(entry)` deduplicates via a `Map<key,entry>` in O(1). Fires change events consumed by the UI. | O(n) linear scan → O(1) Map lookup |
| `SearchFilter.js` _(planned)_ | Stateless `filter(entries, query, opts)` → indices. Pure JS substring/regex match. Runs off-main-thread via a microtask if needed. | |
| `Debouncer.js` _(planned)_ | `debounce(fn, ms)` — coalesces rapid writes into one deferred call. Used to gate registry writes. | N writes per N copies → 1 write per idle window |
| `CacheGC.js` _(planned)_ | Walks the image cache directory and removes files whose hash is no longer referenced by the current history. Runs asynchronously on a low-priority idle. | |

### ports/ — plain JSDoc interfaces (no runtime code)

Describe the contracts between core and adapters so either side can be swapped
or mocked in tests.

| Port | Description |
|---|---|
| `IHistoryModel` | `add`, `remove`, `setFavorite`, `entries`, `onChange` |
| `IRegistryStore` | `read() → Promise<ClipboardEntry[]>`, `write(entries) → void` (debounced) |
| `IClipboardRead` | `read(type) → Promise<ClipboardEntry\|null>` |
| `IClipboardWrite` | `write(entry) → void` |
| `IImageCache` | `readFile(id) → Promise<Uint8Array>`, `writeFile(id, bytes)`, `deleteFile(id)` |
| `ISearchFilter` | `filter(entries, query, opts) → ClipboardEntry[]` |

### adapters/ — thin gi wrappers, never contain business logic

| Adapter | gi surface | Notes |
|---|---|---|
| `RegistryAdapter` | `Gio.File`, `GLib` | Implements `IRegistryStore`. Calls `Debouncer` so writes fire at most once per idle window. Uses `Gio.File.replace_async` + `write_bytes_async`. |
| `ClipboardAdapter` | `St.Clipboard` | Implements `IClipboardRead` / `IClipboardWrite`. |
| `ImageCacheAdapter` | `Gio.File`, `GLib` | Implements `IImageCache`. Async read/write. Optionally transcodes PNG→WebP on write (OPT-IN). |

### ui/ — St/Clutter only, no domain logic

| Component | Description |
|---|---|
| `ClipboardMenu` | `PanelMenu.Button` subclass. Composition root for the popup. |
| `HistoryMenuSection` | **Virtualised** list: only creates actor objects for the ~20 visible rows; recycles actors on scroll. Eliminates the 1 000-actor build cost. |
| `SearchBar` | Thin wrapper around `St.Entry`; calls `ISearchFilter` on text-change. |
| `ImagePreview` | Lazy-load overlay; reads bytes via `IImageCache`. |

### composition root — extension.js

`enable()` wires adapters to ports and passes the result to the UI.  `disable()`
tears everything down.  No business logic lives here.

---

## Data-flow: on copy

```
[X11/Wayland clipboard]
        │  owner-changed signal
        ▼
ClipboardAdapter.read()          ← async, off main-loop wait
        │  ClipboardEntry (key computed once, O(1) from here on)
        ▼
HistoryModel.add(entry)
  ├─ Map.has(key)?  → already present, update selection, DONE  O(1)
  └─ new entry
       ├─ ring-buffer prepend, evict oldest if > maxSize
       └─ emit 'changed'
              │
              ├─► Debouncer → (wait idle ms) → RegistryAdapter.write()
              │     └─ JSON.stringify only the delta keys changed
              │        Gio.File.replace_async (non-blocking)
              │
              └─► HistoryMenuSection.onModelChanged()
                    └─ prepend ONE recycled actor row (not 1000)
```

## Data-flow: on menu-open

```
user clicks panel button
        │
        ▼
ClipboardMenu.open()
        │
        ▼
HistoryMenuSection.render(visibleRange)   ← virtualised
  ├─ determine viewport rows (~20)
  ├─ for each visible entry: bind data to recycled actor (no allocation)
  └─ ScrollView.connect('scroll') → re-bind on scroll  (idle, non-blocking)
```

---

## Testability

```
gjs -m tests/run.js
```

- `tests/harness.js` — zero gi, plain ESM, runs in any GJS or Deno.
- `tests/core/` — unit tests for `hash`, `ClipboardEntry`, `HistoryModel`,
  `SearchFilter`, `Debouncer`.  All pure JS, no live shell needed.
- `tests/adapters/` — integration tests for `RegistryAdapter` and
  `ImageCacheAdapter`.  May import `gi://GLib` and `gi://Gio` (available under
  plain `gjs`) but must NOT import `gi://St`, `gi://Clutter`, `gi://Meta`, or
  any `resource:///org/gnome/shell/` path (only available inside the live shell).

Pure core tests run in CI without a compositor.  Adapter tests run on any
machine with GJS installed.  UI tests require a live GNOME session and are
manual / screenshot-based.
