/* StoragePort — abstract contract for persistent clipboard history storage.
 *
 * Implementations are responsible for:
 *   - reading/writing registry.txt (the JSON array of entry records)
 *   - managing the image byte-cache directory (one file per image, named by
 *     glibHash string, i.e. the entry id)
 *
 * The production adapter wraps Gio async file I/O; test doubles can operate
 * against an in-memory Map.  Neither this file nor the core modules ever touch
 * gi or the filesystem directly.
 *
 * Registry file format is defined by ClipboardEntry.toRegistryRecord() /
 * ClipboardEntry.fromRegistryRecord() — byte-compatible with v71 registry.txt.
 */

/**
 * @typedef {import('../core/ClipboardEntry.js').ClipboardEntry} ClipboardEntry
 */

export class StoragePort {
    /**
     * Absolute path to the image cache directory.
     * Implementations must set this before any other method is called.
     * Consumers use it to construct absolute image paths for display.
     * @type {string}
     */
    get registryDir () {
        throw new Error('StoragePort.registryDir not implemented');
    }

    // -------------------------------------------------------------------------
    // Registry (history list)
    // -------------------------------------------------------------------------

    /**
     * Read and parse registry.txt; return all entries in newest-first order.
     * Returns an empty array when the file does not exist.
     *
     * @returns {Promise<ClipboardEntry[]>}
     */
    async read () {
        throw new Error('StoragePort.read() not implemented');
    }

    /**
     * Enqueue a debounced write of the current entries snapshot.
     * Multiple rapid calls within the debounce window coalesce into one write.
     * Callers must call flush() before extension disable to drain any pending write.
     *
     * @param {ClipboardEntry[]} entries - ordered snapshot (newest-first)
     * @returns {void}
     */
    writeDebounced (entries) {
        throw new Error('StoragePort.writeDebounced() not implemented');
    }

    /**
     * Force any pending debounced write to complete immediately.
     * Should be awaited during extension disable / cleanup.
     *
     * @returns {Promise<void>}
     */
    async flush () {
        throw new Error('StoragePort.flush() not implemented');
    }

    // -------------------------------------------------------------------------
    // Image byte cache
    // -------------------------------------------------------------------------

    /**
     * Read raw bytes for the image identified by `id` (glibHash string).
     * Returns null when the file does not exist in the cache.
     *
     * @param {string} id - glibHash string (decimal), e.g. "3271082232"
     * @returns {Promise<Uint8Array|null>}
     */
    async readImageBytes (id) {
        throw new Error('StoragePort.readImageBytes() not implemented');
    }

    /**
     * Persist raw image bytes under `id` in the cache directory.
     * The file is created or overwritten atomically where the platform allows.
     *
     * @param {string}     id       - glibHash string, used as filename
     * @param {Uint8Array} bytesU8  - raw image data
     * @param {object}     [opts]
     * @param {string}     [opts.mimetype] - e.g. 'image/png'; informational only
     * @returns {Promise<void>}
     */
    async writeImageBytes (id, bytesU8, { mimetype } = {}) {
        throw new Error('StoragePort.writeImageBytes() not implemented');
    }

    /**
     * Delete the cached image file for `id`.
     * Silently succeeds when the file does not exist.
     *
     * @param {string} id - glibHash string
     * @returns {Promise<void>}
     */
    async deleteImage (id) {
        throw new Error('StoragePort.deleteImage() not implemented');
    }

    /**
     * List all image cache file basenames (the glibHash id strings) present in
     * the cache directory.  Used by CacheGC to find orphaned files.
     *
     * @returns {Promise<string[]>}
     */
    async listImageFiles () {
        throw new Error('StoragePort.listImageFiles() not implemented');
    }
}
