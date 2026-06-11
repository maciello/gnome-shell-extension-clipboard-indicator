/* GSettings — SettingsPort adapter backed by a Gio.Settings instance.
 *
 * This is a thin, transparent wrapper.  The caller is responsible for
 * constructing the Gio.Settings instance (e.g. via Extension.getSettings())
 * and passing it in.  The adapter owns no additional resources beyond the
 * signal IDs it registers, which it cleans up via destroy().
 *
 * Methods map 1-to-1 to Gio.Settings methods:
 *   getInt     → get_int
 *   getBoolean → get_boolean
 *   getString  → get_string
 *   getStrv    → get_strv
 *   setInt     → set_int
 *   connect    → connect      (same signal name convention, e.g. 'changed::key')
 *   disconnect → disconnect
 *
 * destroy() disconnects all signals registered via connect() through this
 * adapter, matching the lifecycle of the extension disable() call.
 *
 * NOTE: This file may NOT be unit-tested headless (Gio.Settings requires
 * a compiled GSettings schema installed on the system).
 */

import { SettingsPort } from '../ports/SettingsPort.js';

export class GSettings extends SettingsPort {
    /** @type {object} Gio.Settings instance */
    #settings;

    /** @type {Set<number>} connection IDs registered via this adapter */
    #connectionIds = new Set();

    /**
     * @param {object} gioSettings - a Gio.Settings instance
     */
    constructor (gioSettings) {
        super();
        this.#settings = gioSettings;
    }

    // -------------------------------------------------------------------------
    // Readers
    // -------------------------------------------------------------------------

    /**
     * @param {string} key
     * @returns {number}
     */
    getInt (key) {
        return this.#settings.get_int(key);
    }

    /**
     * @param {string} key
     * @returns {boolean}
     */
    getBoolean (key) {
        return this.#settings.get_boolean(key);
    }

    /**
     * @param {string} key
     * @returns {string}
     */
    getString (key) {
        return this.#settings.get_string(key);
    }

    /**
     * @param {string} key
     * @returns {string[]}
     */
    getStrv (key) {
        return this.#settings.get_strv(key);
    }

    // -------------------------------------------------------------------------
    // Writers
    // -------------------------------------------------------------------------

    /**
     * @param {string} key
     * @param {number} value - 32-bit signed integer
     */
    setInt (key, value) {
        this.#settings.set_int(key, value);
    }

    // -------------------------------------------------------------------------
    // Change notifications
    // -------------------------------------------------------------------------

    /**
     * Subscribe to a settings signal (e.g. 'changed::history-size').
     * The returned ID can be passed to disconnect() to cancel.
     *
     * @param {string}     signal
     * @param {() => void} cb
     * @returns {number} connection ID
     */
    connect (signal, cb) {
        const id = this.#settings.connect(signal, cb);
        this.#connectionIds.add(id);
        return id;
    }

    /**
     * Disconnect a previously registered signal.
     * No-op when id is 0 or already disconnected.
     *
     * @param {number} id
     */
    disconnect (id) {
        if (!id) return;
        this.#connectionIds.delete(id);
        try {
            this.#settings.disconnect(id);
        } catch (e) {
            console.warn(`GSettings.disconnect: could not disconnect id ${id}: ${e}`);
        }
    }

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    /**
     * Disconnect all signals registered through this adapter.
     * Call once during extension disable().
     */
    destroy () {
        for (const id of this.#connectionIds) {
            try {
                this.#settings.disconnect(id);
            } catch (e) {
                console.warn(`GSettings.destroy: could not disconnect id ${id}: ${e}`);
            }
        }
        this.#connectionIds.clear();
    }
}
