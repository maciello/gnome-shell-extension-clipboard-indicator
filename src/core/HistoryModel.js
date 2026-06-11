/* HistoryModel — pure in-memory clipboard history, no gi imports.
 *
 * Replaces the O(n) re-hash dedup loop: backed by an ordered Array (index 0 =
 * most recent) PLUS a Map keyed by entry.key() for O(1) lookup/dedup.
 *
 * Invariants:
 *   _entries[i].key() === key  <=>  _index.get(key) === _entries[i]
 *   _entries is always ordered newest-first.
 *   Favorites are NOT counted against maxSize; only history() entries are.
 */

export class HistoryModel {
    /** @type {import('./ClipboardEntry.js').ClipboardEntry[]} */
    #entries;

    /** @type {Map<string, import('./ClipboardEntry.js').ClipboardEntry>} */
    #index;

    /** @type {number} */
    #maxSize;

    /**
     * @param {{ maxSize?: number }} [opts]
     */
    constructor ({ maxSize = 15 } = {}) {
        this.#entries = [];
        this.#index = new Map();
        this.#maxSize = maxSize;
    }

    // --- accessors -----------------------------------------------------------

    get size () {
        return this.#entries.length;
    }

    get maxSize () {
        return this.#maxSize;
    }

    /**
     * Setting maxSize does NOT auto-trim; caller must call trim() afterwards
     * if they want to enforce the new limit.
     * @param {number} n
     */
    set maxSize (n) {
        this.#maxSize = n;
    }

    /**
     * O(1) existence check.
     * @param {string} key
     * @returns {boolean}
     */
    has (key) {
        return this.#index.has(key);
    }

    /**
     * O(1) lookup by key.
     * @param {string} key
     * @returns {import('./ClipboardEntry.js').ClipboardEntry | undefined}
     */
    get (key) {
        return this.#index.get(key);
    }

    /**
     * All entries, newest-first; favorites and non-favorites interleaved by
     * recency (i.e. the natural insertion order).
     * @returns {import('./ClipboardEntry.js').ClipboardEntry[]}
     */
    all () {
        return this.#entries.slice();
    }

    /**
     * Non-favorite entries, newest-first.
     * @returns {import('./ClipboardEntry.js').ClipboardEntry[]}
     */
    history () {
        return this.#entries.filter(e => !e.isFavorite());
    }

    /**
     * Favorite entries, newest-first.
     * @returns {import('./ClipboardEntry.js').ClipboardEntry[]}
     */
    favorites () {
        return this.#entries.filter(e => e.isFavorite());
    }

    // --- mutations -----------------------------------------------------------

    /**
     * Add an entry.  If a duplicate key already exists, returns
     * { added: false, existing } without mutating state.
     * Otherwise inserts at the front and returns { added: true, entry }.
     *
     * @param {import('./ClipboardEntry.js').ClipboardEntry} entry
     * @returns {{ added: boolean, entry?: import('./ClipboardEntry.js').ClipboardEntry, existing?: import('./ClipboardEntry.js').ClipboardEntry }}
     */
    add (entry) {
        const key = entry.key();
        const existing = this.#index.get(key);
        if (existing !== undefined) {
            return { added: false, existing };
        }
        this.#entries.unshift(entry);
        this.#index.set(key, entry);
        return { added: true, entry };
    }

    /**
     * Remove an entry by key.  Keeps both array and index consistent.
     * @param {import('./ClipboardEntry.js').ClipboardEntry} entry
     * @returns {boolean} true if the entry was found and removed
     */
    remove (entry) {
        const key = entry.key();
        if (!this.#index.has(key)) {
            return false;
        }
        this.#index.delete(key);
        const idx = this.#entries.findIndex(e => e.key() === key);
        if (idx !== -1) {
            this.#entries.splice(idx, 1);
        }
        return true;
    }

    /**
     * Move an existing entry to the front (index 0).
     * No-op if the entry is not in the model.
     * @param {import('./ClipboardEntry.js').ClipboardEntry} entry
     * @returns {boolean} true if the entry was found and moved
     */
    moveToFront (entry) {
        const key = entry.key();
        const stored = this.#index.get(key);
        if (stored === undefined) {
            return false;
        }
        const idx = this.#entries.findIndex(e => e.key() === key);
        if (idx === 0) {
            return true; // already at front
        }
        this.#entries.splice(idx, 1);
        this.#entries.unshift(stored);
        return true;
    }

    /**
     * Mark an entry as favorite/non-favorite.  The entry must already be in
     * the model (looked up by key()).
     * @param {import('./ClipboardEntry.js').ClipboardEntry} entry
     * @param {boolean} isFav
     */
    setFavorite (entry, isFav) {
        const stored = this.#index.get(entry.key());
        if (stored !== undefined) {
            stored.setFavorite(isFav);
        }
    }

    /**
     * Remove oldest non-favorite entries until history().length <= maxSize.
     * Favorites are never removed.
     * @returns {import('./ClipboardEntry.js').ClipboardEntry[]} removed entries
     */
    trim () {
        const removed = [];
        while (true) {
            const hist = this.#entries.filter(e => !e.isFavorite());
            if (hist.length <= this.#maxSize) break;

            // oldest non-favorite = last non-favorite in the array
            let oldestIdx = -1;
            for (let i = this.#entries.length - 1; i >= 0; i--) {
                if (!this.#entries[i].isFavorite()) {
                    oldestIdx = i;
                    break;
                }
            }
            if (oldestIdx === -1) break; // only favorites remain (shouldn't happen)

            const [victim] = this.#entries.splice(oldestIdx, 1);
            this.#index.delete(victim.key());
            removed.push(victim);
        }
        return removed;
    }

    /**
     * Remove all entries except:
     *   - favorites (when keepFavorites is true, the default)
     *   - entries whose key() is in keepKeys
     *
     * @param {{ keepFavorites?: boolean, keepKeys?: string[] }} [opts]
     * @returns {import('./ClipboardEntry.js').ClipboardEntry[]} removed entries
     */
    clear ({ keepFavorites = true, keepKeys = [] } = {}) {
        const keepSet = new Set(keepKeys);
        const removed = [];
        const surviving = [];

        for (const entry of this.#entries) {
            if ((keepFavorites && entry.isFavorite()) || keepSet.has(entry.key())) {
                surviving.push(entry);
            } else {
                removed.push(entry);
            }
        }

        // Rebuild both structures from survivors.
        this.#entries = surviving;
        this.#index = new Map(surviving.map(e => [e.key(), e]));

        return removed;
    }

    /**
     * Bulk-load entries from an already-ordered array (caller passes
     * newest-first).  Discards any existing state.  Duplicate keys within the
     * provided array are silently skipped (first occurrence wins, preserving
     * recency order).
     *
     * Equivalent to `fromRecords` / `static fromRegistry` in the task spec.
     *
     * @param {import('./ClipboardEntry.js').ClipboardEntry[]} entries
     */
    bulkLoad (entries) {
        this.#entries = [];
        this.#index = new Map();
        for (const entry of entries) {
            const key = entry.key();
            if (!this.#index.has(key)) {
                this.#entries.push(entry);
                this.#index.set(key, entry);
            }
        }
    }

    /**
     * Convenience static factory — creates a model, bulk-loads entries, and
     * returns it.
     *
     * @param {import('./ClipboardEntry.js').ClipboardEntry[]} entries
     * @param {{ maxSize?: number }} [opts]
     * @returns {HistoryModel}
     */
    static fromRegistry (entries, { maxSize = 15 } = {}) {
        const model = new HistoryModel({ maxSize });
        model.bulkLoad(entries);
        return model;
    }
}
