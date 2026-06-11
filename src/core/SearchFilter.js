/* SearchFilter — pure, no gi imports.
 *
 * The legacy _onSearchTextChanged compiled a new RegExp on EVERY keystroke for
 * EVERY menu item (~1000 items × N keystrokes = thousands of RegExp objects per
 * second). This module compiles exactly ONE matcher per query and reuses it for
 * every `matches()` call.
 *
 * Semantics are byte-for-byte faithful to the original:
 *   - non-regex: case-insensitive (default) substring match on text OR tag
 *   - regex:     RegExp with flags 'm' + (caseSensitive ? '' : 'i') against text OR tag
 *   - invalid regex: matches nothing (never throws to caller)
 *   - empty query: matches everything
 */

/**
 * Compile a single reusable matcher function from the given options.
 *
 * @param {object} opts
 * @param {string}  opts.query
 * @param {boolean} opts.caseSensitive
 * @param {boolean} opts.regex
 * @returns {(textOrTag: string) => boolean}
 */
export function compileMatcher ({ query, caseSensitive, regex }) {
    if (query === '' || query == null) {
        return () => true;
    }

    if (regex) {
        const flags = 'm' + (caseSensitive ? '' : 'i');
        let re;
        try {
            re = new RegExp(query, flags);
        } catch (_) {
            // Invalid pattern — matches nothing, never throws.
            return () => false;
        }
        // Reset lastIndex each call in case the regex has 'g' somehow; it doesn't
        // here (we never add 'g'), but be defensive.
        return (textOrTag) => re.test(textOrTag);
    }

    // Plain substring match — normalise needle once.
    const needle = caseSensitive ? query : query.toLowerCase();
    if (caseSensitive) {
        return (textOrTag) => textOrTag.includes(needle);
    }
    return (textOrTag) => textOrTag.toLowerCase().includes(needle);
}

export class SearchFilter {
    #caseSensitive;
    #regex;
    #query;
    #matcher;   // (textOrTag: string) => boolean, compiled once per setQuery/setOptions

    /**
     * @param {object} [opts]
     * @param {boolean} [opts.caseSensitive=false]
     * @param {boolean} [opts.regex=false]
     */
    constructor ({ caseSensitive = false, regex = false } = {}) {
        this.#caseSensitive = !!caseSensitive;
        this.#regex = !!regex;
        this.#query = '';
        this.#matcher = () => true;   // empty query — match all
    }

    /**
     * Set the search query and compile the matcher exactly once.
     * @param {string} text
     */
    setQuery (text) {
        this.#query = text != null ? text : '';
        this.#matcher = compileMatcher({
            query: this.#query,
            caseSensitive: this.#caseSensitive,
            regex: this.#regex,
        });
    }

    /**
     * Update options and recompile against the current query.
     * @param {object} opts
     * @param {boolean} [opts.caseSensitive]
     * @param {boolean} [opts.regex]
     */
    setOptions ({ caseSensitive, regex } = {}) {
        if (caseSensitive !== undefined) this.#caseSensitive = !!caseSensitive;
        if (regex !== undefined) this.#regex = !!regex;
        this.#matcher = compileMatcher({
            query: this.#query,
            caseSensitive: this.#caseSensitive,
            regex: this.#regex,
        });
    }

    /**
     * Test whether an entry matches the current query.
     *
     * Faithful to the original: checks text OR tag; tag may be '' or null.
     *
     * @param {object} item
     * @param {string}  item.text   — the display text of the clipboard entry
     * @param {string}  [item.tag]  — the tag string (may be '' or null/undefined)
     * @returns {boolean}
     */
    matches ({ text, tag }) {
        const t = text != null ? text : '';
        const g = tag != null ? tag : '';
        return this.#matcher(t) || this.#matcher(g);
    }
}
