# migrate-images.js — Image Cache Compressor

Offline tool that converts the clipboard-indicator image cache from PNG to WebP,
reducing typical cache sizes by 35–92% while preserving full compatibility with
the running extension.

## How It Works

The extension names cache files after `GLib.Bytes.hash()` of the **original** bytes.
This tool stores compressed (WebP) bytes **under the same filename** — registry.txt
never changes. On paste the live extension reads the file and sends it to the
clipboard; since the clipboard accepts webp/png alike (via GdkPixbuf), no code
change is needed in the extension itself.

## Prerequisites

- `gjs` ≥ 1.76 (ES modules + top-level await)
- ImageMagick 7+ (`magick` in PATH, with libwebp support)

```
# Arch / Manjaro
sudo pacman -S imagemagick

# Debian / Ubuntu
sudo apt install imagemagick
```

## Usage

```bash
# 1. Make a backup first (required unless --force)
cp ~/.cache/clipboard-indicator@tudmotu.com/registry.txt \
   ~/.cache/clipboard-indicator@tudmotu.com/registry.txt.backup

# 2. Dry-run: see projected savings without touching anything
gjs -m tools/migrate-images.js --dry-run

# 3. Convert (lossless WebP — visually identical, ~35-65% of PNG)
gjs -m tools/migrate-images.js

# 4. Convert with lossy q90 WebP (~8-15% of PNG, barely perceptible)
gjs -m tools/migrate-images.js --lossy

# 5. Override cache directory
gjs -m tools/migrate-images.js --cache /path/to/other/cache

# 6. Skip backup check (not recommended)
gjs -m tools/migrate-images.js --force
```

Run from the worktree root directory.

## Options

| Flag | Description |
|------|-------------|
| `--lossy` | WebP quality=90 (lossy). Default: lossless. |
| `--dry-run` | Analyse only; nothing is written. |
| `--cache DIR` | Use this directory instead of the default. |
| `--force` | Skip backup existence check. |
| `--help` | Print usage. |

## Safety Guarantees

1. **Backup check**: refuses to run unless `registry.txt.backup` exists next to
   `registry.txt`, or `--force` is given. If missing, prints the `cp` command to run.

2. **Verify before replace**: after encoding each file, the tool
   - decodes the WebP back to PNG (round-trip),
   - checks pixel dimensions match the original via `magick identify`,
   - only then atomically overwrites the original (temp-file + rename).
   If any step fails the original is untouched and the error is reported.

3. **No size regression**: if the encoded file is not smaller than the original
   it is skipped entirely.

4. **Already-WebP files**: skipped (idempotent).

5. **Bookkeeping files** (`registry.txt`, `registry.txt~`, `registry.txt.backup`):
   always skipped regardless of content.

## Expected Output

```
Cache directory : /home/user/.cache/clipboard-indicator@tudmotu.com
Mode            : lossless WebP
Dry-run         : no

  OK    1234567890  png    1.23 MB → 643.0 KB  (-49.1%)
  OK    9876543210  png    3.10 MB → 1.58 MB   (-49.0%)
  SKIP  abcdef1234  (WebP not smaller: 4096 → 4200)

═══════════════════════════════════════════════════════
MIGRATION SUMMARY
═══════════════════════════════════════════════════════
  Converted       : 2
  Skipped (WebP)  : 0
  Skipped (other) : 1
  Errors          : 0
  Before          : 4.33 MB
  After           : 2.22 MB
  Saved           : 2.11 MB  (-48.7%)
═══════════════════════════════════════════════════════
```

## Reverting

Because `registry.txt` is never modified you can revert by restoring the original
PNG files from a filesystem backup. The extension will silently continue using
any file it finds under the hashed filename regardless of the actual encoding.
