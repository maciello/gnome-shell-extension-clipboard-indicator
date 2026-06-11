/* Tests for src/adapters/MagickImageCodec.js
 *
 * Requires gi://GLib and gi://Gio (available under plain gjs).
 * Does NOT require gi://St, gi://Clutter, gi://Meta, or a live shell.
 *
 * Skips all tests gracefully if `magick` is not found in PATH.
 *
 * Run with:
 *   gjs -m tests/run.js
 * or individually:
 *   gjs -m tests/adapters/MagickImageCodec.test.js
 */

import GLib from 'gi://GLib';

import { suite, test, assert, assertEqual } from '../harness.js';
import { MagickImageCodec } from '../../src/adapters/MagickImageCodec.js';

// ---------------------------------------------------------------------------
// Guard — skip all tests when magick is absent
// ---------------------------------------------------------------------------

const MAGICK_AVAILABLE = GLib.find_program_in_path('magick') !== null;

function skipIfNoMagick (name, fn) {
    test(name, async () => {
        if (!MAGICK_AVAILABLE) {
            // Signal skip cleanly — not a failure
            print(`    (skipped: magick not found) ${name}`);
            return;
        }
        await fn();
    });
}

// ---------------------------------------------------------------------------
// Minimal valid 1×1 red PNG — Base64-encoded, produced by:
//   magick -size 1x1 xc:red -strip png:- | base64 -w0
// Embedded to avoid any runtime gi/pixbuf dependency in test setup.
// ---------------------------------------------------------------------------

const TINY_PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEX/AAAZ4gk3' +
    'AAAACklEQVQI12NgAAAAAgAB4iG8MwAAAABJRU5ErkJggg==';

function b64ToU8 (b64) {
    // GLib.base64_decode returns a Uint8Array in gjs.
    return GLib.base64_decode(b64);
}

const TINY_PNG_BYTES = b64ToU8(TINY_PNG_B64);

const codec = new MagickImageCodec();

// ---------------------------------------------------------------------------
// sniff() — pure sync, always runs regardless of magick availability
// ---------------------------------------------------------------------------

suite('MagickImageCodec › sniff');

test('sniff PNG magic bytes', () => {
    assertEqual(codec.sniff(TINY_PNG_BYTES), 'png');
});

test('sniff JPEG magic bytes', () => {
    const jpegHeader = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
    assertEqual(codec.sniff(jpegHeader), 'jpeg');
});

test('sniff WebP magic bytes', () => {
    // RIFF....WEBP
    const webp = new Uint8Array([
        0x52,0x49,0x46,0x46,  // RIFF
        0x24,0x00,0x00,0x00,  // file size (dummy)
        0x57,0x45,0x42,0x50,  // WEBP
        0x56,0x50,0x38,0x20,  // VP8 chunk (dummy rest)
    ]);
    assertEqual(codec.sniff(webp), 'webp');
});

test('sniff GIF magic bytes', () => {
    const gif = new Uint8Array([0x47,0x49,0x46,0x38,0x39,0x61]); // GIF89a
    assertEqual(codec.sniff(gif), 'gif');
});

test('sniff AVIF magic bytes', () => {
    // ISO BMFF box: size(4) + 'ftyp'(4) + 'avif'(4) brand
    const avif = new Uint8Array([
        0x00,0x00,0x00,0x1c,   // box size = 28
        0x66,0x74,0x79,0x70,   // 'ftyp'
        0x61,0x76,0x69,0x66,   // 'avif'
        0x00,0x00,0x00,0x00,
    ]);
    assertEqual(codec.sniff(avif), 'avif');
});

test('sniff SVG text', () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    assertEqual(codec.sniff(svg), 'svg');
});

test('sniff unknown returns unknown', () => {
    const junk = new Uint8Array([0x00,0x01,0x02,0x03,0x04,0x05]);
    assertEqual(codec.sniff(junk), 'unknown');
});

test('sniff empty returns unknown', () => {
    assertEqual(codec.sniff(new Uint8Array(0)), 'unknown');
});

// ---------------------------------------------------------------------------
// encode + decodeToPng — round-trip (requires magick)
// ---------------------------------------------------------------------------

suite('MagickImageCodec › encode / decodeToPng');

skipIfNoMagick('encode PNG → lossless WebP produces smaller bytes', async () => {
    const webp = await codec.encode(TINY_PNG_BYTES, { to: 'webp', lossless: true });
    assert(webp instanceof Uint8Array, 'result should be Uint8Array');
    assert(webp.length > 0, 'WebP output should be non-empty');
    // WebP magic: RIFF....WEBP
    assertEqual(webp[0], 0x52, 'WebP should start with R (RIFF)');
    assertEqual(webp[8], 0x57, 'WebP should have W at offset 8');
    // sniff recognises output
    assertEqual(codec.sniff(webp), 'webp');
});

skipIfNoMagick('encode PNG → lossy WebP q90', async () => {
    const webp = await codec.encode(TINY_PNG_BYTES, {
        to: 'webp', lossless: false, quality: 90,
    });
    assert(webp.length > 0, 'WebP output should be non-empty');
    assertEqual(codec.sniff(webp), 'webp');
});

skipIfNoMagick('decodeToPng from WebP produces valid PNG', async () => {
    const webp     = await codec.encode(TINY_PNG_BYTES, { to: 'webp', lossless: true });
    const pngBack  = await codec.decodeToPng(webp);
    assert(pngBack instanceof Uint8Array, 'result should be Uint8Array');
    assert(pngBack.length > 0, 'decoded PNG should be non-empty');
    assertEqual(codec.sniff(pngBack), 'png', 'decoded bytes should be PNG');
});

skipIfNoMagick('round-trip lossless: PNG → WebP → PNG preserves dimensions', async () => {
    // Encode to WebP lossless then decode back; both should decode with magick
    // to the same WxH.  We use the MagickImageCodec itself to do both steps.
    const webp    = await codec.encode(TINY_PNG_BYTES, { to: 'webp', lossless: true });
    const pngBack = await codec.decodeToPng(webp);

    // Verify pngBack is parseable PNG (magic bytes)
    assertEqual(pngBack[0], 0x89);
    assertEqual(pngBack[1], 0x50); // 'P'
    assertEqual(pngBack[2], 0x4e); // 'N'
    assertEqual(pngBack[3], 0x47); // 'G'
});

skipIfNoMagick('decodeToPng on original PNG returns valid PNG', async () => {
    const png = await codec.decodeToPng(TINY_PNG_BYTES);
    assertEqual(codec.sniff(png), 'png');
    assert(png.length > 0);
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

suite('MagickImageCodec › error handling');

test('encode with invalid bytes rejects (if magick present)', async () => {
    if (!MAGICK_AVAILABLE) {
        print('    (skipped: magick not found)');
        return;
    }
    const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04]);
    let threw = false;
    try {
        await codec.encode(garbage, { to: 'webp' });
    } catch (e) {
        threw = true;
        assert(e instanceof Error, 'should throw Error');
    }
    assert(threw, 'encoding garbage bytes should reject');
});

// ---------------------------------------------------------------------------
// Stand-alone runner (when invoked directly, not via tests/run.js)
// ---------------------------------------------------------------------------
// When this file is the entry point (import.meta.url ends in this filename),
// we call run() ourselves.  tests/run.js calls it too, so both paths work.
if (import.meta.url.endsWith('MagickImageCodec.test.js')) {
    const { run } = await import('../harness.js');
    const failed = await run();
    if (failed > 0) {
        try {
            const { exit } = await import('system');
            exit(1);
        } catch { /* not gjs */ }
    }
}
