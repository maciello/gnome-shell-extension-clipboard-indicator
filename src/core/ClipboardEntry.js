/* ClipboardEntry — pure value object, no gi imports.
 *
 * This is the heart of the freeze fix. The legacy implementation recomputed an
 * image's content hash (allocating + hashing the full multi-MB byte buffer) on
 * EVERY equality check, and equality was checked against every history entry on
 * every copy — O(n) hashes of up to 13 MB each, on the compositor main loop.
 *
 * Here, identity is computed ONCE and cached:
 *   - text  → identity is the text itself
 *   - image → identity is glibHash(bytes) computed a single time at creation
 *             (or taken from the cache filename when loaded from disk)
 *
 * `key()`/`equals()` are then O(1) string comparisons. Bytes are never re-hashed.
 *
 * Registry (de)serialization lives here too (as pure transforms) so the
 * byte-for-byte format compatibility can be unit-tested without a live shell.
 */

import { glibHashString } from './hash.js';

const DEFAULT_MIMETYPE = 'text/plain;charset=utf-8';

function mimeIsText (mimetype) {
    return mimetype.startsWith('text/') ||
        mimetype === 'STRING' ||
        mimetype === 'UTF8_STRING';
}

function mimeIsImage (mimetype) {
    return mimetype.startsWith('image/');
}

function basename (path) {
    const idx = path.lastIndexOf('/');
    return idx === -1 ? path : path.slice(idx + 1);
}

export class ClipboardEntry {
    #mimetype;
    #favorite;
    #tag;
    #isImage;
    #text;          // text entries: the string content
    #id;            // image entries: stable identity (glibHash string)
    #bytes;         // image entries: raw bytes (Uint8Array) — may be null when lazy
    #stringValue;   // cached getStringValue()
    #serializedCache = null; // Map<registryDir, string> or null — invalidated on mutation

    constructor ({ mimetype = DEFAULT_MIMETYPE, favorite = false, tag = null,
                   text = null, id = null, bytes = null }) {
        this.#mimetype = mimetype;
        this.#favorite = !!favorite;
        this.#tag = tag || null;
        this.#isImage = mimeIsImage(mimetype);

        if (this.#isImage) {
            this.#bytes = bytes;
            // Identity: prefer an explicit id (e.g. from the cache filename),
            // otherwise derive it once from the bytes.
            if (id != null) {
                this.#id = String(id);
            } else if (bytes != null) {
                this.#id = glibHashString(bytes);
            } else {
                throw new Error('image ClipboardEntry requires id or bytes');
            }
            this.#stringValue = `[Image ${this.#id}]`;
        } else {
            this.#text = text != null ? text : '';
            this.#stringValue = this.#text;
        }
    }

    /** Build a text entry. */
    static text (text, { mimetype = DEFAULT_MIMETYPE, favorite = false, tag = null } = {}) {
        return new ClipboardEntry({ mimetype, favorite, tag, text });
    }

    /** Build an image entry from raw bytes (identity derived once). */
    static image (bytes, { mimetype = 'image/png', favorite = false, tag = null, id = null } = {}) {
        return new ClipboardEntry({ mimetype, favorite, tag, bytes, id });
    }

    // --- queries -----------------------------------------------------------

    mimetype () { return this.#mimetype; }
    isText () { return !this.#isImage; }
    isImage () { return this.#isImage; }
    isFavorite () { return this.#favorite; }
    getTag () { return this.#tag; }

    /** Stable identity. Text: the text. Image: the glibHash string. */
    id () { return this.#isImage ? this.#id : this.#text; }

    /** O(1) equality key — matches the legacy getStringValue() comparison. */
    key () { return this.#stringValue; }

    getStringValue () { return this.#stringValue; }

    /** Raw image bytes if loaded, else null. Text entries return null. */
    bytes () { return this.#isImage ? this.#bytes : null; }

    equals (other) {
        return !!other && this.#stringValue === other.getStringValue();
    }

    // --- mutations ---------------------------------------------------------

    set favorite (val) { this.#favorite = !!val; this.#serializedCache = null; }
    setFavorite (val) { this.#favorite = !!val; this.#serializedCache = null; }

    setTag (tag) { this.#tag = tag || null; this.#serializedCache = null; }

    /** Replace text content (text entries only). */
    setText (text) {
        if (this.#isImage) return;
        this.#text = text != null ? text : '';
        this.#stringValue = this.#text;
        this.#serializedCache = null;
    }

    /** Attach lazily-loaded image bytes (does not change identity). */
    setBytes (bytes) {
        if (this.#isImage) this.#bytes = bytes;
        // bytes do not affect registry record — no cache invalidation needed
    }

    // --- registry (de)serialization — pure, format-compatible --------------

    /**
     * Produce the plain object stored in registry.txt.
     * Text entries store their text in `contents`; image entries store the
     * absolute cache file path (`${registryDir}/${id}`), exactly as before.
     */
    toRegistryRecord (registryDir) {
        const record = { favorite: this.#favorite, mimetype: this.#mimetype };
        if (this.#isImage) {
            record.contents = `${registryDir}/${this.#id}`;
        } else {
            record.contents = this.#text;
        }
        if (this.#tag) record.tag = this.#tag;
        return record;
    }

    /**
     * Return the JSON string for this entry's registry record, caching the
     * result per registryDir.  The cache is invalidated whenever the entry
     * mutates (setText / setTag / setFavorite / set favorite).
     *
     * Used by GioRegistryStorage to build registry.txt incrementally so that
     * only changed entries need re-stringifying.
     *
     * @param {string} registryDir
     * @returns {string}
     */
    serializedRecord (registryDir) {
        if (this.#serializedCache === null) {
            this.#serializedCache = new Map();
        }
        let cached = this.#serializedCache.get(registryDir);
        if (cached === undefined) {
            cached = JSON.stringify(this.toRegistryRecord(registryDir));
            this.#serializedCache.set(registryDir, cached);
        }
        return cached;
    }

    /**
     * Reconstruct an entry from a registry.txt record. Image bytes are left
     * lazy (null) — only the identity (filename) is needed for the model.
     */
    static fromRegistryRecord (record) {
        const mimetype = record.mimetype || DEFAULT_MIMETYPE;
        const favorite = !!record.favorite;
        const tag = record.tag || null;

        if (mimeIsText(mimetype)) {
            return new ClipboardEntry({ mimetype, favorite, tag, text: record.contents });
        }
        // image — identity is the cache filename
        return new ClipboardEntry({ mimetype, favorite, tag, id: basename(record.contents) });
    }
}
