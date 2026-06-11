# Data Safety

## Compatibility guarantees

| Property | Value | Why it matters |
|---|---|---|
| Extension UUID | `clipboard-indicator@tudmotu.com` (unchanged) | GNOME identifies extensions by UUID; same UUID = same GSettings schema, same dconf path, same everything |
| Cache directory | `$XDG_CACHE_HOME/clipboard-indicator@tudmotu.com` (unchanged) | All existing image files and `registry.txt` are read as-is on first start |
| `registry.txt` format | Byte-compatible JSON array (same key order: `favorite`, `mimetype`, `contents`, optional `tag`) | The fork reads and writes the exact same format; downgrading to upstream restores full compatibility |
| Image filename scheme | `glibHash(bytes)` decimal string (unchanged) | Existing cache files are recognised without any migration |

## Pre-install backup

Before enabling the fork for the first time the installer (Makefile / AUR
PKGBUILD) copies the current registry to a timestamped backup:

```
$XDG_CACHE_HOME/clipboard-indicator@tudmotu.com/registry.txt
  → …/registry.txt.bak-<ISO8601-date>
```

The backup is a plain JSON file; it can be inspected, restored, or deleted by
the user at any time.

## Image compression: what changes on disk

Image compression is **OPT-IN** and **off by default**.  When compression is
disabled (the default), no image file is ever re-encoded: bytes written to and
read from disk are identical to upstream.

When compression is enabled (`lossless` or `lossy-q90`):

1. On a **new capture**, the freshly decoded PNG bytes are transcoded to WebP
   before being written to disk.  The file is named after
   `glibHash(webp_bytes)` — a new hash, different from the old PNG hash.
2. `registry.txt` is **never modified** to store the new filename.  Instead the
   in-memory `ClipboardEntry` carries the new id, and `toRegistryRecord()`
   writes the new filename.  If the user downgrades before the next registry
   write the old PNG file (if still present) continues to work.
3. On **paste**, the WebP file is transcoded back to PNG in memory before being
   set on the `St.Clipboard`.  The application receiving the paste sees a
   standard PNG byte stream; it has no knowledge of the intermediate WebP
   encoding.
4. The **offline migrator** (`tools/migrate-compress.js`) re-encodes the
   existing cache in-place.  It writes the new-format file, verifies it, then
   removes the old file.  It operates entry-by-entry so a crash leaves at most
   one entry in a partially-migrated state, which the extension handles
   gracefully (falls back to reading the old file if the new one is absent).

## Rollback procedure

1. Disable the fork: `gnome-extensions disable clipboard-indicator@tudmotu.com`
2. Restore the backup:
   ```bash
   cp ~/.cache/clipboard-indicator@tudmotu.com/registry.txt.bak-<date> \
      ~/.cache/clipboard-indicator@tudmotu.com/registry.txt
   ```
3. Reinstall the official upstream package from GNOME Extensions or your
   distro's package manager.
4. Re-enable: `gnome-extensions enable clipboard-indicator@tudmotu.com`

Because the UUID and cache directory are unchanged, the restored `registry.txt`
is immediately visible to the upstream extension with no further steps.

## What this fork does NOT change

- GSettings schema keys and default values
- `metadata.json` version field (bumped only, not renamed)
- All user-facing features, keyboard shortcuts, and preferences UI
- Any file outside `$XDG_CACHE_HOME/clipboard-indicator@tudmotu.com`
