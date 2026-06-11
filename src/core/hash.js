/* Pure content hashing — no gi imports.
 *
 * `glibHash` reproduces GLib's g_bytes_hash() byte-for-byte (djb2 over
 * SIGNED char values, 32-bit unsigned result). This matters because the
 * legacy on-disk image cache names every file after GLib.Bytes.hash() of its
 * raw bytes. Reproducing it in pure JS lets us:
 *   1. compute an image entry's identity ONCE, off the GLib path, and
 *   2. keep new captures' filenames identical to the existing 186 MB cache,
 *      so de-duplication against pre-existing data keeps working.
 *
 * Verified against real cache files (see tests/core/hash.test.js).
 */

/**
 * @param {Uint8Array|number[]} bytes
 * @returns {number} unsigned 32-bit hash, identical to GLib's g_bytes_hash
 */
export function glibHash (bytes) {
    let h = 5381 >>> 0;
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        // GLib reads each byte as a *signed* char.
        const sb = b < 128 ? b : b - 256;
        // Math.imul keeps the multiply in 32-bit space; >>>0 wraps unsigned.
        h = (Math.imul(h, 33) + sb) >>> 0;
    }
    return h >>> 0;
}

/** Decimal string form of the GLib hash, i.e. the legacy cache filename. */
export function glibHashString (bytes) {
    return String(glibHash(bytes));
}
