/* ImageRenderPort — abstract contract for creating GNOME Shell UI actors from
 * image data.
 *
 * The production adapter wraps Clutter.Texture / St.Icon / GdkPixbuf and is
 * only ever instantiated inside the live shell.  Core business logic and tests
 * never touch this port's implementation — only its interface.
 *
 * Both methods return a Promise so the adapter can load bytes from disk or
 * decode a pixbuf asynchronously without blocking the main loop.
 *
 * `id` is a glibHash string (the same identity used in StoragePort and
 * ClipboardEntry).  `path` is an absolute filesystem path.  Callers pass
 * either form; implementations accept both.
 */

export class ImageRenderPort {
    /**
     * Load a scaled-down thumbnail actor suitable for display in a menu item.
     *
     * The returned value is an opaque actor/icon object; callers only pass it
     * to St.Icon / St.Button / Clutter.Actor APIs.  The core never inspects or
     * mutates it.
     *
     * @param {string} idOrPath - glibHash id string OR absolute file path
     * @param {number} sizePx   - desired side length in logical pixels
     * @returns {Promise<object>} Clutter actor or GIcon — opaque to the core
     */
    async loadThumbnail (idOrPath, sizePx) {
        throw new Error('ImageRenderPort.loadThumbnail() not implemented');
    }

    /**
     * Load a full-resolution texture actor (e.g. for the enlarged preview
     * shown when hovering over a history item).
     *
     * @param {string} idOrPath - glibHash id string OR absolute file path
     * @returns {Promise<object>} Clutter actor — opaque to the core
     */
    async loadTexture (idOrPath) {
        throw new Error('ImageRenderPort.loadTexture() not implemented');
    }
}
