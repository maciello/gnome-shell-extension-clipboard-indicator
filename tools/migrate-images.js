#!/usr/bin/env -S gjs -m
/* migrate-images.js — Offline image-cache compressor for clipboard-indicator.
 *
 * Converts existing PNG cache files to WebP (lossless by default) using
 * ImageMagick, in-place (same filename → identity + registry.txt preserved).
 *
 * Usage:
 *   gjs -m tools/migrate-images.js [options]
 *
 * Options:
 *   --lossy            Use WebP q90 instead of lossless (8-15% of PNG)
 *   --dry-run          Analyse only; never write any files
 *   --cache DIR        Override cache directory
 *   --force            Skip backup-existence check
 *   --help             Print this help
 *
 * Safety contract:
 *   - NEVER deletes or overwrites a file unless a replacement has been
 *     successfully verified (dimensions match + decodeToPng succeeds).
 *   - REFUSES to run unless a backup of registry.txt exists OR --force given.
 *   - Uses atomic rename (Gio.File.move with OVERWRITE) for final replacement.
 *   - Already-WebP files are skipped.
 */

import GLib  from 'gi://GLib';
import Gio   from 'gi://Gio';

// ---------------------------------------------------------------------------
// Resolve adapter relative to this script's location.
// When run as `gjs -m tools/migrate-images.js` the import.meta.url is a
// file:// URL pointing at the script; we strip to get the worktree root.
// ---------------------------------------------------------------------------
const scriptUrl  = import.meta.url;                       // file:///…/tools/migrate-images.js
const scriptDir  = GLib.path_get_dirname(
    GLib.filename_from_uri(scriptUrl, null)[0]            // /…/tools
);
const worktreeRoot = GLib.path_get_dirname(scriptDir);    // /…/clipboard-build

// Dynamic import so paths resolve correctly regardless of cwd.
const { MagickImageCodec } = await import(
    `file://${worktreeRoot}/src/adapters/MagickImageCodec.js`
);

// ---------------------------------------------------------------------------
// Tiny arg parser
// ---------------------------------------------------------------------------

function parseArgs (args) {
    const opts = {
        lossy:   false,
        dryRun:  false,
        cacheDir: null,
        force:   false,
        help:    false,
    };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--lossy')    { opts.lossy   = true; continue; }
        if (a === '--dry-run')  { opts.dryRun  = true; continue; }
        if (a === '--force')    { opts.force   = true; continue; }
        if (a === '--help')     { opts.help    = true; continue; }
        if (a === '--cache') {
            opts.cacheDir = args[++i] || null;
            continue;
        }
        // positional / unknown
        print(`WARNING: unknown argument '${a}' — ignored`);
    }
    return opts;
}

// ---------------------------------------------------------------------------
// Gio async helpers
// ---------------------------------------------------------------------------

/** List filenames (not paths) inside a directory, skipping sub-directories. */
function listDir (dirPath) {
    return new Promise((resolve, reject) => {
        const dir = Gio.file_new_for_path(dirPath);
        dir.enumerate_children_async(
            'standard::name,standard::type,standard::size',
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            null,
            (src, res) => {
                let enumerator;
                try {
                    enumerator = src.enumerate_children_finish(res);
                } catch (e) {
                    reject(e);
                    return;
                }
                const files = [];
                // Synchronous iteration on an already-opened enumerator is fine;
                // the blocking I/O was the initial enumerate_children_async call.
                let info;
                while ((info = enumerator.next_file(null)) !== null) {
                    if (info.get_file_type() !== Gio.FileType.REGULAR) continue;
                    files.push({
                        name: info.get_name(),
                        size: info.get_size(),
                    });
                }
                enumerator.close(null);
                resolve(files);
            }
        );
    });
}

/** Read a file as Uint8Array. */
function readFile (path) {
    return new Promise((resolve, reject) => {
        const f = Gio.file_new_for_path(path);
        f.load_contents_async(null, (src, res) => {
            try {
                const [, contents] = src.load_contents_finish(res);
                resolve(new Uint8Array(contents));
            } catch (e) {
                reject(e);
            }
        });
    });
}

/** Write bytes to a path atomically (temp file + rename). */
function writeFile (path, bytesU8) {
    return new Promise((resolve, reject) => {
        const tmpPath = path + '.migrating~';
        const tmpFile = Gio.file_new_for_path(tmpPath);

        tmpFile.replace_async(
            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION,
            GLib.PRIORITY_DEFAULT, null,
            (src, res) => {
                let stream;
                try {
                    stream = src.replace_finish(res);
                } catch (e) {
                    reject(e);
                    return;
                }
                const gBytes = GLib.Bytes.new(bytesU8);
                stream.write_bytes_async(
                    gBytes, GLib.PRIORITY_DEFAULT, null,
                    (ws, wr) => {
                        try {
                            ws.write_bytes_finish(wr);
                        } catch (e) {
                            stream.close(null);
                            reject(e);
                            return;
                        }
                        stream.close(null);
                        // Atomic rename: move temp over original.
                        const destFile = Gio.file_new_for_path(path);
                        tmpFile.move(
                            destFile,
                            Gio.FileCopyFlags.OVERWRITE,
                            null, null
                        );
                        resolve();
                    }
                );
            }
        );
    });
}

/** Spawn `magick identify -format "%wx%h" -` to get "WIDTHxHEIGHT". */
function getDimensions (bytesU8) {
    return new Promise((resolve, reject) => {
        const magickPath = GLib.find_program_in_path('magick');
        if (!magickPath) { resolve(null); return; }

        let proc;
        try {
            proc = new Gio.Subprocess({
                argv: [magickPath, 'identify', '-format', '%wx%h', '-'],
                flags:
                    Gio.SubprocessFlags.STDIN_PIPE |
                    Gio.SubprocessFlags.STDOUT_PIPE |
                    Gio.SubprocessFlags.STDERR_PIPE,
            });
            proc.init(null);
        } catch (e) {
            resolve(null);
            return;
        }

        const stdinBytes = GLib.Bytes.new(bytesU8);
        proc.communicate_async(stdinBytes, null, (src, res) => {
            try {
                const [, stdout] = src.communicate_finish(res);
                if (proc.get_exit_status() !== 0) { resolve(null); return; }
                const out = new TextDecoder().decode(new Uint8Array(stdout.get_data())).trim();
                // out is "WxH" or "WxH\nWxH" for multi-frame; take first
                resolve(out.split('\n')[0].trim() || null);
            } catch {
                resolve(null);
            }
        });
    });
}

// ---------------------------------------------------------------------------
// Bookkeeping-file filter (mirrors CacheGC logic)
// ---------------------------------------------------------------------------

const BOOKKEEPING_RE = /^registry\.txt(~|\.backup)?$/;
function isBookkeeping (name) {
    return BOOKKEEPING_RE.test(name);
}

// ---------------------------------------------------------------------------
// Main migration logic
// ---------------------------------------------------------------------------

async function main () {
    // gjs passes script args starting at ARGV[0]
    const rawArgs = typeof ARGV !== 'undefined' ? ARGV : [];
    const opts = parseArgs(rawArgs);

    if (opts.help) {
        print([
            'Usage: gjs -m tools/migrate-images.js [options]',
            '',
            'Options:',
            '  --lossy           WebP q90 (lossy). Default: lossless WebP.',
            '  --dry-run         Analyse only, make no changes.',
            '  --cache DIR       Override cache directory.',
            '  --force           Skip backup-existence requirement.',
            '  --help            Show this message.',
            '',
            'The tool compresses PNG clipboard-indicator image cache files to WebP',
            'in-place, preserving filenames so registry.txt stays valid.',
        ].join('\n'));
        return;
    }

    const cacheDir = opts.cacheDir ||
        (GLib.get_user_cache_dir() + '/clipboard-indicator@tudmotu.com');

    print(`Cache directory : ${cacheDir}`);
    print(`Mode            : ${opts.lossy ? 'lossy WebP q90' : 'lossless WebP'}`);
    print(`Dry-run         : ${opts.dryRun ? 'YES (no files will be written)' : 'no'}`);
    print('');

    // ---- Safety: require a backup unless --force --------------------------
    const backupPath = `${cacheDir}/registry.txt.backup`;
    const registryBackupExists = GLib.file_test(backupPath, GLib.FileTest.EXISTS);
    if (!registryBackupExists && !opts.force) {
        print('ERROR: No registry.txt backup found.');
        print('');
        print('Before running this migration, create a backup:');
        print(`  cp "${cacheDir}/registry.txt" "${cacheDir}/registry.txt.backup"`);
        print('');
        print('Or re-run with --force to skip this check (not recommended).');
        try {
            const { exit } = await import('system');
            exit(1);
        } catch { /* not under gjs */ }
        return;
    }

    // ---- Check magick is available ----------------------------------------
    const magickPath = GLib.find_program_in_path('magick');
    if (!magickPath) {
        print('ERROR: `magick` (ImageMagick 7+) not found in PATH.');
        print('Install with: sudo pacman -S imagemagick   (Arch/Manjaro)');
        print('              sudo apt install imagemagick  (Debian/Ubuntu)');
        try {
            const { exit } = await import('system');
            exit(1);
        } catch { /* not under gjs */ }
        return;
    }

    // ---- Check cache dir exists -------------------------------------------
    if (!GLib.file_test(cacheDir, GLib.FileTest.IS_DIR)) {
        print(`ERROR: Cache directory does not exist: ${cacheDir}`);
        try {
            const { exit } = await import('system');
            exit(1);
        } catch { /* not under gjs */ }
        return;
    }

    // ---- Enumerate files --------------------------------------------------
    let files;
    try {
        files = await listDir(cacheDir);
    } catch (e) {
        print(`ERROR: Could not list cache directory: ${e.message}`);
        try {
            const { exit } = await import('system');
            exit(1);
        } catch { /* not under gjs */ }
        return;
    }

    const codec = new MagickImageCodec();

    let processed = 0;
    let skippedAlreadyWebp = 0;
    let skippedNotImage = 0;
    let errors = 0;
    let totalBytesBefore = 0;
    let totalBytesAfter  = 0;
    const errorList = [];

    for (const { name, size } of files) {
        if (isBookkeeping(name)) continue;

        const filePath = `${cacheDir}/${name}`;

        // Read original bytes
        let original;
        try {
            original = await readFile(filePath);
        } catch (e) {
            errors++;
            errorList.push(`${name}: read error — ${e.message}`);
            continue;
        }

        const fmt = codec.sniff(original);

        if (fmt === 'webp') {
            skippedAlreadyWebp++;
            continue;
        }

        if (fmt !== 'png' && fmt !== 'jpeg' && fmt !== 'gif' && fmt !== 'avif') {
            // Not a recognised image we can usefully transcode
            skippedNotImage++;
            continue;
        }

        // -------------------------------------------------------------------
        // Encode to WebP
        // -------------------------------------------------------------------
        let encoded;
        try {
            encoded = await codec.encode(original, {
                to: 'webp',
                lossless: !opts.lossy,
                quality: 90,
            });
        } catch (e) {
            errors++;
            errorList.push(`${name}: encode failed — ${e.message}`);
            continue;
        }

        // Only bother replacing if we actually save space
        if (encoded.length >= original.length) {
            skippedNotImage++;  // reuse the "no benefit" bucket
            print(`  SKIP  ${name}  (WebP not smaller: ${original.length} → ${encoded.length})`);
            continue;
        }

        // -------------------------------------------------------------------
        // Verify: decode back to PNG and check dimensions match
        // -------------------------------------------------------------------
        let decodedBack;
        try {
            decodedBack = await codec.decodeToPng(encoded);
        } catch (e) {
            errors++;
            errorList.push(`${name}: verification decode failed — ${e.message}`);
            continue;
        }

        if (!decodedBack || decodedBack.length === 0) {
            errors++;
            errorList.push(`${name}: verification produced empty PNG`);
            continue;
        }

        // Dimension check — original vs re-decoded
        const [dimsOrig, dimsNew] = await Promise.all([
            getDimensions(original),
            getDimensions(decodedBack),
        ]);

        if (dimsOrig && dimsNew && dimsOrig !== dimsNew) {
            errors++;
            errorList.push(
                `${name}: dimension mismatch after encode (${dimsOrig} → ${dimsNew})`
            );
            continue;
        }

        // -------------------------------------------------------------------
        // Accumulate stats
        // -------------------------------------------------------------------
        const saving = original.length - encoded.length;
        const pct = ((saving / original.length) * 100).toFixed(1);
        totalBytesBefore += original.length;
        totalBytesAfter  += encoded.length;
        processed++;

        if (opts.dryRun) {
            print(`  DRY   ${name}  ${fmt.padEnd(5)}  ${fmtBytes(original.length)} → ${fmtBytes(encoded.length)}  (-${pct}%)`);
            continue;
        }

        // -------------------------------------------------------------------
        // Atomic replace
        // -------------------------------------------------------------------
        try {
            await writeFile(filePath, encoded);
            print(`  OK    ${name}  ${fmt.padEnd(5)}  ${fmtBytes(original.length)} → ${fmtBytes(encoded.length)}  (-${pct}%)`);
        } catch (e) {
            errors++;
            errorList.push(`${name}: write error — ${e.message}`);
        }
    }

    // ---- Summary -----------------------------------------------------------
    print('');
    print('═══════════════════════════════════════════════════════');
    if (opts.dryRun) print('DRY-RUN SUMMARY (no files were modified)');
    else             print('MIGRATION SUMMARY');
    print('═══════════════════════════════════════════════════════');
    print(`  Converted       : ${processed}`);
    print(`  Skipped (WebP)  : ${skippedAlreadyWebp}`);
    print(`  Skipped (other) : ${skippedNotImage}`);
    print(`  Errors          : ${errors}`);
    if (processed > 0) {
        const totalSaving = totalBytesBefore - totalBytesAfter;
        const pct = ((totalSaving / totalBytesBefore) * 100).toFixed(1);
        print(`  Before          : ${fmtBytes(totalBytesBefore)}`);
        print(`  After           : ${fmtBytes(totalBytesAfter)}`);
        print(`  Saved           : ${fmtBytes(totalSaving)}  (-${pct}%)`);
    }
    if (errorList.length > 0) {
        print('');
        print('ERRORS:');
        for (const msg of errorList) print(`  ! ${msg}`);
    }
    print('═══════════════════════════════════════════════════════');

    if (errors > 0) {
        try {
            const { exit } = await import('system');
            exit(1);
        } catch { /* not under gjs */ }
    }
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

function fmtBytes (n) {
    if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
    if (n >= 1024)        return `${(n / 1024).toFixed(1)} KB`;
    return `${n} B`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

try {
    await main();
} catch (e) {
    print(`FATAL: ${e.message}`);
    print(e.stack || '');
    try {
        const { exit } = await import('system');
        exit(2);
    } catch { /* not under gjs */ }
}
