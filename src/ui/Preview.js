/* Preview — full-screen image preview overlay.
 *
 * Ported faithfully from the original extension.js #showImagePreview /
 * #closeImagePreview pair. Renders a dimmed full-monitor overlay with the
 * image centred and scaled to fit; click or Escape closes it.
 *
 * The texture is loaded asynchronously via the injected ImageRenderPort
 * (StTextureImage.loadTexture), so the main loop never blocks.
 */

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class Preview {
    /** @type {import('../ports/ImageRenderPort.js').ImageRenderPort} */
    #render;
    /** @type {St.Widget|null} */
    #overlay = null;

    /**
     * @param {object} opts
     * @param {import('../ports/ImageRenderPort.js').ImageRenderPort} opts.render
     */
    constructor ({ render }) {
        this.#render = render;
    }

    /**
     * Show the preview overlay for the given image entry.
     *
     * @param {import('../core/ClipboardEntry.js').ClipboardEntry} entry
     * @param {(() => void)|null} onClose - invoked after the overlay closes
     */
    show (entry, onClose = null) {
        this.close();

        const monitor = Main.layoutManager.currentMonitor;

        const overlay = new St.Widget({
            reactive: true,
            can_focus: true,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
            style: 'background-color: rgba(0, 0, 0, 0.75);',
        });

        this.#overlay = overlay;
        global.stage.add_child(overlay);
        overlay.grab_key_focus();

        const close = () => {
            this.close();
            if (onClose) onClose();
        };

        overlay._previewClickId = overlay.connect('button-press-event', () => {
            close();
            return Clutter.EVENT_STOP;
        });

        overlay._previewKeyId = overlay.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        const maxW = Math.floor(monitor.width * 0.5);
        const maxH = Math.floor(monitor.height * 0.4);

        const bin = new St.Bin({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        bin.add_constraint(new Clutter.AlignConstraint({
            source: overlay,
            align_axis: Clutter.AlignAxis.X_AXIS,
            factor: 0.5,
        }));
        bin.add_constraint(new Clutter.AlignConstraint({
            source: overlay,
            align_axis: Clutter.AlignAxis.Y_AXIS,
            factor: 0.5,
        }));
        overlay.add_child(bin);

        this.#render.loadTexture(entry.id()).then(actor => {
            if (this.#overlay !== overlay) return;
            if (!actor) return;

            let contentHandlerId = actor.connect('notify::content', () => {
                const [, natW] = actor.get_preferred_width(-1);
                const [, natH] = actor.get_preferred_height(-1);

                if (natW > 0 && natH > 0) {
                    actor.disconnect(contentHandlerId);
                    contentHandlerId = null;
                    const scale = Math.min(1, maxW / natW, maxH / natH);
                    bin.set_size(Math.round(natW * scale), Math.round(natH * scale));
                }
            });

            actor.connect('destroy', () => {
                if (contentHandlerId) {
                    actor.disconnect(contentHandlerId);
                    contentHandlerId = null;
                }
            });

            bin.set_child(actor);
        }).catch(e => {
            console.error('Clipboard Indicator: failed to load image preview');
            console.error(e);
        });
    }

    /** Close and destroy the overlay if open. */
    close () {
        if (!this.#overlay) return;

        const overlay = this.#overlay;
        this.#overlay = null;

        if (overlay._previewClickId) overlay.disconnect(overlay._previewClickId);
        if (overlay._previewKeyId) overlay.disconnect(overlay._previewKeyId);

        if (overlay.get_parent()) global.stage.remove_child(overlay);
        overlay.destroy();
    }

    destroy () {
        this.close();
    }
}
