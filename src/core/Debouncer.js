/* Debouncer — pure, no gi imports.
 *
 * Coalesces rapid calls into a single deferred action. Designed for the
 * registry-write path so that a burst of copy events produces ONE disk write
 * after the burst settles, rather than one write per keystroke.
 *
 * Timer machinery is dependency-injected via a `scheduler` object:
 *
 *   { setTimer(delayMs, callback) -> handle,
 *     clearTimer(handle) -> void }
 *
 * This keeps the core free of any platform timer API (GLib.timeout_add,
 * setTimeout, …) and lets unit tests use a FakeScheduler with manual time
 * advancement — fully deterministic, no real async required.
 *
 * Usage (production):
 *   const scheduler = {
 *       setTimer:   (ms, cb) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { cb(); return GLib.SOURCE_REMOVE; }),
 *       clearTimer: (h)      => GLib.source_remove(h),
 *   };
 *   const debouncedWrite = new Debouncer({ delayMs: 500, scheduler });
 *   debouncedWrite.setAction(payload => registry.save(payload));
 *   // … on every copy:
 *   debouncedWrite.schedule(historySnapshot);
 *   // … on extension disable:
 *   debouncedWrite.flush();
 */

export class Debouncer {
    #delayMs;
    #scheduler;
    #leading;
    #action;
    #handle;
    #pendingPayload;
    #hasPending;
    #leadingFired;

    /**
     * @param {object} opts
     * @param {number}  opts.delayMs    - milliseconds to wait after the last schedule() call
     * @param {object}  opts.scheduler  - { setTimer(ms, cb)->handle, clearTimer(handle) }
     * @param {boolean} [opts.leading]  - if true, fire on the LEADING edge too (default: false)
     */
    constructor ({ delayMs, scheduler, leading = false }) {
        if (typeof delayMs !== 'number' || delayMs < 0)
            throw new TypeError('delayMs must be a non-negative number');
        if (!scheduler || typeof scheduler.setTimer !== 'function' || typeof scheduler.clearTimer !== 'function')
            throw new TypeError('scheduler must have setTimer and clearTimer methods');

        this.#delayMs = delayMs;
        this.#scheduler = scheduler;
        this.#leading = leading;
        this.#action = null;
        this.#handle = null;
        this.#hasPending = false;
        this.#leadingFired = false;
    }

    /**
     * Register or replace the action that fires on debounce.
     * @param {function} fn - called with the latest payload when the timer fires
     */
    setAction (fn) {
        if (typeof fn !== 'function')
            throw new TypeError('action must be a function');
        this.#action = fn;
    }

    /**
     * (Re)start the debounce window.  The latest `payload` will be passed to
     * the action when it eventually fires.  Calling schedule() again before
     * the timer fires resets the countdown (trailing-edge behaviour).
     * @param {*} [payload]
     */
    schedule (payload) {
        // Store the latest payload regardless.
        this.#pendingPayload = payload;

        if (this.#leading && !this.#leadingFired) {
            // Leading edge: fire immediately on the FIRST call in the window.
            this.#leadingFired = true;
            this.#fire();
        }

        // (Re)start the trailing timer.
        if (this.#handle !== null) {
            this.#scheduler.clearTimer(this.#handle);
            this.#handle = null;
        }

        this.#hasPending = true;
        this.#handle = this.#scheduler.setTimer(this.#delayMs, () => {
            this.#handle = null;
            this.#hasPending = false;
            this.#leadingFired = false;
            if (!this.#leading) {
                // Trailing edge: fire NOW.
                this.#fire();
            }
            // Leading edge: trailing callback just clears state; action already fired.
        });
    }

    /**
     * Run the pending action immediately (if any) and cancel the timer.
     * Useful for extension disable / final flush before cleanup.
     */
    flush () {
        if (!this.#hasPending) return;
        this.#cancelTimer();
        this.#hasPending = false;
        this.#leadingFired = false;
        this.#fire();
    }

    /**
     * Cancel the pending timer and discard the payload without running the action.
     */
    cancel () {
        this.#cancelTimer();
        this.#hasPending = false;
        this.#leadingFired = false;
        this.#pendingPayload = undefined;
    }

    /**
     * True if a timer is currently pending (i.e. schedule() was called and the
     * action has not yet fired or been cancelled/flushed).
     * @returns {boolean}
     */
    get pending () {
        return this.#hasPending;
    }

    // --- private ---

    #fire () {
        if (typeof this.#action === 'function') {
            this.#action(this.#pendingPayload);
        }
    }

    #cancelTimer () {
        if (this.#handle !== null) {
            this.#scheduler.clearTimer(this.#handle);
            this.#handle = null;
        }
    }
}

/**
 * Convenience factory — same as `new Debouncer(opts)` but chainable.
 * @param {object} opts - same as Debouncer constructor
 * @returns {Debouncer}
 */
export function makeDebouncer (opts) {
    return new Debouncer(opts);
}
