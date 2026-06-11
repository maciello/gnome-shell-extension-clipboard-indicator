/* GLibScheduler — SchedulerPort adapter backed by GLib main-loop sources.
 *
 * Maps:
 *   setTimer(ms, cb)  → GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, once-cb)
 *   clearTimer(id)    → GLib.Source.remove(id), guarded against double-remove
 *   idle(cb)          → GLib.idle_add(GLib.PRIORITY_LOW, once-cb)
 *   destroy()         → removes all outstanding sources
 *
 * All IDs are tracked in a Set so destroy() can sweep up leaks even if callers
 * forget to clearTimer().  The Set entries are removed as each source fires or
 * is explicitly cancelled.
 *
 * NOTE: This file may NOT be unit-tested headless (imports gi://GLib).
 */

import GLib from 'gi://GLib';

import { SchedulerPort } from '../ports/SchedulerPort.js';

export class GLibScheduler extends SchedulerPort {
    /** @type {Set<number>} live GLib source IDs */
    #ids = new Set();

    /**
     * Schedule cb after at least ms milliseconds (fires once).
     *
     * @param {number}     ms
     * @param {() => void} cb
     * @returns {number} GLib source ID (opaque handle)
     */
    setTimer (ms, cb) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this.#ids.delete(id);
            cb();
            return GLib.SOURCE_REMOVE;
        });
        this.#ids.add(id);
        return id;
    }

    /**
     * Cancel a pending timer.  No-op if already fired or unknown.
     *
     * @param {number} id - value returned by setTimer() or idle()
     */
    clearTimer (id) {
        if (id == null) return;
        if (!this.#ids.has(id)) return;  // already fired or already cancelled
        this.#ids.delete(id);
        try {
            GLib.Source.remove(id);
        } catch (e) {
            // Guard: GLib throws if the source ID is stale.  Log and move on.
            console.warn(`GLibScheduler.clearTimer: could not remove source ${id}: ${e}`);
        }
    }

    /**
     * Schedule cb during the next idle slot (GLib.PRIORITY_LOW, fires once).
     *
     * @param {() => void} cb
     * @returns {number} GLib source ID, compatible with clearTimer()
     */
    idle (cb) {
        const id = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this.#ids.delete(id);
            cb();
            return GLib.SOURCE_REMOVE;
        });
        this.#ids.add(id);
        return id;
    }

    /**
     * Remove all outstanding timer and idle sources.
     * Call once during extension disable.
     */
    destroy () {
        for (const id of this.#ids) {
            try {
                GLib.Source.remove(id);
            } catch (e) {
                console.warn(`GLibScheduler.destroy: could not remove source ${id}: ${e}`);
            }
        }
        this.#ids.clear();
    }
}
