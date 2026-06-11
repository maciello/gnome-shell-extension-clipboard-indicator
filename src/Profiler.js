/* Profiler — zero-overhead-when-disabled timing helper.
 *
 * Enabled only when the env var CLIPBOARD_INDICATOR_PROFILE is set (to any
 * non-empty value).  When disabled, time(label, fn) simply calls fn() and
 * returns its result with no extra work.
 *
 * When enabled, time() measures wall-clock duration via
 * GLib.get_monotonic_time() (microseconds) and appends a line
 *   '<label> <ms>ms\n'
 * to <cache>/clipboard-indicator@tudmotu.com/profile.log on a best-effort
 * basis (any I/O error is swallowed so profiling never breaks the extension).
 *
 * time() transparently supports both synchronous and Promise-returning fns:
 * if fn() returns a thenable, the measurement is taken when the promise
 * settles; otherwise it is taken synchronously.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const UUID = 'clipboard-indicator@tudmotu.com';

export class Profiler {
    /** @type {boolean} */
    #enabled;
    /** @type {string} */
    #logPath;
    /** Lazily-resolved Gio.File for the log; null until first write. */
    #logFile = null;
    /** Whether the cache dir has been ensured. */
    #dirReady = false;

    constructor () {
        this.#enabled = !!GLib.getenv('CLIPBOARD_INDICATOR_PROFILE');
        this.#logPath = GLib.get_user_cache_dir() + '/' + UUID + '/profile.log';
    }

    get enabled () {
        return this.#enabled;
    }

    /**
     * Time the execution of `fn`. When profiling is disabled this is a thin
     * pass-through: fn() is called and its result returned with no overhead.
     *
     * @template T
     * @param {string} label
     * @param {() => T} fn
     * @returns {T}
     */
    time (label, fn) {
        if (!this.#enabled) {
            return fn();
        }

        const start = GLib.get_monotonic_time();
        let result;
        try {
            result = fn();
        } catch (e) {
            this.#record(label, start);
            throw e;
        }

        // Promise-returning fn: measure when it settles.
        if (result && typeof result.then === 'function') {
            return result.then(
                value => {
                    this.#record(label, start);
                    return value;
                },
                err => {
                    this.#record(label, start);
                    throw err;
                }
            );
        }

        this.#record(label, start);
        return result;
    }

    /**
     * Append a measurement line to the log (best-effort, never throws).
     * @param {string} label
     * @param {number} startMicros
     */
    #record (label, startMicros) {
        try {
            const elapsedMicros = GLib.get_monotonic_time() - startMicros;
            const ms = (elapsedMicros / 1000).toFixed(2);
            this.#append(`${label} ${ms}ms\n`);
        } catch (_) {
            // best-effort: ignore
        }
    }

    /**
     * Best-effort append of a line to profile.log.
     * @param {string} line
     */
    #append (line) {
        try {
            if (!this.#dirReady) {
                GLib.mkdir_with_parents(
                    GLib.get_user_cache_dir() + '/' + UUID,
                    parseInt('0775', 8)
                );
                this.#dirReady = true;
            }
            if (this.#logFile === null) {
                this.#logFile = Gio.File.new_for_path(this.#logPath);
            }

            const stream = this.#logFile.append_to(
                Gio.FileCreateFlags.NONE,
                null
            );
            const bytes = new TextEncoder().encode(line);
            stream.write_all(bytes, null);
            stream.close(null);
        } catch (_) {
            // best-effort: ignore all I/O errors
        }
    }
}
