/* CacheGC — pure, no gi imports.
 *
 * Computes which image cache files are ORPHANS (safe to delete) given:
 *   (a) the set of basenames currently on disk in REGISTRY_DIR, and
 *   (b) the set of ids (glibHash basenames) referenced by live registry entries.
 *
 * No filesystem I/O is performed here — the caller supplies both inputs and
 * hands the returned `orphans` list to an adapter for actual deletion.
 *
 * Registry bookkeeping files ('registry.txt', 'registry.txt~',
 * 'registry.txt.backup') are never returned as orphans even if they appear in
 * diskFiles; the helper isBookkeepingFile() is exported so callers can filter
 * disk listings before passing them in, and for testing.
 */

/** Names that must never be deleted regardless of what the caller passes. */
const BOOKKEEPING = new Set([
    'registry.txt',
    'registry.txt~',
    'registry.txt.backup',
]);

/**
 * Returns true for the three registry bookkeeping filenames that must never
 * be treated as image cache files.
 *
 * @param {string} name  basename only (no directory component)
 * @returns {boolean}
 */
export function isBookkeepingFile (name) {
    return BOOKKEEPING.has(name);
}

/**
 * Compute which disk files can safely be deleted.
 *
 * @param {object} params
 * @param {string[]}           params.diskFiles      basenames present in REGISTRY_DIR
 * @param {string[]|Set<string>} params.referencedIds ids referenced by current registry entries
 * @param {object}             [params.options]
 * @param {string[]|Set<string>} [params.options.protect]  additional ids to never orphan
 *                                                          (e.g. favorites whose entry was just
 *                                                          removed from the visible list but whose
 *                                                          file should be retained)
 *
 * @returns {{ orphans: string[], keep: string[], stats: { totalFiles: number, referenced: number, orphanCount: number } }}
 */
export function planCacheGC ({ diskFiles, referencedIds, options = {} }) {
    // Normalise inputs to Sets for O(1) lookup.
    const referenced = referencedIds instanceof Set
        ? referencedIds
        : new Set(referencedIds);

    const protect = options.protect
        ? (options.protect instanceof Set ? options.protect : new Set(options.protect))
        : new Set();

    const orphans = [];
    const keep = [];

    for (const name of diskFiles) {
        // Bookkeeping files are always kept.
        if (BOOKKEEPING.has(name)) {
            keep.push(name);
            continue;
        }

        if (referenced.has(name) || protect.has(name)) {
            keep.push(name);
        } else {
            orphans.push(name);
        }
    }

    return {
        orphans,
        keep,
        stats: {
            totalFiles: diskFiles.length,
            referenced: referenced.size,
            orphanCount: orphans.length,
        },
    };
}
