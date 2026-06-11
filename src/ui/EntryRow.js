/* EntryRow — builds one PopupMenu.PopupMenuItem for a clipboard entry.
 *
 * Faithfully ported from the original extension.js _addEntry(): the same
 * preview/edit/favorite/paste/tag/delete buttons, the same key-press handlers
 * (Delete / p / v / h / e / t / Enter), tag label, ornament, and label
 * truncation behaviour.
 *
 * All state mutations are routed through the injected `ctx` callbacks (which the
 * Indicator wires to the ClipboardController), so this module owns no history
 * state of its own. Image thumbnails are loaded asynchronously via the render
 * port — and only when the row is actually created (the render cap means most
 * old rows are never built).
 */

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as AnimationUtils from 'resource:///org/gnome/shell/misc/animationUtils.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

// Thumbnail render resolution (logical px). The on-screen size is governed by
// the CSS class .clipboard-menu-img-preview (1.5em); this only sets the gicon's
// intrinsic resolution so it stays crisp. It is intentionally decoupled from the
// 'preview-size' setting, which counts text characters, not pixels.
const MENU_THUMBNAIL_PX = 32;

/**
 * Truncate a string to `length` chars, collapsing whitespace runs to a single
 * space (matches the original _truncate()).
 *
 * @param {string} string
 * @param {number} length
 * @returns {string}
 */
export function truncate (string, length) {
    let shortened = string.replace(/\s+/g, ' ');
    const chars = [...shortened];
    if (chars.length > length) {
        shortened = chars.slice(0, length - 1).join('') + '...';
    }
    return shortened;
}

/**
 * Set / refresh a menu item's label (text entries) or thumbnail (image entries).
 *
 * @param {object} menuItem
 * @param {object} ctx
 */
export function setEntryLabel (menuItem, ctx) {
    const { entry } = menuItem;
    if (entry.isText()) {
        menuItem.label.set_text(truncate(entry.getStringValue(), ctx.config.previewSize));
    } else if (entry.isImage()) {
        ctx.render.loadThumbnail(entry.id(), MENU_THUMBNAIL_PX).then(img => {
            if (menuItem._destroyed) return;
            img.add_style_class_name('clipboard-menu-img-preview');
            if (menuItem.previewImage) {
                menuItem.remove_child(menuItem.previewImage);
            }
            menuItem.previewImage = img;
            menuItem.insert_child_below(img, menuItem.label);
        }).catch(e => console.error(e));
    }
}

/**
 * Update (or remove) the tag label on a menu item.
 *
 * @param {object} menuItem
 */
export function updateTagLabel (menuItem) {
    if (menuItem.tagLabel) {
        menuItem.actor.remove_child(menuItem.tagLabel);
        menuItem.tagLabel.destroy();
        menuItem.tagLabel = null;
    }

    const tag = menuItem.entry.getTag();
    if (tag) {
        menuItem.tagLabel = new St.Label({
            text: tag,
            style_class: 'ci-tag-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        menuItem.actor.insert_child_above(menuItem.tagLabel, menuItem.label);
    }
}

/**
 * Build a fully-wired menu item for `entry`.
 *
 * ctx must provide:
 *   config           - live config bag (previewSize, pasteButton, show*Button…)
 *   render           - ImageRenderPort
 *   radioGroup       - the array all rows are pushed into (for selection logic)
 *   menu             - the PanelMenu.Button menu (set as menuItem.menu)
 *   favoritesScrollView / historyScrollView - for ensure-visible scrolling
 *   onActivate(menuItem)            - click / Enter handling
 *   onDelete(menuItem)              - delete button / Delete key
 *   onToggleFavorite(menuItem)      - favorite button / p key
 *   onPaste(menuItem)               - paste button / v key
 *   onEdit(menuItem)                - edit button / e key
 *   onTag(menuItem)                 - tag button / t key
 *   onPreview(menuItem, reopenOnClose) - preview button (reopen=false) / h key (reopen=true)
 *   selectNext(menuItem)            - move key focus to next visible row
 *
 * @param {object} opts
 * @param {import('../core/ClipboardEntry.js').ClipboardEntry} opts.entry
 * @param {object} opts.ctx
 * @returns {object} the PopupMenu.PopupMenuItem
 */
export function createEntryRow ({ entry, ctx }) {
    const { config } = ctx;
    const menuItem = new PopupMenu.PopupMenuItem('');

    menuItem.menu = ctx.menu;
    menuItem.entry = entry;
    menuItem.clipContents = entry.getStringValue();
    menuItem.radioGroup = ctx.radioGroup;
    menuItem._destroyed = false;
    menuItem.connect('destroy', () => { menuItem._destroyed = true; });

    // CLICK fix for Paste on Select: clicking behaves like Enter.
    menuItem.connect('activate', () => ctx.onActivate(menuItem));

    menuItem.connect('key-focus-in', () => {
        const viewToScroll = menuItem.entry.isFavorite()
            ? ctx.favoritesScrollView
            : ctx.historyScrollView;
        AnimationUtils.ensureActorVisibleInScrollView(viewToScroll, menuItem);
    });

    menuItem.actor.connect('key-press-event', (actor, event) => {
        switch (event.get_key_symbol()) {
            case Clutter.KEY_Delete:
                ctx.onDelete(menuItem);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_p:
                ctx.selectNext(menuItem);
                ctx.onToggleFavorite(menuItem);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_v:
                ctx.onPaste(menuItem);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_h:
                if (entry.isImage()) {
                    // 'h'-key path: reopen the menu and re-focus this row after
                    // the preview closes (matches the original onClose).
                    ctx.onPreview(menuItem, true);
                    return Clutter.EVENT_STOP;
                }
                break;
            case Clutter.KEY_e:
                if (entry.isText()) {
                    ctx.onEdit(menuItem);
                    return Clutter.EVENT_STOP;
                }
                break;
            case Clutter.KEY_t:
                ctx.onTag(menuItem);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_KP_Enter:
            case Clutter.KEY_Return:
                ctx.onActivate(menuItem);
                return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    });

    setEntryLabel(menuItem, ctx);

    if (entry.getTag()) {
        menuItem.tagLabel = new St.Label({
            text: entry.getTag(),
            style_class: 'ci-tag-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        menuItem.actor.add_child(menuItem.tagLabel);
    }

    menuItem.actionsSpacer = new St.Widget({ x_expand: true });
    menuItem.actor.add_child(menuItem.actionsSpacer);

    // Image preview button
    if (entry.isImage()) {
        menuItem.imagePreviewBtn = new St.Button({
            style_class: 'ci-action-btn',
            can_focus: true,
            accessible_name: _('Preview Image'),
            child: new St.Icon({
                icon_name: 'image-x-generic-symbolic',
                style_class: 'system-status-icon',
            }),
            visible: config.showPreviewButton,
            x_expand: false,
            y_expand: true,
        });
        menuItem.imagePreviewBtn.connect('clicked', () => ctx.onPreview(menuItem));
        menuItem.actor.add_child(menuItem.imagePreviewBtn);
    }

    // Edit button (text entries only)
    if (entry.isText()) {
        menuItem.editBtn = new St.Button({
            style_class: 'ci-action-btn',
            can_focus: true,
            accessible_name: _('Edit'),
            child: new St.Icon({
                icon_name: 'document-edit-symbolic',
                style_class: 'system-status-icon',
            }),
            visible: config.showEditButton,
            x_expand: false,
            y_expand: true,
        });
        menuItem.editBtn.connect('clicked', () => ctx.onEdit(menuItem));
        menuItem.actor.add_child(menuItem.editBtn);
    }

    // Favorite button
    const iconfav = new St.Icon({
        icon_name: 'view-pin-symbolic',
        style_class: 'system-status-icon',
    });
    const icofavBtn = new St.Button({
        style_class: 'ci-pin-btn ci-action-btn',
        can_focus: true,
        child: iconfav,
        visible: config.showPinButton,
        x_expand: false,
        y_expand: true,
    });
    menuItem.actor.add_child(icofavBtn);
    menuItem.icofavBtn = icofavBtn;
    menuItem.favoritePressId = icofavBtn.connect('clicked',
        () => ctx.onToggleFavorite(menuItem));

    // Paste button
    menuItem.pasteBtn = new St.Button({
        style_class: 'ci-action-btn',
        can_focus: true,
        accessible_name: _('Paste'),
        child: new St.Icon({
            icon_name: 'edit-paste-symbolic',
            style_class: 'system-status-icon',
        }),
        x_expand: false,
        y_expand: true,
        visible: config.pasteButton,
    });
    menuItem.pasteBtn.connect('clicked', () => ctx.onPaste(menuItem));
    menuItem.actor.add_child(menuItem.pasteBtn);

    // Tag button
    const tagIcon = new St.Icon({
        icon_name: 'user-bookmarks-symbolic',
        style_class: 'system-status-icon',
    });
    menuItem.tagBtn = new St.Button({
        style_class: 'ci-action-btn',
        can_focus: true,
        child: tagIcon,
        visible: config.showTagButton,
        x_expand: false,
        y_expand: true,
    });
    menuItem.tagBtn.connect('clicked', () => ctx.onTag(menuItem));
    menuItem.actor.add_child(menuItem.tagBtn);

    // Delete button
    const icon = new St.Icon({
        icon_name: 'edit-delete-symbolic',
        style_class: 'system-status-icon',
    });
    const icoBtn = new St.Button({
        style_class: 'ci-action-btn',
        can_focus: true,
        child: icon,
        visible: config.showDeleteButton,
        x_expand: false,
        y_expand: true,
    });
    menuItem.actor.add_child(icoBtn);
    menuItem.icoBtn = icoBtn;
    menuItem.deletePressId = icoBtn.connect('clicked', () => ctx.onDelete(menuItem));

    return menuItem;
}
