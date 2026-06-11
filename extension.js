/* Clipboard Indicator — composition root.
 *
 * This file is now a thin wiring layer. All clipboard logic lives in:
 *   - src/core/*          pure, gi-free domain (HistoryModel, ClipboardEntry, …)
 *   - src/adapters/*      gi-backed port implementations (storage, clipboard, …)
 *   - src/ClipboardController.js   application-layer orchestration
 *   - src/ui/*            the GNOME Shell view (Indicator, EntryRow, Preview)
 *
 * THE FREEZE FIX: the old extension ran heavy synchronous work on the
 * gnome-shell main loop on every copy/hover (O(n) re-hash dedup, synchronous
 * full registry writes, synchronous image hashing). That work is now either
 *   - O(1) (HistoryModel dedup via a key Map),
 *   - debounced + async (GioRegistryStorage.writeDebounced), or
 *   - off the main loop entirely (MagickImageCodec subprocess).
 * The first menu open also no longer blocks: rows are built in idle batches and
 * capped at 'rendered-history-limit' rows (older items render lazily on search).
 */

import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { PrefsFields } from './constants.js';

import { HistoryModel } from './src/core/HistoryModel.js';
import { ClipboardController } from './src/ClipboardController.js';
import { Profiler } from './src/Profiler.js';

import { GSettings } from './src/adapters/GSettings.js';
import { GioRegistryStorage } from './src/adapters/GioRegistryStorage.js';
import { GLibScheduler } from './src/adapters/GLibScheduler.js';
import { StSelectionClipboard } from './src/adapters/StSelectionClipboard.js';
import { StTextureImage } from './src/adapters/StTextureImage.js';
import { MagickImageCodec } from './src/adapters/MagickImageCodec.js';

import { Indicator } from './src/ui/Indicator.js';

export default class ClipboardIndicatorExtension extends Extension {
    enable () {
        const rawSettings = this.getSettings();

        // Adapters.
        const settings = new GSettings(rawSettings);
        const storage = new GioRegistryStorage(this.uuid, settings);
        const scheduler = new GLibScheduler();
        const clipboard = new StSelectionClipboard();
        const render = new StTextureImage(storage.registryDir);
        const codec = new MagickImageCodec();
        const profiler = new Profiler();

        this._rawSettings = rawSettings;
        this._settings = settings;
        this._storage = storage;
        this._scheduler = scheduler;
        this._clipboard = clipboard;

        // Live config bag — mutated in place by _fetchConfig() and read by both
        // the controller and the Indicator.
        const config = {};
        this._config = config;
        this._fetchConfig(rawSettings, config);

        // clear-on-boot: wipe the cache directory before loading history.
        if (config.clearOnBoot) {
            this._clearCacheFolder(storage.registryDir);
        }

        // Model.
        const model = new HistoryModel({ maxSize: config.historySize });
        this._model = model;

        // Controller. Hooks bridge UI-side concerns the controller must trigger
        // without importing any gi code itself.
        const controller = new ClipboardController({
            model,
            storage,
            clipboard,
            scheduler,
            codec,
            config,
            hooks: {
                getActiveWmClass: () => {
                    // Same source as the original _refreshIndicator().
                    const focussedWindow = Shell.Global.get().display.focusWindow;
                    return focussedWindow?.get_wm_class?.() ?? undefined;
                },
                isDestroyed: () => this._indicator?._destroyed ?? false,
                notifyCopied: () => this._indicator?.notifyCopied?.(),
            },
            profiler,
        });
        this._controller = controller;

        // View.
        this._indicator = new Indicator({
            controller,
            config,
            settings,
            rawSettings,
            storage,
            clipboard,
            codec,
            render,
            scheduler,
            profiler,
            openSettings: () => this.openPreferences(),
        });

        // Refresh config + propagate to the view on any settings change.
        this._settingsChangedId = rawSettings.connect('changed', () => {
            this._fetchConfig(rawSettings, config);
            this._indicator?.onSettingsChanged();
        });

        Main.panel.addToStatusArea('clipboardIndicator', this._indicator, 1);
    }

    disable () {
        if (this._settingsChangedId) {
            try { this._rawSettings.disconnect(this._settingsChangedId); } catch (_) { /* ignore */ }
            this._settingsChangedId = null;
        }

        // Stop listening for clipboard changes and drain any pending debounced
        // write. controller.stop() awaits storage.flush(); we let that promise
        // settle in the background (the GLib main loop is still alive) rather
        // than blocking synchronous teardown, then tear down the rest now.
        const controller = this._controller;
        if (controller) {
            controller.stop().catch(e =>
                console.error('Clipboard Indicator: error flushing on disable', e));
        }

        this._clipboard?.destroy?.();
        this._settings?.destroy?.();
        this._scheduler?.destroy?.();
        this._indicator?.destroy?.();

        this._indicator = null;
        this._controller = null;
        this._model = null;
        this._storage = null;
        this._clipboard = null;
        this._scheduler = null;
        this._settings = null;
        this._rawSettings = null;
        this._config = null;
    }

    /**
     * Read every setting into the shared config bag. Property names are chosen
     * to match what ClipboardController and Indicator read.
     *
     * @param {object} s   - raw Gio.Settings
     * @param {object} cfg - the live config bag to mutate
     */
    _fetchConfig (s, cfg) {
        // Sizes.
        cfg.historySize            = s.get_int(PrefsFields.HISTORY_SIZE);
        cfg.previewSize            = s.get_int(PrefsFields.PREVIEW_SIZE);
        cfg.topbarPreviewSize      = s.get_int(PrefsFields.TOPBAR_PREVIEW_SIZE);
        cfg.topbarDisplayMode      = s.get_int(PrefsFields.TOPBAR_DISPLAY_MODE_ID);
        cfg.renderedHistoryLimit   = s.get_int(PrefsFields.RENDERED_HISTORY_LIMIT);

        // Booleans (controller-relevant).
        cfg.cacheOnlyFavorite      = s.get_boolean(PrefsFields.CACHE_ONLY_FAVORITE);
        cfg.moveItemFirst          = s.get_boolean(PrefsFields.MOVE_ITEM_FIRST);
        cfg.stripText              = s.get_boolean(PrefsFields.STRIP_TEXT);
        cfg.cacheImages            = s.get_boolean(PrefsFields.CACHE_IMAGES);
        cfg.notifyOnCopy           = s.get_boolean(PrefsFields.NOTIFY_ON_COPY);
        cfg.excludedApps           = s.get_strv(PrefsFields.EXCLUDED_APPS);
        cfg.compression            = s.get_string(PrefsFields.IMAGE_COMPRESSION);

        // Booleans (UI-relevant).
        cfg.deleteEnabled          = s.get_boolean(PrefsFields.DELETE);
        cfg.notifyOnCycle          = s.get_boolean(PrefsFields.NOTIFY_ON_CYCLE);
        cfg.notifyOnClear          = s.get_boolean(PrefsFields.NOTIFY_ON_CLEAR);
        cfg.confirmOnClear         = s.get_boolean(PrefsFields.CONFIRM_ON_CLEAR);
        cfg.confirmOnPinnedDelete  = s.get_boolean(PrefsFields.CONFIRM_ON_PINNED_DELETE);
        cfg.enableKeybinding       = s.get_boolean(PrefsFields.ENABLE_KEYBINDING);
        cfg.clearOnBoot            = s.get_boolean(PrefsFields.CLEAR_ON_BOOT);
        cfg.pasteOnSelect          = s.get_boolean(PrefsFields.PASTE_ON_SELECT);
        cfg.disableDownArrow       = s.get_boolean(PrefsFields.DISABLE_DOWN_ARROW);
        cfg.blinkIconOnCopy        = s.get_boolean(PrefsFields.BLINK_ICON_ON_COPY);
        cfg.keepSelectedOnClear    = s.get_boolean(PrefsFields.KEEP_SELECTED_ON_CLEAR);
        cfg.pasteButton            = s.get_boolean(PrefsFields.PASTE_BUTTON);
        cfg.pinnedOnBottom         = s.get_boolean(PrefsFields.PINNED_ON_BOTTOM);
        cfg.clearHistoryOnInterval = s.get_boolean(PrefsFields.CLEAR_HISTORY_ON_INTERVAL);
        cfg.clearHistoryInterval   = s.get_int(PrefsFields.CLEAR_HISTORY_INTERVAL);
        cfg.caseSensitiveSearch    = s.get_boolean(PrefsFields.CASE_SENSITIVE_SEARCH);
        cfg.regexSearch            = s.get_boolean(PrefsFields.REGEX_SEARCH);
        cfg.openAtCursor           = s.get_boolean(PrefsFields.OPEN_AT_CURSOR);
        cfg.showSearchBar          = s.get_boolean(PrefsFields.SHOW_SEARCH_BAR);
        cfg.showPrivateMode        = s.get_boolean(PrefsFields.SHOW_PRIVATE_MODE);
        cfg.showSettingsButton     = s.get_boolean(PrefsFields.SHOW_SETTINGS_BUTTON);
        cfg.showClearHistoryButton = s.get_boolean(PrefsFields.SHOW_CLEAR_HISTORY_BUTTON);
        cfg.showDeleteButton       = s.get_boolean(PrefsFields.SHOW_DELETE_BUTTON);
        cfg.showTagButton          = s.get_boolean(PrefsFields.SHOW_TAG_BUTTON);
        cfg.showPinButton          = s.get_boolean(PrefsFields.SHOW_PIN_BUTTON);
        cfg.showEditButton         = s.get_boolean(PrefsFields.SHOW_EDIT_BUTTON);
        cfg.showPreviewButton      = s.get_boolean(PrefsFields.SHOW_PREVIEW_BUTTON);

        // privateMode is runtime UI state, never persisted; preserve any existing
        // value across config refreshes (defaults to false on first fetch).
        if (cfg.privateMode === undefined) cfg.privateMode = false;
    }

    /**
     * Delete every file in the cache folder (clear-on-boot). Mirrors the
     * original Registry.clearCacheFolder().
     *
     * @param {string} registryDir
     */
    _clearCacheFolder (registryDir) {
        try {
            const folder = Gio.file_new_for_path(registryDir);
            const enumerator = folder.enumerate_children('', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                const child = folder.get_child(info.get_name());
                try { child.delete(null); } catch (_) { /* ignore individual failures */ }
            }
            enumerator.close(null);
        } catch (e) {
            // Folder may not exist yet — that's fine.
            console.warn('Clipboard Indicator: clear-on-boot cache wipe skipped', e?.message ?? e);
        }
    }
}
