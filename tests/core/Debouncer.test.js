/* tests/core/Debouncer.test.js
 *
 * Deterministic tests for Debouncer using a FakeScheduler — no real timers,
 * no gi imports, runs under plain gjs or any ES-module-capable JS engine.
 */

import { suite, test, assert, assertEqual, assertDeepEqual, assertThrows } from '../harness.js';
import { Debouncer, makeDebouncer } from '../../src/core/Debouncer.js';

// ---------------------------------------------------------------------------
// FakeScheduler — lives here so the module stays free of any timer API.
//
// Timers are stored as { id, fireAt, cb, cancelled } entries.
// advance(ms) moves the clock forward and fires every callback whose fireAt
// has been reached, in chronological order.  Firing one callback may schedule
// new timers; those are visible to subsequent advance() calls but NOT within
// the same advance() if they fire in the future.
// ---------------------------------------------------------------------------

class FakeScheduler {
    #now = 0;
    #nextId = 1;
    #timers = [];   // { id, fireAt, cb, cancelled }

    get now () { return this.#now; }

    setTimer (ms, cb) {
        const id = this.#nextId++;
        this.#timers.push({ id, fireAt: this.#now + ms, cb, cancelled: false });
        return id;
    }

    clearTimer (id) {
        const t = this.#timers.find(t => t.id === id);
        if (t) t.cancelled = true;
    }

    /**
     * Advance the fake clock by `ms` milliseconds.
     * Fires all non-cancelled timers whose fireAt <= new now, in order.
     * Returns the number of callbacks that actually ran.
     */
    advance (ms) {
        this.#now += ms;
        let fired = 0;
        // Sort so we fire in chronological order each pass.
        // After each fire a new timer might be added, so we loop until stable.
        let found = true;
        while (found) {
            found = false;
            // Sort ascending by fireAt to process earliest-first.
            this.#timers.sort((a, b) => a.fireAt - b.fireAt);
            for (const t of this.#timers) {
                if (!t.cancelled && t.fireAt <= this.#now && !t._fired) {
                    t._fired = true;
                    found = true;
                    fired++;
                    t.cb();
                    break; // restart loop so newly added timers are visible
                }
            }
        }
        return fired;
    }

    /** How many un-cancelled, un-fired timers are waiting. */
    get pendingCount () {
        return this.#timers.filter(t => !t.cancelled && !t._fired).length;
    }

    /** Reset all state (useful between tests). */
    reset () {
        this.#now = 0;
        this.#nextId = 1;
        this.#timers = [];
    }
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeSetup (delayMs = 200, leading = false) {
    const sched = new FakeScheduler();
    const db = new Debouncer({ delayMs, scheduler: sched, leading });
    const calls = [];
    db.setAction(payload => calls.push(payload));
    return { sched, db, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('Debouncer');

// --- construction -----------------------------------------------------------

test('throws on invalid delayMs', () => {
    const sched = new FakeScheduler();
    assertThrows(() => new Debouncer({ delayMs: -1, scheduler: sched }));
    assertThrows(() => new Debouncer({ delayMs: 'x', scheduler: sched }));
});

test('throws on missing / bad scheduler', () => {
    assertThrows(() => new Debouncer({ delayMs: 100, scheduler: null }));
    assertThrows(() => new Debouncer({ delayMs: 100, scheduler: {} }));
    assertThrows(() => new Debouncer({ delayMs: 100, scheduler: { setTimer: () => {} } }));
});

test('setAction throws on non-function', () => {
    const sched = new FakeScheduler();
    const db = new Debouncer({ delayMs: 100, scheduler: sched });
    assertThrows(() => db.setAction('not a function'));
});

// --- basic trailing-edge behaviour ------------------------------------------

test('action fires after delay', () => {
    const { sched, db, calls } = makeSetup(200);
    db.schedule('a');
    assertEqual(calls.length, 0, 'not fired yet');
    sched.advance(199);
    assertEqual(calls.length, 0, 'still not fired at 199ms');
    sched.advance(1);   // total: 200ms
    assertEqual(calls.length, 1, 'fired at 200ms');
    assertEqual(calls[0], 'a');
});

test('multiple schedule() within window coalesces to ONE firing', () => {
    const { sched, db, calls } = makeSetup(200);
    db.schedule('first');
    sched.advance(100);     // 100ms in — timer not fired
    db.schedule('second');
    sched.advance(100);     // 200ms total, but the window reset at 100ms
    assertEqual(calls.length, 0, 'window reset, not fired yet');
    sched.advance(100);     // 300ms total = 200ms after last schedule()
    assertEqual(calls.length, 1, 'fired exactly once');
    assertEqual(calls[0], 'second', 'latest payload delivered');
});

test('latest payload is delivered (not first)', () => {
    const { sched, db, calls } = makeSetup(100);
    db.schedule('p1');
    db.schedule('p2');
    db.schedule('p3');
    sched.advance(100);
    assertEqual(calls.length, 1);
    assertEqual(calls[0], 'p3');
});

test('schedule with no payload delivers undefined', () => {
    const { sched, db, calls } = makeSetup(100);
    db.schedule();
    sched.advance(100);
    assertEqual(calls.length, 1);
    assertEqual(calls[0], undefined);
});

// --- pending flag -----------------------------------------------------------

test('pending is false before any schedule()', () => {
    const { db } = makeSetup();
    assertEqual(db.pending, false);
});

test('pending is true after schedule() and false after timer fires', () => {
    const { sched, db } = makeSetup(100);
    db.schedule('x');
    assertEqual(db.pending, true);
    sched.advance(100);
    assertEqual(db.pending, false);
});

test('pending is false after cancel()', () => {
    const { db } = makeSetup(100);
    db.schedule('x');
    db.cancel();
    assertEqual(db.pending, false);
});

test('pending is false after flush()', () => {
    const { db } = makeSetup(100);
    db.schedule('x');
    db.flush();
    assertEqual(db.pending, false);
});

// --- flush ------------------------------------------------------------------

test('flush runs action immediately', () => {
    const { sched, db, calls } = makeSetup(1000);
    db.schedule('payload');
    sched.advance(50);  // well before the timer fires
    assertEqual(calls.length, 0);
    db.flush();
    assertEqual(calls.length, 1, 'action ran synchronously');
    assertEqual(calls[0], 'payload');
});

test('flush cancels the pending timer (no double-fire)', () => {
    const { sched, db, calls } = makeSetup(100);
    db.schedule('x');
    db.flush();
    sched.advance(100);     // timer would have fired here
    assertEqual(calls.length, 1, 'only one invocation total');
});

test('flush on no pending is a no-op', () => {
    const { db, calls } = makeSetup(100);
    db.flush();   // nothing pending
    assertEqual(calls.length, 0);
});

// --- cancel -----------------------------------------------------------------

test('cancel prevents action from running', () => {
    const { sched, db, calls } = makeSetup(100);
    db.schedule('x');
    db.cancel();
    sched.advance(200);
    assertEqual(calls.length, 0, 'action must not run after cancel');
});

test('cancel then schedule works normally', () => {
    const { sched, db, calls } = makeSetup(100);
    db.schedule('a');
    db.cancel();
    db.schedule('b');
    sched.advance(100);
    assertEqual(calls.length, 1);
    assertEqual(calls[0], 'b');
});

// --- multiple windows -------------------------------------------------------

test('fires independently across separate windows', () => {
    const { sched, db, calls } = makeSetup(100);
    db.schedule('w1');
    sched.advance(100);     // fires first window
    assertEqual(calls.length, 1);
    db.schedule('w2');
    sched.advance(100);     // fires second window
    assertEqual(calls.length, 2);
    assertEqual(calls[1], 'w2');
});

// --- no action set ----------------------------------------------------------

test('fires without action set is a no-op (no throw)', () => {
    const sched = new FakeScheduler();
    const db = new Debouncer({ delayMs: 50, scheduler: sched });
    db.schedule('x');       // no setAction called
    sched.advance(50);      // must not throw
    assertEqual(db.pending, false);
});

// --- leading-edge -----------------------------------------------------------

test('leading=true fires immediately on first schedule()', () => {
    const sched = new FakeScheduler();
    const db = new Debouncer({ delayMs: 200, scheduler: sched, leading: true });
    const calls = [];
    db.setAction(p => calls.push(p));

    db.schedule('first');
    assertEqual(calls.length, 1, 'leading edge fires immediately');
    assertEqual(calls[0], 'first');
});

test('leading=true: repeated schedule() within window does NOT re-fire', () => {
    const sched = new FakeScheduler();
    const db = new Debouncer({ delayMs: 200, scheduler: sched, leading: true });
    const calls = [];
    db.setAction(p => calls.push(p));

    db.schedule('a');
    db.schedule('b');
    db.schedule('c');
    sched.advance(200);     // trailing timer clears state
    assertEqual(calls.length, 1, 'leading fires once per window');
});

test('leading=true: new window fires again after previous settles', () => {
    const sched = new FakeScheduler();
    const db = new Debouncer({ delayMs: 100, scheduler: sched, leading: true });
    const calls = [];
    db.setAction(p => calls.push(p));

    db.schedule('x');
    sched.advance(100);     // window closed
    db.schedule('y');       // new window — leading fires again
    assertEqual(calls.length, 2);
    assertEqual(calls[1], 'y');
});

// --- makeDebouncer factory --------------------------------------------------

test('makeDebouncer returns a Debouncer instance', () => {
    const sched = new FakeScheduler();
    const db = makeDebouncer({ delayMs: 50, scheduler: sched });
    assert(db instanceof Debouncer, 'is a Debouncer');
    assert(typeof db.schedule === 'function');
    assert(typeof db.flush === 'function');
    assert(typeof db.cancel === 'function');
    assert(typeof db.setAction === 'function');
    assert('pending' in db);
});

// --- zero delay -------------------------------------------------------------

test('delayMs=0 fires after zero-delay timer is advanced', () => {
    const sched = new FakeScheduler();
    const db = new Debouncer({ delayMs: 0, scheduler: sched });
    const calls = [];
    db.setAction(p => calls.push(p));
    db.schedule('z');
    assertEqual(calls.length, 0, 'not fired synchronously');
    sched.advance(0);
    assertEqual(calls.length, 1, 'fired after 0ms advance');
    assertEqual(calls[0], 'z');
});

// --- payload types ----------------------------------------------------------

test('object payload is passed through unmodified', () => {
    const { sched, db, calls } = makeSetup(50);
    const snapshot = { entries: [1, 2, 3], version: 7 };
    db.schedule(snapshot);
    sched.advance(50);
    assert(calls[0] === snapshot, 'same object reference');
});
