/* StTextureImage — ImageRenderPort adapter for the live GNOME Shell.
 *
 * Wraps the two image-loading patterns extracted from registry.js:
 *
 *   loadThumbnail(idOrPath, sizePx)
 *     → Gio.icon_new_for_string(path) + new St.Icon({ gicon })
 *       (same as Registry.getEntryAsImage)
 *
 *   loadTexture(idOrPath)
 *     → St.TextureCache.get_default().load_file_async(...)
 *       (same as Registry.getEntryAsTexture)
 *
 * `idOrPath` may be:
 *   - an absolute path:      used directly
 *   - a glibHash id string:  resolved as `<registryDir>/<id>`
 *     (registryDir is passed to the constructor)
 *
 * Both methods return a Promise to stay consistent with the port contract and
 * to allow callers to chain .then() without caring whether the operation is
 * synchronous or async.
 *
 * NOTE: This file may NOT be unit-tested headless (imports gi://St, gi://Gio).
 */

import Gio from 'gi://Gio';
import St from 'gi://St';

import { ImageRenderPort } from '../ports/ImageRenderPort.js';

export class StTextureImage extends ImageRenderPort {
    /** Absolute path to the image cache directory (REGISTRY_DIR). */
    #registryDir;

    /**
     * @param {string} registryDir - absolute path to the cache dir,
     *   e.g. GLib.get_user_cache_dir() + '/clipboard-indicator@tudmotu.com'
     */
    constructor (registryDir) {
        super();
        this.#registryDir = registryDir;
    }

    /**
     * Resolve `idOrPath` to an absolute file path.
     * If the value starts with '/' it is treated as an absolute path directly.
     * Otherwise it is treated as a glibHash id and appended to registryDir.
     *
     * @param {string} idOrPath
     * @returns {string} absolute path
     */
    #resolvePath (idOrPath) {
        if (idOrPath.startsWith('/')) {
            return idOrPath;
        }
        return `${this.#registryDir}/${idOrPath}`;
    }

    /**
     * Load a thumbnail St.Icon.
     * Uses Gio.icon_new_for_string, which honours the image at the given path
     * and lets GNOME Shell scale it to sizePx via the St icon-size CSS property.
     *
     * sizePx is set on the returned icon via icon_size so callers do not need
     * to set it separately; they may still override it via CSS.
     *
     * @param {string} idOrPath
     * @param {number} sizePx
     * @returns {Promise<St.Icon>}
     */
    async loadThumbnail (idOrPath, sizePx) {
        const path = this.#resolvePath(idOrPath);
        const gicon = Gio.icon_new_for_string(path);
        const stIcon = new St.Icon({
            gicon,
            icon_size: sizePx,
        });
        return stIcon;
    }

    /**
     * Load a full-resolution Clutter.Actor via St.TextureCache.
     *
     * Uses the same call as Registry.getEntryAsTexture:
     *   St.TextureCache.get_default().load_file_async(file, -1, -1, scaleFactor, 1.0)
     *
     * The scale factor is read from the default stage theme context so HiDPI
     * displays get the correct physical pixel resolution.
     *
     * @param {string} idOrPath
     * @returns {Promise<Clutter.Actor>}
     */
    async loadTexture (idOrPath) {
        const path = this.#resolvePath(idOrPath);
        const file = Gio.file_new_for_path(path);
        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        // load_file_async returns a ClutterActor (Content is set asynchronously).
        const actor = St.TextureCache.get_default().load_file_async(
            file,
            -1,       // width  (-1 = natural)
            -1,       // height (-1 = natural)
            scaleFactor,
            1.0       // pixel_ratio
        );
        return actor;
    }
}
