/* Tests for src/core/SearchFilter.js — pure, no gi imports. */

import { suite, test, assert, assertEqual } from '../harness.js';
import { SearchFilter, compileMatcher } from '../../src/core/SearchFilter.js';

suite('compileMatcher');

test('empty query matches everything', () => {
    const m = compileMatcher({ query: '', caseSensitive: false, regex: false });
    assert(m('hello'), 'non-empty string');
    assert(m(''), 'empty string');
});

test('null/undefined query matches everything', () => {
    const m = compileMatcher({ query: null, caseSensitive: false, regex: false });
    assert(m('anything'));
});

test('plain substring — case-insensitive by default', () => {
    const m = compileMatcher({ query: 'Hello', caseSensitive: false, regex: false });
    assert(m('say hello world'), 'lowercase match');
    assert(m('HELLO THERE'), 'uppercase match');
    assert(!m('goodbye'), 'non-matching');
});

test('plain substring — case-sensitive', () => {
    const m = compileMatcher({ query: 'Hello', caseSensitive: true, regex: false });
    assert(m('say Hello world'), 'exact case match');
    assert(!m('say hello world'), 'lowercase should not match');
    assert(!m('SAY HELLO WORLD'), 'uppercase should not match');
});

test('regex mode — basic pattern', () => {
    const m = compileMatcher({ query: '^foo', caseSensitive: false, regex: true });
    assert(m('foobar'), 'starts-with match');
    assert(!m('barfoo'), 'not starting with foo');
});

test('regex mode — case-insensitive by default', () => {
    const m = compileMatcher({ query: 'FOO', caseSensitive: false, regex: true });
    assert(m('foobar'), 'lowercase content');
    assert(m('FOOBAR'), 'uppercase content');
});

test('regex mode — case-sensitive flag respected', () => {
    const m = compileMatcher({ query: 'FOO', caseSensitive: true, regex: true });
    assert(m('FOOBAR'), 'exact case');
    assert(!m('foobar'), 'lowercase should not match');
});

test('invalid regex does not throw and matches nothing', () => {
    let threw = false;
    let result;
    try {
        const m = compileMatcher({ query: '[invalid(', caseSensitive: false, regex: true });
        result = m('anything');
    } catch (_) {
        threw = true;
    }
    assert(!threw, 'must not throw');
    assert(result === false, 'invalid pattern should match nothing');
});

// ---------------------------------------------------------------------------

suite('SearchFilter — lifecycle');

test('empty query on construction matches all', () => {
    const sf = new SearchFilter();
    assert(sf.matches({ text: 'hello', tag: '' }), 'default matches');
    assert(sf.matches({ text: '', tag: '' }), 'empty text/tag');
});

test('setQuery empty string restores match-all', () => {
    const sf = new SearchFilter();
    sf.setQuery('hello');
    assert(!sf.matches({ text: 'world', tag: '' }), 'should not match before reset');
    sf.setQuery('');
    assert(sf.matches({ text: 'world', tag: '' }), 'should match-all after reset');
});

test('compile-once: matcher stable across many calls', () => {
    const sf = new SearchFilter();
    sf.setQuery('test');
    // Call matches many times — should consistently return correct results
    for (let i = 0; i < 500; i++) {
        assert(sf.matches({ text: 'this is a test string', tag: '' }), `match on iteration ${i}`);
        assert(!sf.matches({ text: 'no hit here', tag: '' }), `non-match on iteration ${i}`);
    }
});

// ---------------------------------------------------------------------------

suite('SearchFilter — substring mode');

test('case-insensitive substring match on text', () => {
    const sf = new SearchFilter({ caseSensitive: false });
    sf.setQuery('Clipboard');
    assert(sf.matches({ text: 'clipboard indicator', tag: '' }), 'lowercase text');
    assert(sf.matches({ text: 'CLIPBOARD INDICATOR', tag: '' }), 'uppercase text');
    assert(!sf.matches({ text: 'nothing related', tag: '' }), 'non-match');
});

test('case-sensitive substring match on text', () => {
    const sf = new SearchFilter({ caseSensitive: true });
    sf.setQuery('Clipboard');
    assert(sf.matches({ text: 'Clipboard Indicator', tag: '' }), 'exact case');
    assert(!sf.matches({ text: 'clipboard indicator', tag: '' }), 'lowercase mismatch');
});

test('match on tag (case-insensitive)', () => {
    const sf = new SearchFilter({ caseSensitive: false });
    sf.setQuery('important');
    assert(sf.matches({ text: 'something unrelated', tag: 'Important' }), 'tag match');
    assert(!sf.matches({ text: 'something unrelated', tag: 'routine' }), 'tag non-match');
});

test('match on tag (case-sensitive)', () => {
    const sf = new SearchFilter({ caseSensitive: true });
    sf.setQuery('Important');
    assert(sf.matches({ text: 'unrelated', tag: 'Important' }), 'exact-case tag match');
    assert(!sf.matches({ text: 'unrelated', tag: 'important' }), 'lowercase tag mismatch');
});

test('tag null/undefined treated as empty string — no crash', () => {
    const sf = new SearchFilter();
    sf.setQuery('hello');
    assert(sf.matches({ text: 'hello world', tag: null }), 'null tag');
    assert(sf.matches({ text: 'hello world', tag: undefined }), 'undefined tag');
});

test('text null/undefined treated as empty string — no crash', () => {
    const sf = new SearchFilter();
    sf.setQuery('note');
    assert(!sf.matches({ text: null, tag: '' }), 'null text, no match');
    assert(sf.matches({ text: null, tag: 'note' }), 'null text, tag matches');
});

// ---------------------------------------------------------------------------

suite('SearchFilter — regex mode');

test('regex matches text', () => {
    const sf = new SearchFilter({ regex: true });
    sf.setQuery('\\bfoo\\b');
    assert(sf.matches({ text: 'the foo bar', tag: '' }), 'word boundary match');
    assert(!sf.matches({ text: 'foobar', tag: '' }), 'not standalone word');
});

test('regex matches tag', () => {
    const sf = new SearchFilter({ regex: true });
    sf.setQuery('^work');
    assert(sf.matches({ text: 'unrelated', tag: 'work-item' }), 'tag anchored match');
    assert(!sf.matches({ text: 'unrelated', tag: 'my-work' }), 'tag does not start with work');
});

test('regex multiline flag is set (m)', () => {
    const sf = new SearchFilter({ regex: true });
    sf.setQuery('^line2');
    assert(sf.matches({ text: 'line1\nline2\nline3', tag: '' }), 'multiline anchor');
});

test('invalid regex does not throw — matches nothing', () => {
    const sf = new SearchFilter({ regex: true });
    let threw = false;
    try {
        sf.setQuery('[broken(');
    } catch (_) {
        threw = true;
    }
    assert(!threw, 'setQuery must not throw on invalid regex');
    assert(!sf.matches({ text: 'anything', tag: '' }), 'invalid regex matches nothing');
});

// ---------------------------------------------------------------------------

suite('SearchFilter — setOptions');

test('setOptions changes caseSensitive and recompiles', () => {
    const sf = new SearchFilter({ caseSensitive: false });
    sf.setQuery('hello');
    assert(sf.matches({ text: 'HELLO', tag: '' }), 'case-insensitive before change');

    sf.setOptions({ caseSensitive: true });
    assert(!sf.matches({ text: 'HELLO', tag: '' }), 'case-sensitive after change');
    assert(sf.matches({ text: 'hello', tag: '' }), 'exact-case still matches');
});

test('setOptions changes regex mode and recompiles', () => {
    const sf = new SearchFilter({ regex: false });
    sf.setQuery('^foo');
    // In substring mode, the literal string "^foo" should be sought
    assert(sf.matches({ text: 'has ^foo in it', tag: '' }), 'literal ^foo in substring mode');
    assert(!sf.matches({ text: 'foobar', tag: '' }), 'foobar has no literal ^foo');

    sf.setOptions({ regex: true });
    // Now it is a real regex anchor
    assert(!sf.matches({ text: 'has ^foo in it', tag: '' }), '^foo regex does not match mid-string');
    assert(sf.matches({ text: 'foobar', tag: '' }), '^foo regex matches start of string');
});

test('setOptions with no args is a no-op that does not throw', () => {
    const sf = new SearchFilter();
    sf.setQuery('hello');
    sf.setOptions();   // should not throw
    assert(sf.matches({ text: 'hello world', tag: '' }), 'still works after empty setOptions');
});
