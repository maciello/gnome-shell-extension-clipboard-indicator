/* Indicator — the PanelMenu.Button that ties the UI to the ClipboardController.
 *
 * This is the view/controller-glue layer. It owns no clipboard state; the
 * authoritative history lives in the injected HistoryModel and is mutated only
 * through the ClipboardController. The Indicator:
 *   - builds the panel button (icon / text / image preview + display modes),
 *   - builds the menu (search bar, favorites + history scrollviews, private
 *     mode switch, clear + settings items, interval-clear timer UI),
 *   - renders rows in idle batches with a configurable render cap,
 *   - listens to controller events ('added','selected','removedBulk','reloaded')
 *     to keep the rendered rows in sync,
 *   - routes every user action (delete, favorite, edit, tag, clear, paste,
 *     select) through the controller,
 *   - implements keybindings, notifications, private mode, blink, dialogs.
 *
 * Every user-facing behaviour from the original extension.js is preserved; the
 * only intended changes are performance (no main-loop freeze) and the render
 * cap (older rows are created lazily when matched by search).
 */

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { DialogManager } from '../../confirmDialog.js';
import { PrefsFields } from '../../constants.js';
import { Keyboard } from '../../keyboard.js';

import { Preview } from './Preview.js';
import { createEntryRow, setEntryLabel, updateTagLabel, truncate } from './EntryRow.js';
import { entryClipboardPayload } from '../EntryBytes.js';
import { ClipboardEntry } from '../core/ClipboardEntry.js';

const INDICATOR_ICON = 'edit-paste-symbolic';
const DELAYED_SELECTION_TIMEOUT = 750;
const RENDER_BATCH = 25;        // rows created per idle tick
const SEARCH_RENDER_CAP = 200;  // max lazily-rendered rows during search
const TOPBAR_THUMBNAIL_PX = 24; // topbar image render resolution (CSS clamps to 1em)

export const Indicator = GObject.registerClass({
    GTypeName: 'ClipboardIndicator'
}, class Indicator extends PanelMenu.Button {
    #refreshInProgress = false;

    destroy () {
        this._destroyed = true;
        this._unsubscribeController();
        this._unbindShortcuts();
        this._clearDelayedSelectionTimeout();
        this.#clearTimeouts();
        this._disconnectIntervalSettings();
        this.preview.destroy();
        this._removeHistoryLabel();
        this._destroyNotifSource();
        this.dialogManager.destroy();
        this.keyboard.destroy();
        if (this._cursorActor) {
            this._cursorActor.destroy();
            this._cursorActor = null;
        }

        super.destroy();
    }

    _init (deps) {
        super._init(0.0, 'ClipboardIndicator');

        // --- injected dependencies ---
        this.controller = deps.controller;
        this.config = deps.config;             // live config bag (shared w/ controller)
        this.settings = deps.settings;          // GSettings adapter
        this.rawSettings = deps.rawSettings;    // raw Gio.Settings (keybindings/interval)
        this.storage = deps.storage;
        this.clipboard = deps.clipboard;        // ClipboardPort (StSelectionClipboard)
        this.codec = deps.codec;
        this.render = deps.render;
        this.scheduler = deps.scheduler;
        this.profiler = deps.profiler;
        this.openSettings = deps.openSettings;

        this._destroyed = false;
        this.keyboard = new Keyboard();
        this.dialogManager = new DialogManager();
        this.preview = new Preview({ render: this.render });

        this._shortcutsBindingIds = [];
        this.clipItemsRadioGroup = [];

        // idle render batching state
        this._pendingRender = [];
        this._renderIdleHandle = null;

        this._cursorActor = new Clutter.Actor({ opacity: 0, width: 1, height: 1 });
        Main.uiGroup.add_child(this._cursorActor);

        this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (!isOpen) this.menu.sourceActor = this;
        });

        // --- panel button layout ---
        const hbox = new St.BoxLayout({
            style_class: 'panel-status-menu-box clipboard-indicator-hbox'
        });
        this.hbox = hbox;

        this.icon = new St.Icon({
            icon_name: INDICATOR_ICON,
            style_class: 'system-status-icon clipboard-indicator-icon'
        });

        this._buttonText = new St.Label({
            text: _('Text will be here'),
            y_align: Clutter.ActorAlign.CENTER
        });

        this._buttonImgPreview = new St.Bin({
            style_class: 'clipboard-indicator-topbar-preview'
        });

        hbox.add_child(this.icon);
        hbox.add_child(this._buttonText);
        hbox.add_child(this._buttonImgPreview);
        this._downArrow = PopupMenu.arrowIcon(St.Side.BOTTOM);
        hbox.add_child(this._downArrow);
        this.add_child(hbox);

        this._createHistoryLabel();

        if (this.config.enableKeybinding) this._bindShortcuts();

        this._buildMenu();
        this.profiler.time('initial-menu-build', () => this._buildInitialRows())
            .then(() => {
                if (this._destroyed) return;
                this._updateTopbarLayout();
                this._setupHistoryIntervalClearing();
                this._subscribeController();
                this.controller.start();
            }).catch(e => {
                console.error('Clipboard Indicator: initial build failed');
                console.error(e);
            });
    }

    // =========================================================================
    // Menu construction
    // =========================================================================

    _buildMenu () {
        // Search entry
        this._entryItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false
        });
        this.searchEntry = new St.Entry({
            name: 'searchEntry',
            style_class: 'search-entry',
            can_focus: true,
            hint_text: _('Type here to search...'),
            track_hover: true,
            x_expand: true,
            y_expand: true,
            primary_icon: new St.Icon({ icon_name: 'edit-find-symbolic' })
        });
        this.searchEntry.get_clutter_text().connect(
            'text-changed', this._onSearchTextChanged.bind(this));
        this._entryItem.add_child(this.searchEntry);

        this.menu.connect('open-state-changed', (self, open) => {
            this._setFocusOnOpenTimeout = setTimeout(() => {
                if (!open) return;
                if (this._focusItemOnOpen) {
                    const item = this._focusItemOnOpen;
                    this._focusItemOnOpen = null;
                    global.stage.set_key_focus(item.actor);
                } else if (this.config.showSearchBar && this.clipItemsRadioGroup.length > 0) {
                    this.searchEntry.set_text('');
                    global.stage.set_key_focus(this.searchEntry);
                } else if (this.clipItemsRadioGroup.length > 0) {
                    const currentItem = this._getCurrentlySelectedItem();
                    if (currentItem) global.stage.set_key_focus(currentItem.actor);
                } else if (this.config.showPrivateMode && this.privateModeMenuItem) {
                    global.stage.set_key_focus(this.privateModeMenuItem.actor);
                }
            }, 50);
        });

        // Favorites section
        this.favoritesSection = new PopupMenu.PopupMenuSection();
        this.scrollViewFavoritesMenuSection = new PopupMenu.PopupMenuSection();
        this.favoritesScrollView = new St.ScrollView({
            style_class: 'ci-history-menu-section',
            overlay_scrollbars: true
        });
        this.favoritesScrollView.add_child(this.favoritesSection.actor);
        this.scrollViewFavoritesMenuSection.actor.add_child(this.favoritesScrollView);
        this.favoritesSeparator = new PopupMenu.PopupSeparatorMenuItem();

        // History section
        this.historySection = new PopupMenu.PopupMenuSection();
        this.scrollViewMenuSection = new PopupMenu.PopupMenuSection();
        this.historyScrollView = new St.ScrollView({
            style_class: 'ci-main-menu-section ci-history-menu-section',
            overlay_scrollbars: true
        });
        this.historyScrollView.add_child(this.historySection.actor);
        this.scrollViewMenuSection.actor.add_child(this.historyScrollView);
        this.historySeparator = new PopupMenu.PopupSeparatorMenuItem();

        if (this.config.pinnedOnBottom) {
            this.menu.addMenuItem(this.scrollViewMenuSection);
            this.menu.addMenuItem(this.scrollViewFavoritesMenuSection);
        } else {
            this.menu.addMenuItem(this.scrollViewFavoritesMenuSection);
            this.menu.addMenuItem(this.scrollViewMenuSection);
        }

        // Private mode switch
        this.privateModeMenuItem = new PopupMenu.PopupSwitchMenuItem(
            _('Private mode'), this.config.privateMode, { reactive: true });
        this.privateModeMenuItem.connect('toggled',
            this._onPrivateModeSwitch.bind(this));
        this.privateModeMenuItem.insert_child_at_index(
            new St.Icon({
                icon_name: 'security-medium-symbolic',
                style_class: 'clipboard-menu-icon',
                y_align: Clutter.ActorAlign.CENTER
            }), 0);
        this.menu.addMenuItem(this.privateModeMenuItem);

        // Clear history item + interval timer UI
        this.clearMenuItem = new PopupMenu.PopupMenuItem(_('Clear history'));
        this.clearMenuItem.insert_child_at_index(
            new St.Icon({
                icon_name: 'user-trash-symbolic',
                style_class: 'clipboard-menu-icon',
                y_align: Clutter.ActorAlign.CENTER
            }), 0);

        const timerBox = new St.BoxLayout({
            x_align: Clutter.ActorAlign.END,
            x_expand: true
        });
        this.timerLabel = new St.Label({
            text: '',
            style: 'font-family: monospace;',
            x_align: Clutter.ActorAlign.END,
            x_expand: true
        });
        this.resetTimerButton = new St.Button({
            style_class: 'ci-action-btn',
            can_focus: true,
            accessible_name: _('Reset Timer'),
            child: new St.Icon({
                icon_name: 'view-refresh-symbolic',
                style_class: 'system-status-icon',
                icon_size: 14
            }),
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.resetTimerButton.connect('clicked', () => this._scheduleNextHistoryClear());
        timerBox.add_child(this.timerLabel);
        timerBox.add_child(this.resetTimerButton);
        this.clearMenuItem.add_child(timerBox);
        this.clearMenuItem.connect('activate', this._removeAll.bind(this));

        // Settings item
        this.settingsMenuItem = new PopupMenu.PopupMenuItem(_('Settings'));
        this.settingsMenuItem.insert_child_at_index(
            new St.Icon({
                icon_name: 'preferences-system-symbolic',
                style_class: 'clipboard-menu-icon',
                y_align: Clutter.ActorAlign.CENTER
            }), 0);
        this.settingsMenuItem.connect('activate', this._openSettings.bind(this));

        // Empty state
        this.emptyStateSection = new St.BoxLayout({
            style_class: 'clipboard-indicator-empty-state',
            vertical: true
        });
        this.emptyStateSection.add_child(new St.Icon({
            icon_name: INDICATOR_ICON,
            style_class: 'system-status-icon clipboard-indicator-icon',
            x_align: Clutter.ActorAlign.CENTER
        }));
        this.emptyStateSection.add_child(new St.Label({
            text: _('Clipboard is empty'),
            x_align: Clutter.ActorAlign.CENTER
        }));
    }

    /** ctx object shared with EntryRow factory. */
    _rowCtx () {
        return {
            config: this.config,
            render: this.render,
            radioGroup: this.clipItemsRadioGroup,
            menu: this.menu,
            favoritesScrollView: this.favoritesScrollView,
            historyScrollView: this.historyScrollView,
            onActivate: (mi) => this._onRowActivate(mi),
            onDelete: (mi) => this._onRowDelete(mi),
            onToggleFavorite: (mi) => this._favoriteToggle(mi),
            onPaste: (mi) => this.#pasteItem(mi),
            onEdit: (mi) => this.#showEditDialog(mi),
            onTag: (mi) => this.#showTagDialog(mi),
            onPreview: (mi, reopenOnClose = false) => this.#showImagePreview(mi, reopenOnClose),
            selectNext: (mi) => this.#selectNextMenuItem(mi),
        };
    }

    // =========================================================================
    // Initial row build — render cap + idle batches
    // =========================================================================

    async _buildInitialRows () {
        const entries = await this.controller.loadInitial();
        if (this._destroyed) return;

        // All favorites + the most-recent N non-favorites (render cap). The full
        // history stays in the model; only the rows are capped.
        const limit = this.config.renderedHistoryLimit;
        const renderSet = new Set();
        let nonFavCount = 0;
        for (const e of entries) {
            if (e.isFavorite()) {
                renderSet.add(e);
            } else if (nonFavCount < limit) {
                renderSet.add(e);
                nonFavCount++;
            }
        }

        // entries is newest-first; prepend (index 0) puts newest on top, so we
        // render oldest-first to reproduce the original visual order.
        const ordered = entries.filter(e => renderSet.has(e));

        await new Promise(resolve => {
            this._enqueueRender(ordered.slice().reverse(), () => {
                if (this._destroyed) { resolve(); return; }
                // Select the most-recent entry (top of list), matching the
                // original which selected clipItemsArr[lastIdx].
                const mostRecent = entries[0];
                if (mostRecent) {
                    const mi = this._findRowByKey(mostRecent.key());
                    if (mi) this._selectMenuItem(mi);
                }
                this.#showElements();
                resolve();
            });
        });
    }

    /**
     * Render `entriesOldestFirst` into the menu in idle batches; invoke `done`
     * when finished. Each entry is appended (index 0) so newest lands on top.
     */
    _enqueueRender (entriesOldestFirst, done) {
        let i = 0;
        const step = () => {
            this._renderIdleHandle = null;
            if (this._destroyed) { if (done) done(); return; }

            const end = Math.min(i + RENDER_BATCH, entriesOldestFirst.length);
            for (; i < end; i++) {
                this._renderRow(entriesOldestFirst[i], { prepend: true });
            }

            if (i < entriesOldestFirst.length) {
                this._renderIdleHandle = this.scheduler.idle(step);
            } else if (done) {
                done();
            }
        };
        if (entriesOldestFirst.length === 0) {
            if (done) done();
            return;
        }
        this._renderIdleHandle = this.scheduler.idle(step);
    }

    /**
     * Create a row for `entry` and insert it into the correct section.
     * @param {object} entry
     * @param {object} [opts]
     * @param {boolean} [opts.prepend] - insert at index 0 (top); else append at bottom
     * @returns {object} the menu item
     */
    _renderRow (entry, { prepend = true } = {}) {
        const menuItem = createEntryRow({ entry, ctx: this._rowCtx() });
        this.clipItemsRadioGroup.push(menuItem);

        menuItem.setOrnament(PopupMenu.Ornament.DOT);
        if (menuItem._ornamentIcon) menuItem._ornamentIcon.opacity = 0;

        const section = entry.isFavorite() ? this.favoritesSection : this.historySection;
        section.addMenuItem(menuItem, prepend ? 0 : undefined);
        return menuItem;
    }

    // =========================================================================
    // Controller event subscriptions
    // =========================================================================

    _subscribeController () {
        this._onAdded = (entry) => this._handleAdded(entry);
        this._onSelected = (entry) => this._handleSelected(entry);
        this._onRemovedBulk = (entries) => this._handleRemovedBulk(entries);
        this._onReloaded = (entries) => this._handleReloaded(entries);

        this.controller.on('added', this._onAdded);
        this.controller.on('selected', this._onSelected);
        this.controller.on('removedBulk', this._onRemovedBulk);
        this.controller.on('reloaded', this._onReloaded);
    }

    _unsubscribeController () {
        if (!this.controller) return;
        if (this._onAdded) this.controller.off('added', this._onAdded);
        if (this._onSelected) this.controller.off('selected', this._onSelected);
        if (this._onRemovedBulk) this.controller.off('removedBulk', this._onRemovedBulk);
        if (this._onReloaded) this.controller.off('reloaded', this._onReloaded);
    }

    _handleAdded (entry) {
        if (this._destroyed) return;
        // Capture the just-copied entry and the one selected immediately before
        // it, so the copy notification's 'Cancel' acts on the right rows even
        // after lazy search/cycle rendering pushes extra rows onto the radio
        // group (which broke the original [length-1]/[length-2] assumption).
        const priorSelected = this._getCurrentlySelectedItem();
        this._priorToCopyEntry = priorSelected ? priorSelected.entry : null;
        this._lastCopiedEntry = entry;

        const menuItem = this._renderRow(entry, { prepend: true });
        // Match original: a freshly-copied entry becomes selected but does NOT
        // re-write the clipboard (autoSet=false).
        this._selectMenuItem(menuItem, false);
        // The copy notification is fired by the controller via the notifyCopied
        // hook; the icon blink is gated internally by blink-icon-on-copy.
        this._blinkIcon();
        this.#showElements();
    }

    _handleSelected (entry) {
        if (this._destroyed) return;
        let mi = this._findRowByKey(entry.key());

        // The controller already moved the entry to the front of the model when
        // move-item-first is on; mirror that visually by re-homing the row at
        // the top (matches the original _refreshIndicator → _moveItemFirst path).
        const shouldMoveFirst = this.config.moveItemFirst && !entry.isFavorite();

        if (!mi) {
            // entry exists in the model but is beyond the render cap — make it.
            mi = this._renderRow(entry, { prepend: true });
        } else if (shouldMoveFirst) {
            this._destroyRow(mi);
            mi = this._renderRow(entry, { prepend: true });
        }

        this._selectMenuItem(mi, false);
        this.#showElements();
    }

    _handleRemovedBulk (entries) {
        if (this._destroyed || !entries) return;
        for (const entry of entries) {
            const mi = this._findRowByKey(entry.key());
            if (mi) this._destroyRow(mi);
        }
        this.#showElements();
    }

    _handleReloaded () {
        // Only fired during loadInitial(); rows are built by _buildInitialRows.
    }

    /** Notification hook invoked by the controller via the config/hooks bridge. */
    notifyCopied () {
        if (this._destroyed) return;
        this._showNotification(_('Copied to clipboard'), notif => {
            notif.addAction(_('Cancel'), this._cancelNotification.bind(this));
        });
    }

    // =========================================================================
    // Row lookup / destruction helpers
    // =========================================================================

    _findRowByKey (key) {
        return this.clipItemsRadioGroup.find(mi => mi.entry.key() === key);
    }

    _destroyRow (menuItem) {
        const idx = this.clipItemsRadioGroup.indexOf(menuItem);
        if (idx !== -1) this.clipItemsRadioGroup.splice(idx, 1);
        menuItem.destroy();
    }

    _getCurrentlySelectedItem () {
        return this.clipItemsRadioGroup.find(item => item.currentlySelected);
    }

    _getAllIMenuItems () {
        return this.historySection._getMenuItems().concat(this.favoritesSection._getMenuItems());
    }

    // =========================================================================
    // Selection / ornaments
    // =========================================================================

    _onMenuItemSelected (menuItem, autoSet) {
        for (const otherMenuItem of menuItem.radioGroup) {
            const clipContents = menuItem.clipContents;
            if (otherMenuItem === menuItem && clipContents) {
                menuItem.setOrnament(PopupMenu.Ornament.DOT);
                if (menuItem._ornamentIcon) menuItem._ornamentIcon.opacity = 255;
                menuItem.currentlySelected = true;
                if (autoSet !== false) this.#updateClipboard(menuItem.entry);
            } else {
                otherMenuItem.setOrnament(PopupMenu.Ornament.DOT);
                if (otherMenuItem._ornamentIcon) otherMenuItem._ornamentIcon.opacity = 0;
                otherMenuItem.currentlySelected = false;
            }
        }
    }

    _selectMenuItem (menuItem, autoSet) {
        this._onMenuItemSelected(menuItem, autoSet);
        this.#updateIndicatorContent(menuItem.entry);
    }

    _onMenuItemSelectedAndMenuClose (menuItem, autoSet) {
        for (const otherMenuItem of menuItem.radioGroup) {
            const clipContents = menuItem.clipContents;
            if (menuItem === otherMenuItem && clipContents) {
                menuItem.setOrnament(PopupMenu.Ornament.DOT);
                if (menuItem._ornamentIcon) menuItem._ornamentIcon.opacity = 255;
                menuItem.currentlySelected = true;
                if (autoSet !== false) this.#updateClipboard(menuItem.entry);
            } else {
                otherMenuItem.setOrnament(PopupMenu.Ornament.DOT);
                if (otherMenuItem._ornamentIcon) otherMenuItem._ornamentIcon.opacity = 0;
                otherMenuItem.currentlySelected = false;
            }
        }

        if (this.config.pasteOnSelect && this.config.moveItemFirst && !menuItem.entry.isFavorite()) {
            this._moveItemFirst(menuItem);
        }

        menuItem.menu.close();
    }

    _onRowActivate (menuItem) {
        if (this.config.pasteOnSelect) {
            this.#pasteItem(menuItem);
            this._onMenuItemSelectedAndMenuClose(menuItem, false);
        } else {
            this._onMenuItemSelectedAndMenuClose(menuItem, true);
        }
    }

    _findNextMenuItem (currentMenuItem) {
        const currentIndex = this.clipItemsRadioGroup.indexOf(currentMenuItem);
        if (this.clipItemsRadioGroup.length === 1) return null;

        for (let i = currentIndex - 1; i >= 0; i--) {
            const menuItem = this.clipItemsRadioGroup[i];
            if (menuItem.actor.visible) return menuItem;
        }

        const beforeMenuItem = this.clipItemsRadioGroup[currentIndex + 1];
        if (beforeMenuItem && beforeMenuItem.actor.visible) return beforeMenuItem;
        return null;
    }

    #selectNextMenuItem (menuItem) {
        const nextMenuItem = this._findNextMenuItem(menuItem);
        if (nextMenuItem) {
            nextMenuItem.actor.grab_key_focus();
        } else if (this.privateModeMenuItem?.actor) {
            this.privateModeMenuItem.actor.grab_key_focus();
        }
    }

    // =========================================================================
    // User actions → controller
    // =========================================================================

    _onRowDelete (menuItem) {
        if (menuItem.entry.isFavorite() && this.config.confirmOnPinnedDelete) {
            this._confirmRemovePinnedEntry(menuItem, true);
        } else {
            this.#selectNextMenuItem(menuItem);
            this._removeEntry(menuItem, 'delete');
        }
    }

    _favoriteToggle (menuItem) {
        const entry = menuItem.entry;
        const wasSelected = menuItem.currentlySelected;
        // Flips favorite + moves entry to front in the model + persists.
        this.controller.toggleFavorite(entry);
        // Re-home the row into the now-correct section, at the front.
        this._destroyRow(menuItem);
        const newItem = this._renderRow(entry, { prepend: true });
        if (wasSelected) this._selectMenuItem(newItem, false);
        this.#showElements();
    }

    _confirmRemovePinnedEntry (menuItem, selectNext = false) {
        const title = _('Delete pinned item?');
        const message = _('Are you sure you want to delete this pinned item?');
        const sub_message = _('This operation cannot be undone.');

        this.dialogManager.open(title, message, sub_message, _('Delete'), _('Cancel'), () => {
            if (selectNext) this.#selectNextMenuItem(menuItem);
            this._removeEntry(menuItem, 'delete');
        });
    }

    _confirmRemoveAll () {
        const title = _('Clear all?');
        const message = _('Are you sure you want to delete all clipboard items?');
        const sub_message = _('This operation cannot be undone.');

        this.dialogManager.open(title, message, sub_message, _('Clear'), _('Cancel'), () => {
            this._clearHistory();
        });
    }

    _clearHistory (invokedAutomatically = false) {
        // Preserve currently-selected entry when keep-selected-on-clear is set.
        let keepKeys = [];
        const current = this._getCurrentlySelectedItem();
        if (this.config.keepSelectedOnClear && current) {
            keepKeys = [current.entry.key()];
        }

        // Match the original: if the selected (non-favorite) item is being
        // removed, the system clipboard is cleared too.
        const selectedWillBeRemoved = current &&
            !current.entry.isFavorite() &&
            !keepKeys.includes(current.entry.key());
        if (selectedWillBeRemoved) {
            this.#clearClipboard();
        }

        // Controller clears non-favorites (keepFavorites: true) honoring keepKeys.
        // Rows for removed entries are torn down via the 'removedBulk' event.
        this.controller.clearHistory({ keepFavorites: true, keepKeys });

        if (this.config.notifyOnClear) {
            const message = invokedAutomatically
                ? _('Clipboard history cleared automatically')
                : _('Clipboard history cleared');
            this._showNotification(message);
        }
    }

    _removeAll () {
        if (this.config.privateMode) return;
        if (this.config.confirmOnClear) {
            this._confirmRemoveAll();
        } else {
            this._clearHistory();
        }
    }

    _removeEntry (menuItem, event) {
        if (event === 'delete' && menuItem.currentlySelected) {
            this.#clearClipboard();
        }
        this.controller.removeEntry(menuItem.entry);
        this._destroyRow(menuItem);
        this.#showElements();
    }

    _moveItemFirst (menuItem) {
        const entry = menuItem.entry;
        const wasSelected = menuItem.currentlySelected;
        this.controller.moveItemFirst(entry);
        this._destroyRow(menuItem);
        const newItem = this._renderRow(entry, { prepend: true });
        if (wasSelected) this._selectMenuItem(newItem, false);
        this.#showElements();
    }

    // =========================================================================
    // Search
    // =========================================================================

    _onSearchTextChanged () {
        const searchedText = this.searchEntry.get_text();

        // Compile once via the controller's search filter.
        const filter = this._getSearchFilter();
        filter.setQuery(searchedText);

        if (searchedText === '') {
            this._getAllIMenuItems().forEach(mItem => { mItem.actor.visible = true; });
            return;
        }

        // Show/hide existing rows by match.
        this._getAllIMenuItems().forEach(mItem => {
            mItem.actor.visible = filter.matches({
                text: mItem.clipContents,
                tag: mItem.entry.getTag() || '',
            });
        });

        // Lazily render matching entries that exist in the model but were not
        // rendered (beyond the render cap), up to SEARCH_RENDER_CAP.
        const renderedKeys = new Set(this.clipItemsRadioGroup.map(mi => mi.entry.key()));
        let rendered = this.clipItemsRadioGroup.filter(mi => mi.actor.visible).length;

        for (const entry of this.controller.modelEntries()) {
            if (rendered >= SEARCH_RENDER_CAP) break;
            if (renderedKeys.has(entry.key())) continue;
            if (!filter.matches({ text: entry.getStringValue(), tag: entry.getTag() || '' })) continue;

            // Append at bottom so existing newest-first order is preserved.
            const mi = this._renderRow(entry, { prepend: false });
            renderedKeys.add(entry.key());
            rendered++;
        }
    }

    _getSearchFilter () {
        if (!this._searchFilter) {
            this._searchFilter = this.controller.makeSearchFilter({
                caseSensitive: this.config.caseSensitiveSearch,
                regex: this.config.regexSearch,
            });
        } else {
            this._searchFilter.setOptions({
                caseSensitive: this.config.caseSensitiveSearch,
                regex: this.config.regexSearch,
            });
        }
        return this._searchFilter;
    }

    // =========================================================================
    // Show / hide elements (ported faithfully)
    // =========================================================================

    #hideElements () {
        if (this._destroyed) return;
        if (this.menu.box.contains(this._entryItem)) this.menu.box.remove_child(this._entryItem);
        if (this.menu.box.contains(this.favoritesSeparator)) this.menu.box.remove_child(this.favoritesSeparator);
        if (this.menu.box.contains(this.historySeparator)) this.menu.box.remove_child(this.historySeparator);
        if (this.clearMenuItem?.actor && this.menu.box.contains(this.clearMenuItem.actor))
            this.menu.box.remove_child(this.clearMenuItem.actor);
        if (this.settingsMenuItem?.actor && this.menu.box.contains(this.settingsMenuItem.actor))
            this.menu.box.remove_child(this.settingsMenuItem.actor);
        if (this.menu.box.contains(this.emptyStateSection)) this.menu.box.remove_child(this.emptyStateSection);
    }

    #showElements () {
        if (this._destroyed) return;
        const PRIVATEMODE = this.config.privateMode;

        if (this.clipItemsRadioGroup.length > 0 &&
            this.menu.box.contains(this.emptyStateSection)) {
            this.menu.box.remove_child(this.emptyStateSection);
        }

        // Search bar
        if (this.config.showSearchBar && !PRIVATEMODE) {
            if (!this.menu.box.contains(this._entryItem))
                this.menu.box.insert_child_at_index(this._entryItem, 0);
        } else {
            if (this.menu.box.contains(this._entryItem))
                this.menu.box.remove_child(this._entryItem);
        }

        if (this.privateModeMenuItem?.actor) {
            this.privateModeMenuItem.actor.visible = this.config.showPrivateMode;
        }

        if (this.clipItemsRadioGroup.length > 0) {
            if (this.favoritesSection._getMenuItems().length > 0 && !PRIVATEMODE) {
                if (this.menu.box.contains(this.favoritesSeparator) === false) {
                    this.menu.box.insert_child_above(this.favoritesSeparator, this.scrollViewFavoritesMenuSection.actor);
                }
            } else if (this.menu.box.contains(this.favoritesSeparator) === true) {
                this.menu.box.remove_child(this.favoritesSeparator);
            }
        }

        if (this.clipItemsRadioGroup.length > 0 &&
            this.historySection._getMenuItems().length > 0 && !PRIVATEMODE &&
            (this.config.showPrivateMode || this.config.showSettingsButton || this.config.showClearHistoryButton)) {
            if (!this.menu.box.contains(this.historySeparator))
                this.menu.box.insert_child_above(this.historySeparator, this.scrollViewMenuSection.actor);
        } else if (this.menu.box.contains(this.historySeparator)) {
            this.menu.box.remove_child(this.historySeparator);
        }

        if (this.clipItemsRadioGroup.length === 0) {
            if (!this.menu.box.contains(this.emptyStateSection))
                this.#renderEmptyState();
            if (this.menu.box.contains(this.settingsMenuItem?.actor))
                this.menu.box.remove_child(this.settingsMenuItem.actor);

            let index = this.menu.box.get_n_children();
            if (this.config.showSettingsButton && this.settingsMenuItem)
                this.menu.box.insert_child_at_index(this.settingsMenuItem.actor, index++);
            return;
        }

        if (this.menu.box.contains(this.settingsMenuItem?.actor))
            this.menu.box.remove_child(this.settingsMenuItem.actor);
        if (this.menu.box.contains(this.clearMenuItem?.actor))
            this.menu.box.remove_child(this.clearMenuItem.actor);

        let index = this.menu.box.get_n_children();
        if (this.config.showSettingsButton && this.settingsMenuItem)
            this.menu.box.insert_child_at_index(this.settingsMenuItem.actor, index++);
        if (this.config.showClearHistoryButton && this.clearMenuItem && !PRIVATEMODE)
            this.menu.box.insert_child_at_index(this.clearMenuItem.actor, index++);
    }

    #renderEmptyState () {
        if (this._destroyed) return;
        this.#hideElements();
        this.menu.box.insert_child_at_index(this.emptyStateSection, 0);
    }

    // =========================================================================
    // Topbar / indicator content
    // =========================================================================

    #updateIndicatorContent (entry) {
        const mode = this.config.topbarDisplayMode;
        if (this.preventIndicatorUpdate || (mode !== 1 && mode !== 2)) {
            return;
        }

        if (!entry || this.config.privateMode) {
            this._buttonImgPreview.destroy_all_children();
            this._buttonText.set_text('...');
        } else {
            if (entry.isText()) {
                this._buttonText.set_text(truncate(entry.getStringValue(), this.config.topbarPreviewSize));
                this._buttonImgPreview.destroy_all_children();
            } else if (entry.isImage()) {
                this._buttonText.set_text('');
                this._buttonImgPreview.destroy_all_children();
                this.render.loadThumbnail(entry.id(), TOPBAR_THUMBNAIL_PX).then(img => {
                    img.add_style_class_name('clipboard-indicator-img-preview');
                    img.y_align = Clutter.ActorAlign.CENTER;
                    // icon only renders properly deferred (same workaround as original).
                    this._imagePreviewTimeout = setTimeout(() => {
                        this._buttonImgPreview.set_child(img);
                    }, 0);
                }).catch(e => console.error(e));
            }
        }
    }

    _blinkIcon () {
        if (!this.config.blinkIconOnCopy || !this.icon) return;

        this.set_style('background-color: rgba(255, 255, 255, 0.9);');
        this.icon.set_style('color: rgba(0, 0, 0, 0.9);');

        this._blinkAnimationTimeout = setTimeout(() => {
            this._blinkAnimationTimeout = null;
            this.set_style(null);
            this.icon.set_style(null);
        }, 200);
    }

    _updateTopbarLayout () {
        const mode = this.config.topbarDisplayMode;
        if (mode === 0) {
            this.icon.visible = true;
            this._buttonText.visible = false;
            this._buttonImgPreview.visible = false;
            this.show();
        }
        if (mode === 1) {
            this.icon.visible = false;
            this._buttonText.visible = true;
            this._buttonImgPreview.visible = true;
            this.show();
        }
        if (mode === 2) {
            this.icon.visible = true;
            this._buttonText.visible = true;
            this._buttonImgPreview.visible = true;
            this.show();
        }
        if (mode === 3) {
            this.hide();
        }
        this._downArrow.visible = !this.config.disableDownArrow;
    }

    // =========================================================================
    // Clipboard write (with image decode via EntryBytes)
    // =========================================================================

    #updateClipboard (entry) {
        entryClipboardPayload(entry, { storage: this.storage, codec: this.codec })
            .then(({ mimetype, bytesU8 }) => {
                if (this._destroyed) return;
                this.clipboard.setContent(mimetype, bytesU8);
            })
            .catch(e => console.error(e));
        this.#updateIndicatorContent(entry);
    }

    #clearClipboard () {
        this.clipboard.clear();
        this.#updateIndicatorContent(null);
    }

    // =========================================================================
    // Notifications
    // =========================================================================

    _initNotifSource () {
        if (!this._notifSource) {
            this._notifSource = new MessageTray.Source({
                title: 'Clipboard Indicator',
                'icon-name': INDICATOR_ICON
            });
            this._notifSource.connect('destroy', () => { this._notifSource = null; });
            Main.messageTray.add(this._notifSource);
        }
    }

    _destroyNotifSource () {
        if (this._notifSource) {
            this._notifSource.destroy();
            this._notifSource = null;
        }
    }

    _cancelNotification () {
        // Operate on the entries captured at copy time, NOT on array positions:
        // lazy search/cycle rendering can push unrelated rows onto
        // clipItemsRadioGroup, so [length-1]/[length-2] no longer identify the
        // just-copied / previous clip. Look up the live rows by key.
        const copiedEntry = this._lastCopiedEntry;
        const copiedRow = copiedEntry ? this._findRowByKey(copiedEntry.key()) : null;
        const previousClip = this._priorToCopyEntry
            ? this._findRowByKey(this._priorToCopyEntry.key())
            : null;

        if (previousClip) {
            this.#updateClipboard(previousClip.entry);
            previousClip.setOrnament(PopupMenu.Ornament.DOT);
            previousClip.icoBtn.visible = false;
            previousClip.currentlySelected = true;
        } else {
            this.#clearClipboard();
        }

        if (copiedRow) {
            this._removeEntry(copiedRow);
        }

        this._lastCopiedEntry = null;
        this._priorToCopyEntry = null;
    }

    _showNotification (message, transformFn) {
        const dndOn = () =>
            !Main.panel.statusArea.dateMenu._indicator._settings.get_boolean('show-banners');
        if (this.config.privateMode || dndOn()) return;

        let notification = null;
        this._initNotifSource();

        if (this._notifSource.count === 0) {
            notification = new MessageTray.Notification({
                source: this._notifSource,
                body: message,
                'is-transient': true
            });
        } else {
            notification = this._notifSource.notifications[0];
            notification.body = message;
            notification.clearActions();
        }

        if (typeof transformFn === 'function') transformFn(notification);
        this._notifSource.addNotification(notification);
    }

    _createHistoryLabel () {
        this._historyLabel = new St.Label({
            style_class: 'ci-notification-label',
            text: ''
        });
        global.stage.add_child(this._historyLabel);
        this._historyLabel.hide();
    }

    _removeHistoryLabel () {
        if (this._historyLabel) {
            if (this._historyLabel.get_parent()) {
                global.stage.remove_child(this._historyLabel);
            }
            this._historyLabel.destroy();
            this._historyLabel = null;
        }
    }

    // =========================================================================
    // Private mode
    // =========================================================================

    togglePrivateMode () {
        this.privateModeMenuItem.toggle();
    }

    _onPrivateModeSwitch () {
        const PRIVATEMODE = this.privateModeMenuItem.state;
        this.config.privateMode = PRIVATEMODE;
        this.scrollViewMenuSection.actor.visible = !PRIVATEMODE;
        this.scrollViewFavoritesMenuSection.actor.visible = !PRIVATEMODE;

        if (!PRIVATEMODE) {
            const selectList = this.clipItemsRadioGroup.filter(item => !!item.currentlySelected);
            if (selectList.length) {
                this._selectMenuItem(selectList[0]);
            } else {
                this.#clearClipboard();
            }

            this.clipboard.getContent().then(content => {
                if (!content) return;
                // Build a lightweight entry only for indicator content.
                this.#updateIndicatorContentFromContent(content);
            }).catch(e => console.error(e));

            this.hbox.remove_style_class_name('private-mode');
            this.#showElements();
        } else {
            this.hbox.add_style_class_name('private-mode');
            this.#updateIndicatorContent(null);
            this.#showElements();
        }
    }

    #updateIndicatorContentFromContent (content) {
        // Mirrors the original which fetched #getClipboardContent and rendered
        // it in the topbar. Build a transient entry so images render their
        // thumbnail exactly like the original (the hash is computed once here,
        // off the copy hot-path).
        let entry;
        try {
            if (content.mimetype.startsWith('image/')) {
                entry = ClipboardEntry.image(content.bytesU8, { mimetype: content.mimetype });
            } else {
                const text = new TextDecoder().decode(content.bytesU8);
                entry = ClipboardEntry.text(text, { mimetype: content.mimetype });
            }
        } catch (_) {
            return;
        }
        this.#updateIndicatorContent(entry);
    }

    // =========================================================================
    // Settings change handling
    // =========================================================================

    onSettingsChanged () {
        if (this._destroyed) return;
        try {
            // If the toggle is hidden but private mode is on, force it off.
            if (!this.config.showPrivateMode && this.config.privateMode && this.privateModeMenuItem) {
                this.privateModeMenuItem.setToggleState(false);
                this._onPrivateModeSwitch();
            }

            // Apply registry size change by trimming the model via the controller.
            this.controller.applyMaxSize(this.config.historySize);

            // Re-set labels / button visibility in case preview size or toggles changed.
            this._getAllIMenuItems().forEach(mItem => {
                setEntryLabel(mItem, this._rowCtx());
                mItem.pasteBtn.visible = this.config.pasteButton;
                mItem.icoBtn.visible = this.config.showDeleteButton;
                mItem.tagBtn.visible = this.config.showTagButton;
                mItem.icofavBtn.visible = this.config.showPinButton;
                if (mItem.editBtn) mItem.editBtn.visible = this.config.showEditButton;
                if (mItem.imagePreviewBtn) mItem.imagePreviewBtn.visible = this.config.showPreviewButton;
            });

            this._updateTopbarLayout();

            this.clipboard.getContent().then(content => {
                if (this._destroyed || !content) return;
                this.#updateIndicatorContentFromContent(content);
            }).catch(e => console.error(e));

            if (this.config.enableKeybinding) this._bindShortcuts();
            else this._unbindShortcuts();

            this.#showElements();
        } catch (e) {
            console.error('Clipboard Indicator: Failed to update on settings change');
            console.error(e);
        }
    }

    // =========================================================================
    // Keybindings
    // =========================================================================

    _bindShortcuts () {
        this._unbindShortcuts();
        this._bindShortcut(PrefsFields.BINDING_CLEAR_HISTORY, this._removeAll);
        this._bindShortcut(PrefsFields.BINDING_PREV_ENTRY, this._previousEntry);
        this._bindShortcut(PrefsFields.BINDING_NEXT_ENTRY, this._nextEntry);
        this._bindShortcut(PrefsFields.BINDING_TOGGLE_MENU, this._toggleMenu);
        this._bindShortcut(PrefsFields.BINDING_PRIVATE_MODE, this.togglePrivateMode);
    }

    _unbindShortcuts () {
        this._shortcutsBindingIds.forEach(id => Main.wm.removeKeybinding(id));
        this._shortcutsBindingIds = [];
    }

    _bindShortcut (name, cb) {
        Main.wm.addKeybinding(
            name,
            this.rawSettings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.ALL,
            cb.bind(this)
        );
        this._shortcutsBindingIds.push(name);
    }

    // =========================================================================
    // Cycling (iterates the MODEL order, not only rendered rows)
    // =========================================================================

    _clearDelayedSelectionTimeout () {
        if (this._delayedSelectionTimeoutId) {
            clearTimeout(this._delayedSelectionTimeoutId);
            this._delayedSelectionTimeoutId = null;
        }
    }

    _selectEntryWithDelay (menuItem) {
        this._selectMenuItem(menuItem, false);
        this._delayedSelectionTimeoutId = setTimeout(() => {
            this._selectMenuItem(menuItem);
            this._delayedSelectionTimeoutId = null;
        }, DELAYED_SELECTION_TIMEOUT);
    }

    /**
     * Build an ordered list of entries to cycle through. Mirrors the original
     * _getAllIMenuItems() order (history first, then favorites) but reads the
     * MODEL so items beyond the render cap are still reachable.
     */
    _cycleEntries () {
        return this.controller.modelHistory().concat(this.controller.modelFavorites());
    }

    _cycleStep (delta) {
        if (this.config.privateMode) return;
        this._clearDelayedSelectionTimeout();

        const entries = this._cycleEntries();
        if (entries.length === 0) return;

        const current = this._getCurrentlySelectedItem();
        let currentIndex = current
            ? entries.findIndex(e => e.key() === current.entry.key())
            : -1;
        if (currentIndex === -1) currentIndex = 0;

        let i = currentIndex + delta;
        if (i < 0) i = entries.length - 1;
        if (i >= entries.length) i = 0;

        const targetEntry = entries[i];
        const index = i + 1;

        if (this.config.notifyOnCycle) {
            this._showNotification(`${index} / ${entries.length}: ${targetEntry.getStringValue()}`);
        }

        // Ensure a row exists for the target so selection ornaments work.
        let mi = this._findRowByKey(targetEntry.key());
        if (!mi) {
            mi = this._renderRow(targetEntry, { prepend: false });
            this.#showElements();
        }

        if (this.config.moveItemFirst) {
            this._selectEntryWithDelay(mi);
        } else {
            this._selectMenuItem(mi);
        }
    }

    _previousEntry () {
        this._cycleStep(-1);
    }

    _nextEntry () {
        this._cycleStep(+1);
    }

    _toggleMenu () {
        if (!this.menu.isOpen && this.config.openAtCursor) {
            const [x, y] = global.get_pointer();
            this._cursorActor.set_position(x, y);
            this.menu.sourceActor = this._cursorActor;
        }
        this.menu.toggle();
    }

    // =========================================================================
    // Paste
    // =========================================================================

    #pasteItem (menuItem) {
        this.menu.close();
        const currentlySelected = this._getCurrentlySelectedItem();
        this.preventIndicatorUpdate = true;
        this.#updateClipboard(menuItem.entry);
        this._pastingKeypressTimeout = setTimeout(() => {
            if (this.keyboard.purpose === Clutter.InputContentPurpose.TERMINAL) {
                this.keyboard.press(Clutter.KEY_Control_L);
                this.keyboard.press(Clutter.KEY_Shift_L);
                this.keyboard.press(Clutter.KEY_Insert);
                this.keyboard.release(Clutter.KEY_Insert);
                this.keyboard.release(Clutter.KEY_Shift_L);
                this.keyboard.release(Clutter.KEY_Control_L);
            } else {
                this.keyboard.press(Clutter.KEY_Shift_L);
                this.keyboard.press(Clutter.KEY_Insert);
                this.keyboard.release(Clutter.KEY_Insert);
                this.keyboard.release(Clutter.KEY_Shift_L);
            }

            this._pastingResetTimeout = setTimeout(() => {
                this.preventIndicatorUpdate = false;
                if (currentlySelected && currentlySelected.entry)
                    this.#updateClipboard(currentlySelected.entry);
            }, 50);
        }, 50);
    }

    // =========================================================================
    // Image preview / dialogs
    // =========================================================================

    #showImagePreview (menuItem, reopenOnClose = false) {
        // 'h'-key path reopens the menu and re-focuses the originating row after
        // the preview closes (matches the original onClose callback at
        // extension.js:653-660). The preview-button click path passes
        // reopenOnClose=false, so the menu stays closed.
        const onClose = reopenOnClose
            ? () => {
                if (this._destroyed) return;
                this._focusItemOnOpen = menuItem;
                this.menu.open();
            }
            : () => {};
        this.preview.show(menuItem.entry, onClose);
        this.menu.close();
    }

    #showTagDialog (menuItem, reopenOnClose = false) {
        const dialog = new ModalDialog.ModalDialog({ destroyOnClose: true });

        const onDialogClose = () => {
            if (reopenOnClose) {
                this._focusItemOnOpen = menuItem;
                this.menu.open();
            }
        };

        const textEntry = new St.Entry({
            text: menuItem.entry.getTag() || '',
            hint_text: _('Enter tag…'),
            can_focus: true,
            x_expand: true,
            style: 'min-width: 300px;',
        });

        dialog.contentLayout.add_child(textEntry);

        dialog.addButton({
            label: _('Discard'),
            action: () => { dialog.close(); onDialogClose(); },
            key: Clutter.KEY_Escape,
        });

        dialog.addButton({
            label: _('Save'),
            action: () => {
                const tag = textEntry.get_text().trim() || null;
                this.controller.setTag(menuItem.entry, tag);
                updateTagLabel(menuItem);
                dialog.close();
                onDialogClose();
            },
            default: true,
        });

        dialog.open();
        textEntry.grab_key_focus();
    }

    #showEditDialog (menuItem, reopenOnClose = false) {
        const dialog = new ModalDialog.ModalDialog({ destroyOnClose: true });

        const onDialogClose = () => {
            if (reopenOnClose) {
                this._focusItemOnOpen = menuItem;
                this.menu.open();
            }
        };

        const scrollView = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: false,
            style: 'min-width: 400px; min-height: 100px; max-height: 400px;',
        });

        const clutterText = new Clutter.Text({
            text: menuItem.entry.getStringValue(),
            editable: true,
            reactive: true,
            single_line_mode: false,
            activatable: false,
            line_wrap: true,
        });

        const white = new Cogl.Color();
        white.init_from_4f(1.0, 1.0, 1.0, 1.0);
        const selectionBlue = new Cogl.Color();
        selectionBlue.init_from_4f(0.39, 0.59, 1.0, 0.71);
        clutterText.color = white;
        clutterText.selection_color = selectionBlue;
        clutterText.selected_text_color = white;

        const textBox = new St.BoxLayout({
            style_class: 'ci-edit-textbox',
            x_expand: true,
            y_expand: true,
            vertical: true,
        });
        textBox.add_child(clutterText);
        scrollView.add_child(textBox);
        dialog.contentLayout.add_child(scrollView);

        dialog.addButton({
            label: _('Discard'),
            action: () => { dialog.close(); onDialogClose(); },
            key: Clutter.KEY_Escape,
        });

        dialog.addButton({
            label: _('Save'),
            action: () => {
                const newText = clutterText.get_text();
                this.controller.updateText(menuItem.entry, newText);
                menuItem.clipContents = newText;
                setEntryLabel(menuItem, this._rowCtx());
                if (menuItem.currentlySelected)
                    this.#updateClipboard(menuItem.entry);
                dialog.close();
                onDialogClose();
            },
            default: true,
        });

        if (reopenOnClose) this.menu.close();
        dialog.open();
        clutterText.grab_key_focus();
    }

    // =========================================================================
    // Interval auto-clear (timer label + reset button)
    // =========================================================================

    _setupHistoryIntervalClearing () {
        if (this._intervalSettingChangedId) {
            this.rawSettings.disconnect(this._intervalSettingChangedId);
            this._intervalSettingChangedId = null;
        }
        if (this._intervalToggleChangedId) {
            this.rawSettings.disconnect(this._intervalToggleChangedId);
            this._intervalToggleChangedId = null;
        }
        if (this._historyClearTimeoutId) {
            clearTimeout(this._historyClearTimeoutId);
            this._historyClearTimeoutId = null;
        }

        this._intervalSettingChangedId = this.rawSettings.connect(
            `changed::${PrefsFields.CLEAR_HISTORY_INTERVAL}`,
            this._onHistoryIntervalClearSettingsChanged.bind(this));
        this._intervalToggleChangedId = this.rawSettings.connect(
            `changed::${PrefsFields.CLEAR_HISTORY_ON_INTERVAL}`,
            this._onHistoryIntervalClearSettingsChanged.bind(this));

        if (!this.config.clearHistoryOnInterval) {
            this._updateIntervalTimer();
            return;
        }

        const currentTime = Math.ceil(new Date().getTime() / 1000);
        const next = this.rawSettings.get_int(PrefsFields.NEXT_HISTORY_CLEAR);

        if (next === -1) {
            this._scheduleNextHistoryClear();
        } else if (next < currentTime) {
            this._clearHistory(true);
            this._scheduleNextHistoryClear();
        } else {
            if (this._historyClearTimeoutId) {
                clearTimeout(this._historyClearTimeoutId);
                this._historyClearTimeoutId = null;
            }
            if (this._timerIntervalId) {
                clearInterval(this._timerIntervalId);
                this._timerIntervalId = null;
            }
            const timeoutMs = (next - currentTime) * 1000;
            this._historyClearTimeoutId = setTimeout(() => {
                this._clearHistory(true);
                this._scheduleNextHistoryClear();
            }, timeoutMs);
            this._timerIntervalId = setInterval(() => this._updateIntervalTimer(), 1000);
        }
    }

    _onHistoryIntervalClearSettingsChanged (_settings, key) {
        if (key === PrefsFields.CLEAR_HISTORY_INTERVAL) {
            this._scheduleNextHistoryClear();
        } else if (key === PrefsFields.CLEAR_HISTORY_ON_INTERVAL) {
            if (this.config.clearHistoryOnInterval) {
                this._resetHistoryClearTimer();
                this._setupHistoryIntervalClearing();
            } else {
                this._resetHistoryClearTimer();
            }
        }
    }

    _scheduleNextHistoryClear () {
        clearInterval(this._timerIntervalId);
        if (this._historyClearTimeoutId) {
            clearTimeout(this._historyClearTimeoutId);
            this._historyClearTimeoutId = null;
        }

        if (!this.config.clearHistoryOnInterval) {
            this._resetHistoryClearTimer();
            return;
        }

        const currentTime = Math.ceil(new Date().getTime() / 1000);
        const next = currentTime + this.config.clearHistoryInterval * 60;
        const timeoutMs = (next - currentTime) * 1000;

        this.rawSettings.set_int(PrefsFields.NEXT_HISTORY_CLEAR, next);

        this._updateIntervalTimer();
        this._timerIntervalId = setInterval(() => this._updateIntervalTimer(), 1000);
        this._historyClearTimeoutId = setTimeout(() => {
            this._clearHistory(true);
            this._scheduleNextHistoryClear();
        }, timeoutMs);
    }

    _resetHistoryClearTimer () {
        if (this._historyClearTimeoutId) {
            clearTimeout(this._historyClearTimeoutId);
            this._historyClearTimeoutId = null;
        }
        clearInterval(this._timerIntervalId);
        this._timerIntervalId = null;
        this._updateIntervalTimer();
        this.rawSettings.set_int(PrefsFields.NEXT_HISTORY_CLEAR, -1);
    }

    _updateIntervalTimer () {
        this.resetTimerButton.visible = this.config.clearHistoryOnInterval;
        this.timerLabel.visible = this.config.clearHistoryOnInterval;
        if (!this.config.clearHistoryOnInterval) return;

        const currentTime = Math.ceil(new Date().getTime() / 1000);
        const next = this.rawSettings.get_int(PrefsFields.NEXT_HISTORY_CLEAR);
        const timeLeft = next - currentTime;

        if (timeLeft <= 0) {
            this.timerLabel.set_text('');
            return;
        }

        const hours = Math.floor(timeLeft / 3600);
        const minutes = Math.floor((timeLeft % 3600) / 60);
        const seconds = Math.floor(timeLeft % 60);

        let formattedTime = '';
        if (hours > 0) formattedTime += `${hours}h `;
        if (minutes > 0) formattedTime += `${minutes}m `;
        formattedTime += `${seconds}s`;
        this.timerLabel.set_text(formattedTime);
    }

    _disconnectIntervalSettings () {
        if (this._intervalSettingChangedId) {
            this.rawSettings.disconnect(this._intervalSettingChangedId);
            this._intervalSettingChangedId = null;
        }
        if (this._intervalToggleChangedId) {
            this.rawSettings.disconnect(this._intervalToggleChangedId);
            this._intervalToggleChangedId = null;
        }
    }

    // =========================================================================
    // Misc
    // =========================================================================

    _openSettings () {
        this.openSettings();
        this.menu.close();
    }

    #clearTimeouts () {
        if (this._imagePreviewTimeout) clearTimeout(this._imagePreviewTimeout);
        if (this._setFocusOnOpenTimeout) clearTimeout(this._setFocusOnOpenTimeout);
        if (this._pastingKeypressTimeout) clearTimeout(this._pastingKeypressTimeout);
        if (this._pastingResetTimeout) clearTimeout(this._pastingResetTimeout);
        if (this._historyClearTimeoutId) clearTimeout(this._historyClearTimeoutId);
        if (this._timerIntervalId) clearInterval(this._timerIntervalId);
        if (this._blinkAnimationTimeout) clearTimeout(this._blinkAnimationTimeout);
        if (this._renderIdleHandle != null) {
            this.scheduler.clearTimer(this._renderIdleHandle);
            this._renderIdleHandle = null;
        }
    }
});
