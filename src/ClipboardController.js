/* ClipboardController — application-layer controller.
 *
 * Wires together the pure core (HistoryModel, ClipboardEntry) and port
 * adapters (StoragePort, ClipboardPort, …) without touching any GObject or
 * GNOME Shell APIs directly.  All side-effectful I/O goes through injected
 * ports so the controller is fully unit-testable with fake doubles.
 *
 * Events emitted (subscribe via on/off):
 *   'added'       (entry)    — a new entry was added to the model
 *   'selected'    (entry)    — an existing entry was re-selected (already in history)
 *   'removed'     (entry)    — a single entry was removed
 *   'removedBulk' (entries[])— multiple entries were removed at once (trim / clear)
 *   'reloaded'    (entries[])— model was bulk-loaded from storage
 */

import { ClipboardEntry } from './core/ClipboardEntry.js';
import { SearchFilter } from './core/SearchFilter.js';

export class ClipboardController {
    /** @type {import('./core/HistoryModel.js').HistoryModel} */
    #model;
    /** @type {import('./ports/StoragePort.js').StoragePort} */
    #storage;
    /** @type {import('./ports/ClipboardPort.js').ClipboardPort} */
    #clipboard;
    /** @type {import('./ports/ImageCodecPort.js').ImageCodecPort|null} */
    #codec;
    /** @type {object} - plain config bag */
    #config;
    /** @type {object} - UI hooks */
    #hooks;
    /** @type {object|null} */
    #profiler;

    /** @type {Map<string, Set<Function>>} */
    #listeners = new Map();

    /** Disconnect function returned by clipboard.onChange(). */
    #disc = null;

    /** Reentrancy guard — prevents overlapping handleClipboardChange() calls. */
    #busy = false;

    /**
     * @param {object} opts
     * @param {import('./core/HistoryModel.js').HistoryModel}    opts.model
     * @param {import('./ports/StoragePort.js').StoragePort}     opts.storage
     * @param {import('./ports/ClipboardPort.js').ClipboardPort} opts.clipboard
     * @param {object}                                           [opts.scheduler]  - unused by controller directly; kept for symmetry
     * @param {import('./ports/ImageCodecPort.js').ImageCodecPort|null} [opts.codec]
     * @param {object}  opts.config   - live config bag (see module docstring)
     * @param {object}  [opts.hooks]  - { getActiveWmClass, isDestroyed, notifyCopied }
     * @param {object|null} [opts.profiler]
     */
    constructor ({ model, storage, clipboard, codec = null, config, hooks = {}, profiler = null }) {
        this.#model = model;
        this.#storage = storage;
        this.#clipboard = clipboard;
        this.#codec = codec;
        this.#config = config;
        this.#profiler = profiler;

        // Normalise hooks — fill in no-op defaults.
        this.#hooks = {
            getActiveWmClass: () => undefined,
            isDestroyed: () => false,
            notifyCopied: () => {},
            ...hooks,
        };
    }

    // -------------------------------------------------------------------------
    // Event bus
    // -------------------------------------------------------------------------

    /**
     * Subscribe to a named event.
     * @param {string}   name
     * @param {Function} cb
     */
    on (name, cb) {
        if (!this.#listeners.has(name)) {
            this.#listeners.set(name, new Set());
        }
        this.#listeners.get(name).add(cb);
    }

    /**
     * Unsubscribe from a named event.
     * @param {string}   name
     * @param {Function} cb
     */
    off (name, cb) {
        this.#listeners.get(name)?.delete(cb);
    }

    /**
     * Emit a named event to all subscribers.
     * @param {string} name
     * @param {...*}   args
     */
    emit (name, ...args) {
        const set = this.#listeners.get(name);
        if (!set) return;
        for (const cb of set) {
            try { cb(...args); } catch (e) {
                console.error(`ClipboardController event '${name}' handler threw`, e);
            }
        }
    }

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    /**
     * Load history from storage and populate the model.
     * Must be awaited before start().
     *
     * @returns {Promise<import('./core/ClipboardEntry.js').ClipboardEntry[]>}
     */
    async loadInitial () {
        const entries = await this.#storage.read();
        this.#model.bulkLoad(entries);
        this.emit('reloaded', entries);
        return entries;
    }

    /**
     * Start listening for clipboard changes.
     */
    start () {
        this.#disc = this.#clipboard.onChange(() => {
            this.handleClipboardChange();
        });
    }

    /**
     * Stop listening and flush any pending storage write.
     *
     * @returns {Promise<void>}
     */
    async stop () {
        if (this.#disc) {
            this.#disc();
            this.#disc = null;
        }
        await this.#storage.flush();
    }

    // -------------------------------------------------------------------------
    // Core copy handler
    // -------------------------------------------------------------------------

    /**
     * Called whenever the clipboard owner changes.
     * Re-entrant calls (during an in-flight async read) are silently dropped.
     *
     * @returns {Promise<void>}
     */
    async handleClipboardChange () {
        const run = async () => {
            // Guards.
            if (this.#config.privateMode) return;
            if (this.#hooks.isDestroyed()) return;
            if (this.#busy) return;
            this.#busy = true;

            try {
                const wm = this.#hooks.getActiveWmClass();
                if (wm && this.#config.excludedApps && this.#config.excludedApps.includes(wm)) return;

                const content = await this.#clipboard.getContent();
                if (!content) return;

                // --- build entry ---
                let entry;
                if (content.mimetype.startsWith('image/')) {
                    entry = ClipboardEntry.image(content.bytesU8, { mimetype: content.mimetype });
                } else {
                    let text = new TextDecoder().decode(content.bytesU8);
                    if (this.#config.stripText) text = text.trim();
                    entry = ClipboardEntry.text(text, { mimetype: content.mimetype });
                }

                // --- image persistence ---
                if (entry.isImage()) {
                    if (!this.#config.cacheImages) return;

                    let imageBytes = content.bytesU8;
                    let imageMimetype = content.mimetype;

                    if (this.#config.compression !== 'off' && this.#codec) {
                        try {
                            const lossless = this.#config.compression === 'lossless';
                            imageBytes = await this.#codec.encode(content.bytesU8, {
                                to: 'webp',
                                lossless,
                                quality: lossless ? undefined : 80,
                            });
                            // Keep entry mimetype as original; write compressed bytes to disk.
                        } catch (_) {
                            // Fall back to raw bytes on encode failure.
                            imageBytes = content.bytesU8;
                        }
                    }

                    await this.#storage.writeImageBytes(entry.id(), imageBytes, { mimetype: imageMimetype });
                }

                // --- dedup / add ---
                const existing = this.#model.get(entry.key());
                if (existing) {
                    this.emit('selected', existing);
                    if (!existing.isFavorite() && this.#config.moveItemFirst) {
                        this.#model.moveToFront(existing);
                        this._persist();
                    }
                    return;
                }

                this.#model.add(entry);
                this._persist();

                const removed = this.#model.trim();
                for (const r of removed) {
                    if (r.isImage()) this.#storage.deleteImage(r.id());
                }

                this.emit('added', entry);
                if (removed.length) this.emit('removedBulk', removed);
                if (this.#config.notifyOnCopy) this.#hooks.notifyCopied();

            } finally {
                this.#busy = false;
            }
        };

        if (this.#profiler) {
            return this.#profiler.time('copy', run);
        }
        return run();
    }

    // -------------------------------------------------------------------------
    // Mutations
    // -------------------------------------------------------------------------

    /**
     * Remove a single entry from the model and storage.
     * @param {import('./core/ClipboardEntry.js').ClipboardEntry} entry
     * @returns {boolean}
     */
    removeEntry (entry) {
        const ok = this.#model.remove(entry);
        if (entry.isImage()) this.#storage.deleteImage(entry.id());
        this._persist();
        if (ok) this.emit('removed', entry);
        return ok;
    }

    /**
     * Toggle favorite status and move the entry to front.
     * @param {import('./core/ClipboardEntry.js').ClipboardEntry} entry
     */
    toggleFavorite (entry) {
        this.#model.setFavorite(entry, !entry.isFavorite());
        this.#model.moveToFront(entry);
        this._persist();
    }

    /**
     * Move an entry to the front of the history.
     * @param {import('./core/ClipboardEntry.js').ClipboardEntry} entry
     */
    moveItemFirst (entry) {
        this.#model.moveToFront(entry);
        this._persist();
    }

    /**
     * Remove all non-favorite entries (and optionally keep specific keys).
     *
     * @param {object}   [opts]
     * @param {boolean}  [opts.keepFavorites=true]
     * @param {string[]} [opts.keepKeys=[]]
     * @returns {import('./core/ClipboardEntry.js').ClipboardEntry[]} removed entries
     */
    clearHistory ({ keepFavorites = true, keepKeys = [] } = {}) {
        const removed = this.#model.clear({ keepFavorites, keepKeys });
        for (const r of removed) {
            if (r.isImage()) this.#storage.deleteImage(r.id());
        }
        this._persist();
        this.emit('removedBulk', removed);
        return removed;
    }

    /**
     * Replace the text of an existing entry in place.
     * @param {import('./core/ClipboardEntry.js').ClipboardEntry} entry
     * @param {string} newText
     */
    updateText (entry, newText) {
        entry.setText(newText);
        this._persist();
    }

    /**
     * Set a tag on an entry.
     * @param {import('./core/ClipboardEntry.js').ClipboardEntry} entry
     * @param {string|null} tag
     */
    setTag (entry, tag) {
        entry.setTag(tag);
        this._persist();
    }

    /**
     * Flush any pending debounced storage write.
     * @returns {Promise<void>}
     */
    async flush () {
        await this.#storage.flush();
    }

    // -------------------------------------------------------------------------
    // Read-only model views (used by the UI for cycling / search / lazy render)
    // -------------------------------------------------------------------------

    /** All model entries, newest-first. */
    modelEntries () {
        return this.#model.all();
    }

    /** Non-favorite model entries, newest-first. */
    modelHistory () {
        return this.#model.history();
    }

    /** Favorite model entries, newest-first. */
    modelFavorites () {
        return this.#model.favorites();
    }

    /**
     * Create a SearchFilter bound to the same semantics the model uses.
     * @param {object} [opts]
     * @returns {SearchFilter}
     */
    makeSearchFilter (opts = {}) {
        return new SearchFilter(opts);
    }

    /**
     * Apply a new maximum history size: updates the model and trims overflow.
     * Removed entries (and their image files) are cleaned up and a 'removedBulk'
     * event is emitted so the UI can drop their rows.
     *
     * @param {number} maxSize
     * @returns {import('./core/ClipboardEntry.js').ClipboardEntry[]} removed
     */
    applyMaxSize (maxSize) {
        this.#model.maxSize = maxSize;
        const removed = this.#model.trim();
        if (removed.length) {
            for (const r of removed) {
                if (r.isImage()) this.#storage.deleteImage(r.id());
            }
            this._persist();
            this.emit('removedBulk', removed);
        }
        return removed;
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    /** Enqueue a debounced write of the appropriate entries. */
    _persist () {
        this.#storage.writeDebounced(this._cacheEntries());
    }

    /**
     * Return the entries that should be persisted, respecting cacheOnlyFavorite.
     * @returns {import('./core/ClipboardEntry.js').ClipboardEntry[]}
     */
    _cacheEntries () {
        const all = this.#model.all();
        return this.#config.cacheOnlyFavorite ? all.filter(e => e.isFavorite()) : all;
    }
}
