/* EntryBytes — pure helper for building clipboard paste payloads.
 *
 * No gi imports. The only async work is storage/codec I/O which is already
 * async in the port contracts.
 *
 * Guarantees: paste always yields a valid image/png payload even when the
 * on-disk image is stored as compressed webp.
 */

/**
 * Build the { mimetype, bytesU8 } payload to place on the clipboard for the
 * given entry.
 *
 * Text entries: encodes the string to UTF-8 bytes.
 * Image entries:
 *   1. Uses bytes already attached to the entry (entry.bytes()).
 *   2. Falls back to storage.readImageBytes(entry.id()) when bytes are null
 *      (lazy-loaded entries loaded from registry.txt without bytes).
 *   3. If a codec is supplied and the stored format is not 'png' (e.g. 'webp'),
 *      decodes to PNG so the clipboard always exposes image/png.
 *
 * @param {import('./core/ClipboardEntry.js').ClipboardEntry} entry
 * @param {{ storage: import('./ports/StoragePort.js').StoragePort,
 *           codec?: import('./ports/ImageCodecPort.js').ImageCodecPort|null }} opts
 * @returns {Promise<{ mimetype: string, bytesU8: Uint8Array }>}
 */
export async function entryClipboardPayload(entry, { storage, codec = null }) {
    if (entry.isText()) {
        return {
            mimetype: entry.mimetype(),
            bytesU8: new TextEncoder().encode(entry.getStringValue()),
        };
    }

    // --- image ---
    let raw = entry.bytes();
    if (raw === null) {
        raw = await storage.readImageBytes(entry.id());
    }

    if (codec !== null && raw !== null) {
        const fmt = codec.sniff(raw);
        if (fmt !== 'png') {
            try {
                raw = await codec.decodeToPng(raw);
                return { mimetype: 'image/png', bytesU8: raw };
            } catch (_) {
                // Fall back to raw bytes on decode failure.
            }
        }
    }

    return { mimetype: entry.mimetype(), bytesU8: raw };
}
