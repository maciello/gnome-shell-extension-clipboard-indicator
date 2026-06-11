/* GioRegistryStorage — StoragePort implementation backed by Gio/GLib file I/O.
 *
 * Runs inside the GNOME Shell process (or under plain `gjs` for unit tests)
 * but never imports gi://St, gi://Clutter, gi://Meta, or any shell resource.
 * Only gi://GLib and gi://Gio are used.
 *
 * Key design decisions vs. legacy registry.js:
 *  1. writeDebounced() coalesces rapid writes via a 750 ms GLib.timeout_add
 *     rather than writing synchronously on every copy.
 *  2. mkdir_with_parents is called ONCE, lazily, then cached.
 *  3. Byte format is identical to the legacy registry.txt — no migration needed.
 *  4. Constructor takes (uuid, settings) so it is fully testable via injection.
 *     `settings` must expose:
 *       settings.getInt('history-size')   -> number
 *       settings.getInt('cache-size')     -> number   (MB threshold for backup)
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { StoragePort } from '../ports/StoragePort.js';
import { ClipboardEntry } from '../core/ClipboardEntry.js';
import { isBookkeepingFile } from '../core/CacheGC.js';

const REGISTRY_FILE = 'registry.txt';
const BACKUP_SUFFIX = '~';
const DEBOUNCE_MS = 750;

// Basenames of files that live in REGISTRY_DIR but are NOT image cache files.
const SKIP_BASENAMES = new Set([
    REGISTRY_FILE,
    REGISTRY_FILE + BACKUP_SUFFIX,
    REGISTRY_FILE + '.backup',
]);

export class GioRegistryStorage extends StoragePort {
    /** @type {string} */
    #uuid;
    /** @type {object} - { getInt(key): number } */
    #settings;

    /** @type {string} */
    #registryDir;
    /** @type {string} */
    #registryPath;
    /** @type {string} */
    #backupPath;

    /** Whether REGISTRY_DIR has been created yet (lazy guard). */
    #dirCreated = false;

    // --- debounce state -------------------------------------------------------
    /** Latest entries snapshot waiting to be flushed, or null if no pending write. */
    #pendingEntries = null;
    /** GLib source handle for the pending timeout, or null. */
    #timeoutHandle = null;
    /** Resolve-callbacks for any flush() callers waiting on the current write. */
    #flushWaiters = [];

    // -------------------------------------------------------------------------

    /**
     * @param {string} uuid      - extension uuid, e.g. 'clipboard-indicator@tudmotu.com'
     * @param {object} settings  - settings object exposing getInt(key): number
     * @param {object} [opts]
     * @param {string} [opts._registryDir] - override the computed registry dir (tests only)
     */
    constructor (uuid, settings, { _registryDir } = {}) {
        super();
        this.#uuid = uuid;
        this.#settings = settings;

        this.#registryDir = _registryDir != null
            ? _registryDir
            : GLib.get_user_cache_dir() + '/' + uuid;
        this.#registryPath = this.#registryDir + '/' + REGISTRY_FILE;
        this.#backupPath = this.#registryPath + BACKUP_SUFFIX;
    }

    // -------------------------------------------------------------------------
    // StoragePort.registryDir
    // -------------------------------------------------------------------------

    get registryDir () {
        return this.#registryDir;
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    /** Ensure the cache directory exists. Called at most once. */
    #ensureDir () {
        if (this.#dirCreated) return;
        GLib.mkdir_with_parents(this.#registryDir, parseInt('0775', 8));
        this.#dirCreated = true;
    }

    /**
     * Wrap a Gio *_async callback into a Promise.
     * `startFn` receives (callback) and should call the async method.
     * `finishFn` receives (source, result) and returns the resolved value or throws.
     *
     * @template T
     * @param {(cb: Gio.AsyncReadyCallback) => void} startFn
     * @param {(src: Gio.AsyncResult, res: Gio.AsyncResult) => T} finishFn
     * @returns {Promise<T>}
     */
    static #promisify (startFn, finishFn) {
        return new Promise((resolve, reject) => {
            startFn((src, res) => {
                try {
                    resolve(finishFn(src, res));
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    // -------------------------------------------------------------------------
    // Registry read
    // -------------------------------------------------------------------------

    /**
     * Load registry.txt asynchronously and return ClipboardEntry[].
     *
     * Mirrors legacy read() behaviour:
     *  - If the file doesn't exist → []
     *  - If the file is >= cache-size MB → move to BACKUP, return []
     *  - JSON.parse → map via ClipboardEntry.fromRegistryRecord
     *  - Drop image entries whose cache file is missing
     *  - Trim non-favorites beyond history-size (oldest first)
     *  - Return newest-first as stored
     *
     * @returns {Promise<ClipboardEntry[]>}
     */
    async read () {
        const fileExists = GLib.file_test(this.#registryPath, GLib.FileTest.EXISTS);
        if (!fileExists) return [];

        const file = Gio.file_new_for_path(this.#registryPath);

        // --- oversized file guard ---
        const cacheSizeMB = this.#settings.getInt('cache-size');

        const fileInfo = await GioRegistryStorage.#promisify(
            cb => file.query_info_async(
                'standard::size',
                Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT,
                null,
                cb
            ),
            (src, res) => src.query_info_finish(res)
        );

        if (fileInfo.get_size() >= cacheSizeMB * 1024 * 1024) {
            // Move the bloated file to BACKUP and start fresh.
            const destination = Gio.file_new_for_path(this.#backupPath);
            file.move(destination, Gio.FileCopyFlags.OVERWRITE, null, null);
            return [];
        }

        // --- load file contents ---
        const [_ok, rawBytes] = await GioRegistryStorage.#promisify(
            cb => file.load_contents_async(null, cb),
            (src, res) => src.load_contents_finish(res)
        );

        const text = new TextDecoder().decode(rawBytes).trim();
        if (text.length === 0) return [];

        let records;
        try {
            records = JSON.parse(text);
        } catch (e) {
            console.error('GioRegistryStorage: registry.txt parse error — returning []', e);
            return [];
        }

        if (!Array.isArray(records)) return [];

        // --- reconstruct entries ---
        let entries = records.map(rec => {
            try {
                return ClipboardEntry.fromRegistryRecord(rec);
            } catch (e) {
                console.warn('GioRegistryStorage: skipping malformed record', e);
                return null;
            }
        }).filter(e => e !== null);

        // Drop image entries whose cache file no longer exists on disk.
        entries = entries.filter(entry => {
            if (!entry.isImage()) return true;
            const cachePath = this.#registryDir + '/' + entry.id();
            return GLib.file_test(cachePath, GLib.FileTest.EXISTS);
        });

        // --- trim non-favorites beyond history-size ---
        // entries are newest-first; oldest non-favorite = last in the sub-array.
        const maxSize = this.#settings.getInt('history-size');
        let nonFavs = entries.filter(e => !e.isFavorite());

        while (nonFavs.length > maxSize) {
            // Remove oldest non-favorite (last in newest-first order).
            const oldest = nonFavs.pop();
            const idx = entries.indexOf(oldest);
            if (idx !== -1) entries.splice(idx, 1);
            nonFavs = entries.filter(e => !e.isFavorite());
        }

        return entries;
    }

    // -------------------------------------------------------------------------
    // Registry write — debounced
    // -------------------------------------------------------------------------

    /**
     * Enqueue a debounced write.  Multiple calls within 750 ms coalesce into one.
     *
     * @param {ClipboardEntry[]} entries - newest-first snapshot
     */
    writeDebounced (entries) {
        // Always store the latest snapshot.
        this.#pendingEntries = entries;

        // Cancel the existing timer so we restart the window.
        if (this.#timeoutHandle !== null) {
            GLib.source_remove(this.#timeoutHandle);
            this.#timeoutHandle = null;
        }

        this.#timeoutHandle = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            DEBOUNCE_MS,
            () => {
                this.#timeoutHandle = null;
                const snapshot = this.#pendingEntries;
                this.#pendingEntries = null;
                this.#doWrite(snapshot);
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    /**
     * Force the pending write (if any) to complete immediately.
     * Returns a Promise that resolves once the file has been written.
     *
     * @returns {Promise<void>}
     */
    async flush () {
        if (this.#pendingEntries === null && this.#timeoutHandle === null) {
            return; // nothing pending
        }

        // Cancel the timer.
        if (this.#timeoutHandle !== null) {
            GLib.source_remove(this.#timeoutHandle);
            this.#timeoutHandle = null;
        }

        const snapshot = this.#pendingEntries;
        this.#pendingEntries = null;

        if (snapshot === null) return;

        // Wait for the actual write to finish.
        await new Promise((resolve, reject) => {
            this.#flushWaiters.push({ resolve, reject });
            this.#doWrite(snapshot);
        });
    }

    /**
     * Immediate, fire-and-forget write (not debounced).
     * Persists entries synchronously to the registry path via replace_async.
     *
     * @param {ClipboardEntry[]} entries
     * @returns {Promise<void>} - resolves when the file is fully written
     */
    async write (entries) {
        return this.#doWrite(entries);
    }

    /**
     * The actual async write implementation shared by write(), writeDebounced()
     * timer callback, and flush().
     *
     * @param {ClipboardEntry[]} entries
     * @returns {Promise<void>}
     */
    #doWrite (entries) {
        this.#ensureDir();

        const records = entries.map(e => e.toRegistryRecord(this.#registryDir));
        const json = JSON.stringify(records);
        const bytes = new GLib.Bytes(new TextEncoder().encode(json));

        const file = Gio.file_new_for_path(this.#registryPath);
        const waiters = this.#flushWaiters.splice(0);

        const promise = new Promise((resolve, reject) => {
            file.replace_async(
                null,
                false,
                Gio.FileCreateFlags.NONE,
                GLib.PRIORITY_DEFAULT,
                null,
                (obj, res) => {
                    let stream;
                    try {
                        stream = obj.replace_finish(res);
                    } catch (e) {
                        reject(e);
                        waiters.forEach(w => w.reject(e));
                        return;
                    }

                    stream.write_bytes_async(
                        bytes,
                        GLib.PRIORITY_DEFAULT,
                        null,
                        (wObj, wRes) => {
                            try {
                                wObj.write_bytes_finish(wRes);
                                stream.close(null);
                                resolve();
                                waiters.forEach(w => w.resolve());
                            } catch (e) {
                                try { stream.close(null); } catch (_) { /* ignore */ }
                                reject(e);
                                waiters.forEach(w => w.reject(e));
                            }
                        }
                    );
                }
            );
        });

        return promise;
    }

    // -------------------------------------------------------------------------
    // Image byte cache
    // -------------------------------------------------------------------------

    /**
     * Read raw bytes for the image identified by `id`.
     *
     * @param {string} id - glibHash string (decimal)
     * @returns {Promise<Uint8Array|null>}
     */
    async readImageBytes (id) {
        const path = this.#registryDir + '/' + id;
        if (!GLib.file_test(path, GLib.FileTest.EXISTS)) return null;

        const file = Gio.file_new_for_path(path);
        const [_ok, contents] = await GioRegistryStorage.#promisify(
            cb => file.load_contents_async(null, cb),
            (src, res) => src.load_contents_finish(res)
        );

        // contents is a Uint8Array (GBytes-backed) under gjs — return a plain copy.
        return Uint8Array.from(contents);
    }

    /**
     * Persist raw image bytes under `id`.
     *
     * @param {string}     id
     * @param {Uint8Array} bytesU8
     * @param {object}     [opts]
     * @param {string}     [opts.mimetype]
     * @returns {Promise<void>}
     */
    async writeImageBytes (id, bytesU8, { mimetype } = {}) {
        this.#ensureDir();

        const path = this.#registryDir + '/' + id;
        const file = Gio.file_new_for_path(path);
        const glibBytes = new GLib.Bytes(bytesU8);

        await new Promise((resolve, reject) => {
            file.replace_async(
                null,
                false,
                Gio.FileCreateFlags.NONE,
                GLib.PRIORITY_DEFAULT,
                null,
                (obj, res) => {
                    let stream;
                    try {
                        stream = obj.replace_finish(res);
                    } catch (e) {
                        reject(e);
                        return;
                    }

                    stream.write_bytes_async(
                        glibBytes,
                        GLib.PRIORITY_DEFAULT,
                        null,
                        (wObj, wRes) => {
                            try {
                                wObj.write_bytes_finish(wRes);
                                stream.close(null);
                                resolve();
                            } catch (e) {
                                try { stream.close(null); } catch (_) { /* ignore */ }
                                reject(e);
                            }
                        }
                    );
                }
            );
        });
    }

    /**
     * Delete the cached image file for `id`.  Silently succeeds when missing.
     *
     * @param {string} id
     * @returns {Promise<void>}
     */
    async deleteImage (id) {
        const path = this.#registryDir + '/' + id;
        const file = Gio.file_new_for_path(path);
        try {
            await GioRegistryStorage.#promisify(
                cb => file.delete_async(GLib.PRIORITY_DEFAULT, null, cb),
                (src, res) => src.delete_finish(res)
            );
        } catch (e) {
            // Silently ignore "file not found" errors.
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
                console.error('GioRegistryStorage.deleteImage: unexpected error', e);
            }
        }
    }

    /**
     * List all image cache file basenames in REGISTRY_DIR (excludes bookkeeping files).
     *
     * @returns {Promise<string[]>}
     */
    async listImageFiles () {
        const dir = Gio.file_new_for_path(this.#registryDir);

        // If the directory doesn't exist yet there are no files.
        if (!GLib.file_test(this.#registryDir, GLib.FileTest.IS_DIR)) return [];

        const enumerator = await GioRegistryStorage.#promisify(
            cb => dir.enumerate_children_async(
                'standard::name',
                Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT,
                null,
                cb
            ),
            (src, res) => src.enumerate_children_finish(res)
        );

        const names = [];
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const infos = await GioRegistryStorage.#promisify(
                cb => enumerator.next_files_async(64, GLib.PRIORITY_DEFAULT, null, cb),
                (src, res) => src.next_files_finish(res)
            );

            if (infos.length === 0) break;

            for (const info of infos) {
                const name = info.get_name();
                if (!isBookkeepingFile(name) && !SKIP_BASENAMES.has(name)) {
                    names.push(name);
                }
            }
        }

        try {
            enumerator.close(null);
        } catch (_) { /* ignore */ }

        return names;
    }
}
