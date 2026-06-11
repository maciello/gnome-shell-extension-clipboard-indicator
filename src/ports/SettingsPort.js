/* SettingsPort — abstract contract for extension preferences.
 *
 * Mirrors the subset of Gio.Settings that the extension uses, but without any
 * gi dependency.  The production adapter wraps this.getSettings() from the
 * Extension base class; a test double can operate against a plain JS Map.
 *
 * Signal IDs returned by connect() are opaque handles valid only for the
 * lifetime of the adapter instance.  Callers must call disconnect() for each
 * connected signal before the extension is disabled to avoid leaked signal
 * handlers on the underlying Gio.Settings object.
 *
 * Key names match the GSettings schema keys defined in
 * schemas/org.gnome.shell.extensions.clipboard-indicator.gschema.xml.
 */

export class SettingsPort {
    // -------------------------------------------------------------------------
    // Readers
    // -------------------------------------------------------------------------

    /**
     * @param {string} key
     * @returns {number} 32-bit signed integer value
     */
    getInt (key) {
        throw new Error('SettingsPort.getInt() not implemented');
    }

    /**
     * @param {string} key
     * @returns {boolean}
     */
    getBoolean (key) {
        throw new Error('SettingsPort.getBoolean() not implemented');
    }

    /**
     * @param {string} key
     * @returns {string}
     */
    getString (key) {
        throw new Error('SettingsPort.getString() not implemented');
    }

    /**
     * @param {string} key
     * @returns {string[]} array of strings
     */
    getStrv (key) {
        throw new Error('SettingsPort.getStrv() not implemented');
    }

    // -------------------------------------------------------------------------
    // Writers
    // -------------------------------------------------------------------------

    /**
     * @param {string} key
     * @param {number} value - 32-bit signed integer
     * @returns {void}
     */
    setInt (key, value) {
        throw new Error('SettingsPort.setInt() not implemented');
    }

    // -------------------------------------------------------------------------
    // Change notifications
    // -------------------------------------------------------------------------

    /**
     * Subscribe to changes on a specific key.
     *
     * `signal` follows the GSettings convention: `'changed::' + key`.
     * Example: `settings.connect('changed::history-size', cb)`.
     *
     * The callback receives no arguments (the caller is expected to re-read
     * the value via the appropriate getter).
     *
     * Returns an opaque numeric ID that must be passed to disconnect() to
     * cancel the subscription.
     *
     * @param {string}   signal - e.g. 'changed::history-size'
     * @param {() => void} cb
     * @returns {number} connection ID
     */
    connect (signal, cb) {
        throw new Error('SettingsPort.connect() not implemented');
    }

    /**
     * Cancel a previously registered signal connection.
     * No-op when `id` is 0 or has already been disconnected.
     *
     * @param {number} id - value returned by connect()
     * @returns {void}
     */
    disconnect (id) {
        throw new Error('SettingsPort.disconnect() not implemented');
    }
}
