/* ImageCodecPort — abstract contract for image encoding, decoding, and sniffing.
 *
 * Keeps core business logic (dedup, GC, history model) free of gi pixbuf /
 * GdkPixbuf details.  The production adapter wraps GdkPixbuf; a test double
 * can operate on raw byte buffers or identity transforms.
 *
 * All operations accept and return raw Uint8Array byte buffers.  They must be
 * non-blocking from the caller's perspective (async), so the adapter is free
 * to use GIO async APIs under the hood.
 */

/**
 * @typedef {'png'|'webp'|'jpeg'|'gif'|'svg'|'avif'|'unknown'} ImageFormat
 */

export class ImageCodecPort {
    /**
     * Transcode image bytes from one format to another.
     *
     * @param {Uint8Array} bytesU8   - source image bytes (any supported format)
     * @param {object}     opts
     * @param {ImageFormat} opts.from     - source format hint; 'unknown' = auto-detect
     * @param {ImageFormat} opts.to       - target format (e.g. 'png', 'webp')
     * @param {number}     [opts.quality] - 0–100; meaningful for lossy targets (jpeg, webp)
     * @param {boolean}    [opts.lossless]- when true, encode losslessly (webp, avif)
     * @returns {Promise<Uint8Array>} encoded bytes in the target format
     */
    async encode (bytesU8, { from, to, quality, lossless } = {}) {
        throw new Error('ImageCodecPort.encode() not implemented');
    }

    /**
     * Decode any supported image format to PNG bytes.
     * Convenience wrapper around encode({ to: 'png' }).
     *
     * @param {Uint8Array} bytesU8
     * @returns {Promise<Uint8Array>} PNG-encoded bytes
     */
    async decodeToPng (bytesU8) {
        throw new Error('ImageCodecPort.decodeToPng() not implemented');
    }

    /**
     * Detect the image format from the magic bytes at the start of `bytesU8`.
     * Returns 'unknown' if the format cannot be determined.
     *
     * This is a SYNCHRONOUS operation — it only inspects the first few bytes
     * (magic numbers) and must not do any decoding.
     *
     * Known magic signatures:
     *   png   — 0x89 50 4E 47 0D 0A 1A 0A
     *   webp  — 0x52 49 46 46 … 0x57 45 42 50  (RIFF….WEBP)
     *   jpeg  — 0xFF D8 FF
     *   gif   — 0x47 49 46 38 (GIF8)
     *   svg   — text starting with '<svg' or '<?xml'
     *   avif  — ftyp box with 'avif' or 'avis' brand
     *
     * @param {Uint8Array} bytesU8
     * @returns {ImageFormat}
     */
    sniff (bytesU8) {
        throw new Error('ImageCodecPort.sniff() not implemented');
    }
}
