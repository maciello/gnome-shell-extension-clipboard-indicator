/* StSelectionClipboard — ClipboardPort adapter for the live GNOME Shell.
 *
 * Uses:
 *   - Shell.Global / Meta.Display.get_selection() → 'owner-changed' signal
 *     to detect clipboard changes.
 *   - St.Clipboard.get_default().get_content() to read content.
 *   - St.Clipboard.get_default().set_content() to write content.
 *
 * MIME priority list mirrors the original #getClipboardContent() order:
 *   text/plain;charset=utf-8, UTF8_STRING (remapped), text/plain, STRING,
 *   image/gif, image/png, image/jpg, image/jpeg, image/webp, image/svg+xml,
 *   text/html.
 *
 * The UTF8_STRING → text/plain;charset=utf-8 remap hack is reproduced here.
 *
 * NOTE: This file may NOT be unit-tested headless (imports gi://St, gi://Meta,
 * gi://Shell, gi://GLib).  Correctness is verified by reading against the
 * original extension.js behavior.
 */

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import { ClipboardPort } from '../ports/ClipboardPort.js';

const CLIPBOARD_TYPE = St.ClipboardType.CLIPBOARD;

/** Ordered MIME types to probe, highest priority first. */
const MIME_PRIORITY = [
    'text/plain;charset=utf-8',
    'UTF8_STRING',
    'text/plain',
    'STRING',
    'image/gif',
    'image/png',
    'image/jpg',
    'image/jpeg',
    'image/webp',
    'image/svg+xml',
    'text/html',
];

export class StSelectionClipboard extends ClipboardPort {
    #clipboard  = null;
    #selection  = null;
    #listenerId = null;

    constructor () {
        super();
        this.#clipboard = St.Clipboard.get_default();

        const metaDisplay = Shell.Global.get().get_display();
        this.#selection = metaDisplay.get_selection();
    }

    /**
     * Subscribe to clipboard owner-change events.
     * Filters to SELECTION_CLIPBOARD only (ignores primary / secondary).
     *
     * @param {() => void} cb
     * @returns {() => void} disconnect function
     */
    onChange (cb) {
        if (this.#listenerId !== null) {
            // Allow multiple subscribers by chaining; for our single-consumer
            // usage there will only be one at a time — just warn and replace.
            console.warn('StSelectionClipboard.onChange: replacing existing listener');
            this.#selection.disconnect(this.#listenerId);
            this.#listenerId = null;
        }

        const id = this.#selection.connect(
            'owner-changed',
            (_selection, selectionType, _selectionSource) => {
                if (selectionType === Meta.SelectionType.SELECTION_CLIPBOARD) {
                    cb();
                }
            }
        );

        this.#listenerId = id;

        return () => {
            if (this.#listenerId === id) {
                this.#selection.disconnect(id);
                this.#listenerId = null;
            }
        };
    }

    /**
     * Read clipboard content.
     * Iterates MIME_PRIORITY and returns the first non-empty result.
     * Applies the UTF8_STRING → text/plain;charset=utf-8 remap hack.
     *
     * @returns {Promise<{mimetype: string, bytesU8: Uint8Array}|null>}
     */
    async getContent () {
        for (let type of MIME_PRIORITY) {
            const result = await new Promise(resolve => {
                this.#clipboard.get_content(CLIPBOARD_TYPE, type, (clipboard, bytes) => {
                    if (bytes === null || bytes.get_size() === 0) {
                        resolve(null);
                        return;
                    }

                    // HACK: workaround for GNOME 2nd+ copy mangling mimetypes
                    // https://gitlab.gnome.org/GNOME/gnome-shell/-/issues/8233
                    let effectiveType = type;
                    if (type === 'UTF8_STRING') {
                        effectiveType = 'text/plain;charset=utf-8';
                    }

                    const data = bytes.get_data();
                    // get_data() returns Uint8Array in modern gjs; guard for null
                    if (!data) {
                        resolve(null);
                        return;
                    }

                    resolve({ mimetype: effectiveType, bytesU8: data });
                });
            });

            if (result !== null) {
                return result;
            }
        }

        return null;
    }

    /**
     * Write content to the clipboard.
     *
     * @param {string}     mimetype
     * @param {Uint8Array} bytesU8
     */
    setContent (mimetype, bytesU8) {
        try {
            const glibBytes = GLib.Bytes.new(bytesU8);
            this.#clipboard.set_content(CLIPBOARD_TYPE, mimetype, glibBytes);
        } catch (e) {
            console.error('StSelectionClipboard.setContent: failed to write clipboard');
            console.error(e);
        }
    }

    /**
     * Clear the clipboard by writing an empty string.
     */
    clear () {
        try {
            this.#clipboard.set_text(CLIPBOARD_TYPE, '');
        } catch (e) {
            console.error('StSelectionClipboard.clear: failed to clear clipboard');
            console.error(e);
        }
    }

    /**
     * Disconnect any outstanding listener.
     * Call during extension disable / cleanup.
     */
    destroy () {
        if (this.#listenerId !== null) {
            this.#selection.disconnect(this.#listenerId);
            this.#listenerId = null;
        }
    }
}
