/* Tiny zero-dependency test harness that runs under `gjs -m`.
 *
 * Pure ESM, no gi imports, so the same files run in any JS engine that
 * supports ES modules. Test files import { test, assert* } and register
 * cases by side effect; the runner (tests/run.js) imports them then calls run().
 */

const _tests = [];
let _currentSuite = '';

export function suite (name) {
    _currentSuite = name;
}

export function test (name, fn) {
    _tests.push({ name: _currentSuite ? `${_currentSuite} › ${name}` : name, fn });
}

export function assert (cond, msg) {
    if (!cond) throw new Error(`assertion failed${msg ? ': ' + msg : ''}`);
}

export function assertEqual (actual, expected, msg) {
    if (actual !== expected)
        throw new Error(`expected ${fmt(expected)} but got ${fmt(actual)}${msg ? ' — ' + msg : ''}`);
}

export function assertDeepEqual (actual, expected, msg) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e)
        throw new Error(`deep-equal failed${msg ? ' — ' + msg : ''}\n      expected ${e}\n      got      ${a}`);
}

export function assertThrows (fn, msg) {
    let threw = false;
    try { fn(); } catch { threw = true; }
    if (!threw) throw new Error(`expected function to throw${msg ? ': ' + msg : ''}`);
}

function fmt (v) {
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
}

export async function run () {
    let pass = 0;
    let fail = 0;

    for (const t of _tests) {
        try {
            await t.fn();
            pass++;
            print(`  ✓ ${t.name}`);
        } catch (e) {
            fail++;
            print(`  ✗ ${t.name}`);
            print(`      ${e.message}`);
        }
    }

    print('');
    print(`${pass} passed, ${fail} failed, ${_tests.length} total`);
    return fail;
}
