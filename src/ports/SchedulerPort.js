/* SchedulerPort — abstract contract for timer and idle scheduling.
 *
 * This interface is intentionally minimal so that:
 *   - Debouncer (and any other pure core that needs timers) can accept an
 *     injected scheduler rather than hard-coding GLib.timeout_add.
 *   - Unit tests can use a FakeScheduler that advances time deterministically
 *     without real async delays.
 *
 * The `{ setTimer, clearTimer }` subset is the shape Debouncer already expects
 * (documented in Debouncer.js); SchedulerPort adds `idle()` for lower-priority
 * work that should yield to user interaction.
 *
 * Production adapter maps:
 *   setTimer  -> GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, ...)
 *   clearTimer-> GLib.source_remove(handle)
 *   idle      -> GLib.idle_add(GLib.PRIORITY_LOW, ...)
 */

export class SchedulerPort {
    /**
     * Schedule `cb` to run after at least `ms` milliseconds.
     * Returns an opaque handle that can be passed to clearTimer().
     *
     * The callback is invoked exactly once.  Implementations must ensure the
     * returned handle remains valid until the callback fires or clearTimer() is
     * called, whichever comes first.
     *
     * @param {number}   ms - delay in milliseconds (>= 0)
     * @param {() => void} cb
     * @returns {*} handle — opaque, do not inspect
     */
    setTimer (ms, cb) {
        throw new Error('SchedulerPort.setTimer() not implemented');
    }

    /**
     * Cancel a previously scheduled timer.
     * No-op when `handle` has already fired or been cancelled.
     *
     * @param {*} handle - value returned by setTimer()
     * @returns {void}
     */
    clearTimer (handle) {
        throw new Error('SchedulerPort.clearTimer() not implemented');
    }

    /**
     * Schedule `cb` to run during the next idle period (i.e. when the main
     * loop has no higher-priority work).  Suitable for non-urgent work that
     * must not block user interaction (e.g. menu item creation, GC passes).
     *
     * Returns an opaque handle that can be passed to clearTimer() to cancel
     * before the callback fires.
     *
     * The callback is invoked exactly once.
     *
     * @param {() => void} cb
     * @returns {*} handle — opaque, compatible with clearTimer()
     */
    idle (cb) {
        throw new Error('SchedulerPort.idle() not implemented');
    }
}
