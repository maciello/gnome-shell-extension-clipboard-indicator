/* Test runner — invoke with: gjs -m tests/run.js [filter]
 *
 * Imports every *.test.js file in tests/core/ (and tests/adapters/ if it
 * exists) so they self-register via side effects, then calls run().
 *
 * An optional positional argument filters test files by substring, e.g.:
 *   gjs -m tests/run.js CacheGC
 */

import system from 'system';
import { run } from './harness.js';

// Core — pure JS, no gi needed
import './core/CacheGC.test.js';
import './core/Debouncer.test.js';
import './core/HistoryModel.test.js';
import './core/SearchFilter.test.js';
import './core/hash.test.js';
import './core/ClipboardEntry.test.js';
import './core/registry-fidelity.test.js';
import './core/ClipboardController.test.js';
import './core/serialization.test.js';

// Adapters — may use gi://GLib, gi://Gio (available under plain gjs)
// but must NOT import gi://St, gi://Clutter, gi://Meta.
import './adapters/GioRegistryStorage.test.js';
import './adapters/MagickImageCodec.test.js';

const fail = await run();
system.exit(fail === 0 ? 0 : 1);
