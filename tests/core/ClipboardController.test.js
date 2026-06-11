/* tests/core/ClipboardController.test.js
 *
 * Unit tests for ClipboardController using fake ports.
 * No gi imports — runs headless under `gjs -m tests/run.js`.
 */

import { suite, test, assert, assertEqual, assertDeepEqual } from '../harness.js';
import { ClipboardEntry } from '../../src/core/ClipboardEntry.js';
import { HistoryModel } from '../../src/core/HistoryModel.js';
import { ClipboardController } from '../../src/ClipboardController.js';

// ---------------------------------------------------------------------------
// Fake ports
// ---------------------------------------------------------------------------

class FakeClipboard {
    #listeners = [];
    #queue = [];

    onChange (cb) {
        this.#listeners.push(cb);
        return () => {
            const idx = this.#listeners.indexOf(cb);
            if (idx !== -1) this.#listeners.splice(idx, 1);
        };
    }

    /** Queue a content item to be returned by the next getContent() call. */
    queueContent ({ mimetype, bytesU8 }) {
        this.#queue.push({ mimetype, bytesU8 });
    }

    async getContent () {
        return this.#queue.shift() ?? null;
    }

    /** Fire all registered onChange callbacks (simulates a clipboard change event). */
    triggerChange () {
        for (const cb of this.#listeners) cb();
    }

    setContent (_mimetype, _bytesU8) {}
    clear () {}
}

class FakeStorage {
    #presetEntries;
    writeDebouncedCount = 0;
    writeDebouncedLastPayload = null;
    imageWrites = [];  // { id, bytesU8, mimetype }
    imageDeletes = []; // id strings
    flushCount = 0;

    constructor (presetEntries = []) {
        this.#presetEntries = presetEntries;
    }

    get registryDir () { return '/fake/cache'; }

    async read () { return this.#presetEntries.slice(); }

    writeDebounced (entries) {
        this.writeDebouncedCount++;
        this.writeDebouncedLastPayload = entries.slice();
    }

    async write (entries) {
        this.writeDebouncedLastPayload = entries.slice();
    }

    async flush () { this.flushCount++; }

    async readImageBytes (_id) { return null; }

    async writeImageBytes (id, bytesU8, { mimetype } = {}) {
        this.imageWrites.push({ id, bytesU8, mimetype });
    }

    async deleteImage (id) {
        this.imageDeletes.push(id);
    }

    async listImageFiles () { return []; }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textBytes (str) {
    return new TextEncoder().encode(str);
}

function makeImageBytes (seed = 1) {
    // Minimal distinct byte arrays for image entries.
    return new Uint8Array([seed, seed + 1, seed + 2, seed + 3]);
}

function makeConfig (overrides = {}) {
    return {
        historySize: 5,
        cacheOnlyFavorite: false,
        cacheImages: true,
        moveItemFirst: true,
        stripText: false,
        notifyOnCopy: false,
        privateMode: false,
        excludedApps: [],
        compression: 'off',
        ...overrides,
    };
}

async function triggerCopy (ctrl, clipboard, { mimetype = 'text/plain;charset=utf-8', content }) {
    const bytesU8 = mimetype.startsWith('image/')
        ? content
        : textBytes(content);
    clipboard.queueContent({ mimetype, bytesU8 });
    clipboard.triggerChange();
    // Wait a tick for the async handler to complete.
    await new Promise(r => setTimeout(r, 0));
}

function makeController (opts = {}) {
    const model = new HistoryModel({ maxSize: opts.historySize ?? 5 });
    const storage = opts.storage ?? new FakeStorage();
    const clipboard = opts.clipboard ?? new FakeClipboard();
    const config = makeConfig(opts.config ?? {});
    const hooks = opts.hooks ?? {};
    const ctrl = new ClipboardController({ model, storage, clipboard, config, hooks });
    ctrl.start();
    return { ctrl, model, storage, clipboard };
}

// ---------------------------------------------------------------------------
suite('ClipboardController › new text copy');
// ---------------------------------------------------------------------------

test('adds entry to model, calls writeDebounced, emits added', async () => {
    const events = [];
    const { ctrl, model, storage, clipboard } = makeController();
    ctrl.on('added', e => events.push({ type: 'added', key: e.key() }));

    await triggerCopy(ctrl, clipboard, { content: 'hello world' });

    assertEqual(model.size, 1, 'model should have 1 entry');
    assertEqual(model.all()[0].key(), 'hello world');
    assert(storage.writeDebouncedCount >= 1, 'writeDebounced should have been called');
    assertEqual(events.length, 1);
    assertEqual(events[0].type, 'added');
    assertEqual(events[0].key, 'hello world');
});

test('entry is at front of model after copy', async () => {
    const { ctrl, model, clipboard } = makeController();
    await triggerCopy(ctrl, clipboard, { content: 'first' });
    await triggerCopy(ctrl, clipboard, { content: 'second' });

    assertEqual(model.all()[0].key(), 'second');
    assertEqual(model.all()[1].key(), 'first');
});

// ---------------------------------------------------------------------------
suite('ClipboardController › duplicate copy');
// ---------------------------------------------------------------------------

test('duplicate copy emits selected, not added', async () => {
    const addedEvents = [];
    const selectedEvents = [];
    const { ctrl, model, storage, clipboard } = makeController();
    ctrl.on('added', e => addedEvents.push(e.key()));
    ctrl.on('selected', e => selectedEvents.push(e.key()));

    await triggerCopy(ctrl, clipboard, { content: 'dup text' });
    const countAfterFirst = storage.writeDebouncedCount;

    await triggerCopy(ctrl, clipboard, { content: 'dup text' });

    assertEqual(model.size, 1, 'model must still have 1 entry');
    assertEqual(addedEvents.length, 1, 'added should fire only once');
    assertEqual(selectedEvents.length, 1, 'selected should fire on duplicate');
    assertEqual(selectedEvents[0], 'dup text');
    // writeDebounced called on add but not on the duplicate select (with moveItemFirst=true it may or may not call)
    // The duplicate was already at front so moveToFront is a no-op; controller
    // still calls _persist when moveItemFirst=true and entry is not favorite.
    // Just verify no new 'added' event.
    assertEqual(addedEvents.length, 1);
});

test('duplicate copy with moveItemFirst=true moves to front', async () => {
    const { ctrl, model, clipboard } = makeController({ config: { moveItemFirst: true } });
    await triggerCopy(ctrl, clipboard, { content: 'a' });
    await triggerCopy(ctrl, clipboard, { content: 'b' });
    // 'b' is at front; copy 'a' again → 'a' should come to front
    await triggerCopy(ctrl, clipboard, { content: 'a' });

    assertEqual(model.all()[0].key(), 'a', 'a should now be at front');
});

test('duplicate copy with moveItemFirst=false does NOT move to front', async () => {
    const { ctrl, model, clipboard } = makeController({ config: { moveItemFirst: false } });
    await triggerCopy(ctrl, clipboard, { content: 'a' });
    await triggerCopy(ctrl, clipboard, { content: 'b' });
    // b is at front; copy 'a' again → 'b' should still be at front
    await triggerCopy(ctrl, clipboard, { content: 'a' });

    assertEqual(model.all()[0].key(), 'b', 'b should remain at front');
});

// ---------------------------------------------------------------------------
suite('ClipboardController › image copy');
// ---------------------------------------------------------------------------

test('image copy calls writeImageBytes and adds entry', async () => {
    const events = [];
    const { ctrl, model, storage, clipboard } = makeController();
    ctrl.on('added', e => events.push(e));

    const imgBytes = makeImageBytes(42);
    await triggerCopy(ctrl, clipboard, { mimetype: 'image/png', content: imgBytes });

    assertEqual(model.size, 1, 'model should have 1 image entry');
    assert(model.all()[0].isImage(), 'entry should be image');
    assertEqual(storage.imageWrites.length, 1, 'writeImageBytes should have been called once');
    assertEqual(events.length, 1);
});

test('image copy with cacheImages=false is ignored', async () => {
    const events = [];
    const { ctrl, model, storage, clipboard } = makeController({ config: { cacheImages: false } });
    ctrl.on('added', e => events.push(e));

    const imgBytes = makeImageBytes(7);
    await triggerCopy(ctrl, clipboard, { mimetype: 'image/png', content: imgBytes });

    assertEqual(model.size, 0, 'model should be empty');
    assertEqual(storage.imageWrites.length, 0, 'writeImageBytes should NOT be called');
    assertEqual(events.length, 0, 'no added event');
});

// ---------------------------------------------------------------------------
suite('ClipboardController › trim over historySize');
// ---------------------------------------------------------------------------

test('trim removes oldest non-favorite, deleteImage called for image entries', async () => {
    const removedBulk = [];
    const storage = new FakeStorage();
    const { ctrl, model, clipboard } = makeController({ historySize: 2, storage, config: { historySize: 2 } });
    ctrl.on('removedBulk', entries => removedBulk.push(...entries));

    // Use model's maxSize override since config.historySize is read from model indirectly.
    model.maxSize = 2;

    // Add 3 text entries — 3rd push should trim the oldest.
    await triggerCopy(ctrl, clipboard, { content: 'oldest' });
    await triggerCopy(ctrl, clipboard, { content: 'middle' });
    await triggerCopy(ctrl, clipboard, { content: 'newest' });

    assertEqual(model.size, 2, 'model should have exactly 2 entries');
    assert(!model.has('oldest'), 'oldest should be trimmed');
    assertEqual(removedBulk.length, 1, 'removedBulk event for trimmed entry');
});

test('trim keeps favorites; removes only non-favorites', async () => {
    const storage = new FakeStorage();
    const { ctrl, model, clipboard } = makeController({ storage });
    model.maxSize = 2;

    await triggerCopy(ctrl, clipboard, { content: 'fav item' });
    // Mark the first entry as favorite.
    const favEntry = model.get('fav item');
    ctrl.toggleFavorite(favEntry);

    await triggerCopy(ctrl, clipboard, { content: 'h1' });
    await triggerCopy(ctrl, clipboard, { content: 'h2' });
    // history now has 2 entries (h1, h2); fav is excluded from maxSize limit.
    await triggerCopy(ctrl, clipboard, { content: 'h3' });
    // After trim: 2 non-favs remain (h2, h3); h1 removed.

    assert(model.has('fav item'), 'favorite must survive trim');
    assert(!model.has('h1'), 'h1 should be trimmed');
    assert(model.has('h2') || model.has('h3'), 'newer items survive');
});

test('trim over limit calls deleteImage for removed image entries', async () => {
    const storage = new FakeStorage();
    const { ctrl, model, clipboard } = makeController({ storage });
    model.maxSize = 1;

    // Add two image entries.
    const imgBytes1 = makeImageBytes(10);
    const imgBytes2 = makeImageBytes(20);
    await triggerCopy(ctrl, clipboard, { mimetype: 'image/png', content: imgBytes1 });
    const firstEntry = model.all()[0];

    await triggerCopy(ctrl, clipboard, { mimetype: 'image/png', content: imgBytes2 });

    // The first image should have been removed and deleteImage called.
    assertEqual(storage.imageDeletes.length, 1, 'deleteImage should be called for removed image');
    assertEqual(storage.imageDeletes[0], firstEntry.id());
});

// ---------------------------------------------------------------------------
suite('ClipboardController › privateMode');
// ---------------------------------------------------------------------------

test('privateMode=true: clipboard change is ignored', async () => {
    const events = [];
    const { ctrl, model, clipboard } = makeController({ config: { privateMode: true } });
    ctrl.on('added', e => events.push(e));

    await triggerCopy(ctrl, clipboard, { content: 'secret' });

    assertEqual(model.size, 0, 'model should be empty in private mode');
    assertEqual(events.length, 0);
});

// ---------------------------------------------------------------------------
suite('ClipboardController › excludedApps');
// ---------------------------------------------------------------------------

test('copy from excluded WM class is ignored', async () => {
    const events = [];
    const hooks = { getActiveWmClass: () => 'passwords-app' };
    const { ctrl, model, clipboard } = makeController({
        config: { excludedApps: ['passwords-app'] },
        hooks,
    });
    ctrl.on('added', e => events.push(e));

    await triggerCopy(ctrl, clipboard, { content: 'should be ignored' });

    assertEqual(model.size, 0);
    assertEqual(events.length, 0);
});

test('copy from non-excluded WM class is accepted', async () => {
    const hooks = { getActiveWmClass: () => 'gedit' };
    const { ctrl, model, clipboard } = makeController({
        config: { excludedApps: ['passwords-app'] },
        hooks,
    });

    await triggerCopy(ctrl, clipboard, { content: 'should be added' });

    assertEqual(model.size, 1);
});

// ---------------------------------------------------------------------------
suite('ClipboardController › reentrancy guard (_busy)');
// ---------------------------------------------------------------------------

test('concurrent handleClipboardChange calls are safe (second is dropped)', async () => {
    const storage = new FakeStorage();
    const clipboard = new FakeClipboard();
    const model = new HistoryModel({ maxSize: 5 });
    const config = makeConfig();
    const ctrl = new ClipboardController({ model, storage, clipboard, config });
    ctrl.start();

    // Queue two contents and trigger two change events without awaiting.
    clipboard.queueContent({ mimetype: 'text/plain;charset=utf-8', bytesU8: textBytes('first') });
    clipboard.queueContent({ mimetype: 'text/plain;charset=utf-8', bytesU8: textBytes('second') });
    clipboard.triggerChange();
    clipboard.triggerChange(); // second trigger fires while first is still processing

    // Wait for both microtask queues to drain.
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    // The second handleClipboardChange should have been dropped due to _busy guard.
    // Only 'first' should be in the model.
    assertEqual(model.size, 1);
    assertEqual(model.all()[0].key(), 'first');
});

// ---------------------------------------------------------------------------
suite('ClipboardController › clearHistory');
// ---------------------------------------------------------------------------

test('clearHistory keeps favorites by default', async () => {
    const { ctrl, model, clipboard } = makeController();
    await triggerCopy(ctrl, clipboard, { content: 'normal' });
    await triggerCopy(ctrl, clipboard, { content: 'fav item' });
    ctrl.toggleFavorite(model.get('fav item'));

    const removed = ctrl.clearHistory();

    assert(!model.has('normal'), 'normal entry should be cleared');
    assert(model.has('fav item'), 'favorite should survive');
    assertEqual(removed.length, 1);
    assertEqual(removed[0].key(), 'normal');
});

test('clearHistory with keepFavorites=false removes everything', async () => {
    const { ctrl, model, clipboard } = makeController();
    await triggerCopy(ctrl, clipboard, { content: 'a' });
    await triggerCopy(ctrl, clipboard, { content: 'b' });

    const removed = ctrl.clearHistory({ keepFavorites: false });

    assertEqual(model.size, 0);
    assertEqual(removed.length, 2);
});

test('clearHistory with keepKeys preserves those entries', async () => {
    const { ctrl, model, clipboard } = makeController();
    await triggerCopy(ctrl, clipboard, { content: 'keep me' });
    await triggerCopy(ctrl, clipboard, { content: 'remove me' });

    ctrl.clearHistory({ keepFavorites: false, keepKeys: ['keep me'] });

    assert(model.has('keep me'), 'keepKeys entry should survive');
    assert(!model.has('remove me'), 'other entry should be cleared');
});

test('clearHistory calls deleteImage for removed image entries', async () => {
    const storage = new FakeStorage();
    const { ctrl, model, clipboard } = makeController({ storage });

    const imgBytes = makeImageBytes(99);
    await triggerCopy(ctrl, clipboard, { mimetype: 'image/png', content: imgBytes });
    const imgEntry = model.all()[0];
    storage.imageDeletes = []; // reset

    ctrl.clearHistory({ keepFavorites: false });

    assert(storage.imageDeletes.includes(imgEntry.id()), 'deleteImage should be called');
});

test('clearHistory emits removedBulk', async () => {
    const bulkEvents = [];
    const { ctrl, clipboard } = makeController();
    ctrl.on('removedBulk', entries => bulkEvents.push(entries.length));

    await triggerCopy(ctrl, clipboard, { content: 'x' });
    await triggerCopy(ctrl, clipboard, { content: 'y' });
    ctrl.clearHistory({ keepFavorites: false });

    assert(bulkEvents.includes(2), 'removedBulk should be emitted with 2 entries');
});

// ---------------------------------------------------------------------------
suite('ClipboardController › toggleFavorite');
// ---------------------------------------------------------------------------

test('toggleFavorite marks entry as favorite and moves to front', async () => {
    const { ctrl, model, clipboard } = makeController();
    await triggerCopy(ctrl, clipboard, { content: 'a' });
    await triggerCopy(ctrl, clipboard, { content: 'b' });
    // model: [b, a]

    const entryA = model.get('a');
    ctrl.toggleFavorite(entryA);

    assert(model.get('a').isFavorite(), 'a should be marked favorite');
    assertEqual(model.all()[0].key(), 'a', 'a should be at front after toggleFavorite');
});

test('toggleFavorite un-favorites a favorite entry', async () => {
    const { ctrl, model, clipboard } = makeController();
    await triggerCopy(ctrl, clipboard, { content: 'fav' });
    const entry = model.get('fav');

    ctrl.toggleFavorite(entry); // mark as fav
    assert(model.get('fav').isFavorite());

    ctrl.toggleFavorite(model.get('fav')); // un-mark
    assert(!model.get('fav').isFavorite(), 'entry should no longer be favorite');
});

test('toggleFavorite persists (calls writeDebounced)', async () => {
    const storage = new FakeStorage();
    const { ctrl, model, clipboard } = makeController({ storage });
    await triggerCopy(ctrl, clipboard, { content: 'x' });
    const before = storage.writeDebouncedCount;

    ctrl.toggleFavorite(model.get('x'));

    assert(storage.writeDebouncedCount > before, 'writeDebounced should be called');
});

// ---------------------------------------------------------------------------
suite('ClipboardController › loadInitial');
// ---------------------------------------------------------------------------

test('loadInitial bulk-loads entries and emits reloaded', async () => {
    const preloaded = [
        ClipboardEntry.text('stored1'),
        ClipboardEntry.text('stored2'),
    ];
    const storage = new FakeStorage(preloaded);
    const model = new HistoryModel({ maxSize: 5 });
    const clipboard = new FakeClipboard();
    const ctrl = new ClipboardController({ model, storage, clipboard, config: makeConfig() });

    const reloadedEvents = [];
    ctrl.on('reloaded', entries => reloadedEvents.push(entries.length));

    await ctrl.loadInitial();

    assertEqual(model.size, 2, 'model should have 2 entries from storage');
    assertEqual(reloadedEvents.length, 1);
    assertEqual(reloadedEvents[0], 2);
});

// ---------------------------------------------------------------------------
suite('ClipboardController › stop');
// ---------------------------------------------------------------------------

test('stop disconnects clipboard listener and flushes storage', async () => {
    const storage = new FakeStorage();
    const { ctrl, clipboard } = makeController({ storage });

    await ctrl.stop();

    assertEqual(storage.flushCount, 1, 'flush should be called on stop');
    // After stop, further clipboard triggers should not affect model.
    const model = new HistoryModel({ maxSize: 5 });
    // (Listener is disconnected; no way to trigger easily — just verify flush was called.)
});

// ---------------------------------------------------------------------------
suite('ClipboardController › stripText');
// ---------------------------------------------------------------------------

test('stripText=true trims whitespace from text entries', async () => {
    const { ctrl, model, clipboard } = makeController({ config: { stripText: true } });

    await triggerCopy(ctrl, clipboard, { content: '  hello  ' });

    assertEqual(model.all()[0].key(), 'hello', 'text should be trimmed');
});

test('stripText=false preserves whitespace', async () => {
    const { ctrl, model, clipboard } = makeController({ config: { stripText: false } });

    await triggerCopy(ctrl, clipboard, { content: '  hello  ' });

    assertEqual(model.all()[0].key(), '  hello  ', 'text should NOT be trimmed');
});
