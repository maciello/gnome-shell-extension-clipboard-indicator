/* ClipboardPort — abstract contract for clipboard read/write/watch.
 *
 * The production adapter wraps St.Clipboard / Meta.Display; test doubles can
 * operate against an in-memory variable.  No gi imports here.
 *
 * Clipboard content is represented as raw bytes + a MIME type string.
 * The adapter is responsible for bridging the platform's clipboard atoms
 * (e.g. 'UTF8_STRING', 'STRING', 'image/png') to a normalised mimetype.
 *
 * Change notifications are subscription-based: callers pass a callback to
 * onChange() and receive a disconnect function they must call during cleanup.
 */

export class ClipboardPort {
    /**
     * Subscribe to clipboard-change events.
     * The callback is invoked (with no arguments) whenever the clipboard owner
     * changes.  The returned function, when called, cancels the subscription.
     *
     * Implementations must not invoke the callback synchronously within
     * onChange() itself; the first notification must come from a future tick.
     *
     * @param {() => void} cb
     * @returns {() => void} disconnectFn — call once to stop receiving events
     */
    onChange (cb) {
        throw new Error('ClipboardPort.onChange() not implemented');
    }

    /**
     * Read the current clipboard contents.
     * Returns null when the clipboard is empty or the content type is not
     * supported (e.g. complex X11 selection types the extension ignores).
     *
     * The returned `bytesU8` is always a Uint8Array, even for text.
     * Callers use the `mimetype` to decide whether to decode it as UTF-8 or
     * treat it as opaque image data.
     *
     * @returns {Promise<{mimetype: string, bytesU8: Uint8Array}|null>}
     */
    async getContent () {
        throw new Error('ClipboardPort.getContent() not implemented');
    }

    /**
     * Write content to the clipboard.
     * The call is fire-and-forget; errors are handled by the implementation
     * (e.g. logged but not thrown, because a clipboard write failure is
     * non-fatal).
     *
     * @param {string}     mimetype - e.g. 'text/plain;charset=utf-8', 'image/png'
     * @param {Uint8Array} bytesU8  - raw bytes to place on the clipboard
     * @returns {void}
     */
    setContent (mimetype, bytesU8) {
        throw new Error('ClipboardPort.setContent() not implemented');
    }

    /**
     * Clear the clipboard (set empty content).
     * Fire-and-forget; errors are swallowed by the implementation.
     *
     * @returns {void}
     */
    clear () {
        throw new Error('ClipboardPort.clear() not implemented');
    }
}
