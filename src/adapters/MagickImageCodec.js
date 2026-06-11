/* MagickImageCodec — ImageCodecPort implementation backed by ImageMagick (magick).
 *
 * All I/O is ASYNC via Gio.Subprocess.communicate_async — this adapter is safe
 * to use from the gnome-shell main loop because no synchronous file or CPU work
 * ever blocks it.  magick reads from stdin and writes to stdout; no temp files.
 *
 * Design decisions:
 *  - sniff()       pure sync magic-byte inspection, no subprocess overhead.
 *  - encode()      shells out: magick - [options] <format>:-
 *  - decodeToPng() shells out: magick - png:-
 *
 * If magick is not installed every async method rejects with a structured error
 * whose .code === 'MAGICK_NOT_FOUND' so callers can branch gracefully.
 *
 * Usage:
 *   const codec = new MagickImageCodec();
 *   const webpBytes = await codec.encode(pngBytes, { to: 'webp', lossless: true });
 *   const pngBack   = await codec.decodeToPng(webpBytes);
 */

import GLib from 'gi://GLib';
import Gio  from 'gi://Gio';

import { ImageCodecPort } from '../ports/ImageCodecPort.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wrap Gio.Subprocess.communicate_async in a Promise.
 *
 * @param {Gio.Subprocess} proc
 * @param {GLib.Bytes|null} stdinBytes  GLib.Bytes to feed into stdin, or null
 * @returns {Promise<{stdout: GLib.Bytes, stderr: GLib.Bytes}>}
 */
function communicateAsync (proc, stdinBytes) {
    return new Promise((resolve, reject) => {
        proc.communicate_async(stdinBytes, null, (source, res) => {
            try {
                const [, stdout, stderr] = source.communicate_finish(res);
                resolve({ stdout, stderr });
            } catch (e) {
                reject(e);
            }
        });
    });
}

/**
 * Try to locate the `magick` binary once (cached after first call).
 * Returns the executable path or null if not found.
 * @returns {string|null}
 */
let _magickPath = undefined; // undefined = not yet probed
function findMagick () {
    if (_magickPath !== undefined) return _magickPath;
    // GLib.find_program_in_path returns null when not found
    _magickPath = GLib.find_program_in_path('magick');
    return _magickPath;
}

/**
 * Convert a Uint8Array to GLib.Bytes.
 * @param {Uint8Array} u8
 * @returns {GLib.Bytes}
 */
function toGLibBytes (u8) {
    // GLib.Bytes.new() accepts a Uint8Array directly in modern gjs.
    return GLib.Bytes.new(u8);
}

/**
 * Convert GLib.Bytes to Uint8Array.
 * @param {GLib.Bytes} gb
 * @returns {Uint8Array}
 */
function fromGLibBytes (gb) {
    // get_data() returns a Uint8Array in gjs.
    return new Uint8Array(gb.get_data());
}

// ---------------------------------------------------------------------------
// MagickImageCodec
// ---------------------------------------------------------------------------

export class MagickImageCodec extends ImageCodecPort {

    // -----------------------------------------------------------------------
    // sniff — synchronous magic-byte detection
    // -----------------------------------------------------------------------

    /**
     * Detect image format from leading bytes only — no subprocess, no I/O.
     *
     * @param {Uint8Array} bytesU8
     * @returns {'png'|'webp'|'jpeg'|'gif'|'svg'|'avif'|'unknown'}
     */
    sniff (bytesU8) {
        if (!bytesU8 || bytesU8.length < 4) return 'unknown';

        const b = bytesU8;

        // PNG: 89 50 4E 47 0D 0A 1A 0A
        if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) {
            return 'png';
        }

        // WEBP: bytes 0-3 == "RIFF" AND bytes 8-11 == "WEBP"
        // Need at least 12 bytes.
        if (b.length >= 12 &&
            b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
            b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
            return 'webp';
        }

        // JPEG: FF D8 FF
        if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) {
            return 'jpeg';
        }

        // GIF: 47 49 46 38 ("GIF8")
        if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
            return 'gif';
        }

        // AVIF: ISO Base Media File Format box — 'ftyp' at offset 4,
        //       brand 'avif' or 'avis' at offset 8.
        // Box layout: [4 bytes size][4 bytes 'ftyp'][4 bytes major-brand]
        if (b.length >= 12 &&
            b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
            // major brand at [8..11]
            const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
            if (brand === 'avif' || brand === 'avis') return 'avif';
        }

        // SVG: text starting with '<?xml' or '<svg' (check first 256 bytes as UTF-8)
        // Use a limited prefix to avoid decoding huge buffers.
        try {
            const prefix = new TextDecoder('utf-8', { fatal: false })
                .decode(b.slice(0, Math.min(b.length, 256)))
                .trimStart();
            if (prefix.startsWith('<?xml') || prefix.startsWith('<svg')) {
                return 'svg';
            }
        } catch {
            // ignore decode errors
        }

        return 'unknown';
    }

    // -----------------------------------------------------------------------
    // encode — transcode to a target format via magick
    // -----------------------------------------------------------------------

    /**
     * Encode image bytes to a target format.
     *
     * @param {Uint8Array} bytesU8
     * @param {object}  opts
     * @param {string}  [opts.to='webp']   target format
     * @param {boolean} [opts.lossless=true] lossless encoding (webp only)
     * @param {number}  [opts.quality=90]  lossy quality 0-100
     * @returns {Promise<Uint8Array>}
     */
    async encode (bytesU8, { to = 'webp', lossless = true, quality = 90 } = {}) {
        const magick = findMagick();
        if (!magick) {
            const err = new Error(
                'MagickImageCodec: `magick` binary not found in PATH. ' +
                'Install ImageMagick 7+ to enable image compression.'
            );
            err.code = 'MAGICK_NOT_FOUND';
            return Promise.reject(err);
        }

        // Build the magick command.
        // Input format hint 'png:-' means "read PNG from stdin"; we use just '-'
        // so magick auto-detects from magic bytes (more robust).
        const args = [magick, '-'];

        if (to === 'webp') {
            if (lossless) {
                args.push('-define', 'webp:lossless=true');
            } else {
                args.push('-quality', String(quality));
            }
        } else if (to === 'png') {
            // nothing extra needed
        } else {
            // generic quality flag for other lossy formats
            args.push('-quality', String(quality));
        }

        // Output: <format>:- means "write <format> to stdout"
        args.push(`${to}:-`);

        return this._runMagick(args, bytesU8);
    }

    // -----------------------------------------------------------------------
    // decodeToPng — any supported format → PNG bytes
    // -----------------------------------------------------------------------

    /**
     * Decode any image format to PNG bytes (useful before pasting).
     *
     * @param {Uint8Array} bytesU8
     * @returns {Promise<Uint8Array>}
     */
    async decodeToPng (bytesU8) {
        const magick = findMagick();
        if (!magick) {
            const err = new Error(
                'MagickImageCodec: `magick` binary not found in PATH.'
            );
            err.code = 'MAGICK_NOT_FOUND';
            return Promise.reject(err);
        }

        const args = [magick, '-', 'png:-'];
        return this._runMagick(args, bytesU8);
    }

    // -----------------------------------------------------------------------
    // Internal: spawn magick and collect stdout asynchronously
    // -----------------------------------------------------------------------

    /**
     * Spawn `magick` with the given argv, feed `inputU8` via stdin, and return
     * stdout as a Uint8Array.  Rejects if magick exits non-zero.
     *
     * @param {string[]}   argv
     * @param {Uint8Array} inputU8
     * @returns {Promise<Uint8Array>}
     */
    async _runMagick (argv, inputU8) {
        let proc;
        try {
            proc = new Gio.Subprocess({
                argv,
                // We need to write to stdin and read from stdout.
                flags:
                    Gio.SubprocessFlags.STDIN_PIPE |
                    Gio.SubprocessFlags.STDOUT_PIPE |
                    Gio.SubprocessFlags.STDERR_PIPE,
            });
            proc.init(null);
        } catch (e) {
            const err = new Error(
                `MagickImageCodec: failed to spawn magick: ${e.message}`
            );
            err.code = 'SPAWN_FAILED';
            err.cause = e;
            return Promise.reject(err);
        }

        const stdinBytes = toGLibBytes(inputU8);

        let stdout, stderr;
        try {
            ({ stdout, stderr } = await communicateAsync(proc, stdinBytes));
        } catch (e) {
            const err = new Error(
                `MagickImageCodec: communicate_async failed: ${e.message}`
            );
            err.code = 'IO_ERROR';
            err.cause = e;
            return Promise.reject(err);
        }

        const exitOk = proc.get_exit_status() === 0;
        if (!exitOk) {
            let stderrStr = '';
            try {
                stderrStr = new TextDecoder().decode(fromGLibBytes(stderr));
            } catch { /* ignore */ }
            const err = new Error(
                `MagickImageCodec: magick exited with non-zero status. stderr: ${stderrStr}`
            );
            err.code = 'MAGICK_ERROR';
            err.stderr = stderrStr;
            return Promise.reject(err);
        }

        if (!stdout || stdout.get_size() === 0) {
            const err = new Error('MagickImageCodec: magick produced no output.');
            err.code = 'EMPTY_OUTPUT';
            return Promise.reject(err);
        }

        return fromGLibBytes(stdout);
    }
}
