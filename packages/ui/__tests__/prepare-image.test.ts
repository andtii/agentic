/**
 * `prepareImage`: downscale and re-encode when that is smaller, and otherwise
 * — an untouched type, no decoder, a failure, a bigger result — hand back
 * the original file.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { prepareImage } from '../src';

const image = (type: string, bytes = 1000, name = 'photo.png'): File => new File([new Uint8Array(bytes)], name, { type });

/** A stub `OffscreenCanvas` whose encoder answers with `encoded(type)` and records what it drew. */
function stubCanvas(encoded: (type: string) => Blob | null) {
    const drawn: { width: number; height: number }[] = [];
    const types: string[] = [];
    class FakeOffscreenCanvas {
        constructor(
            readonly width: number,
            readonly height: number
        ) {}
        getContext() {
            return {
                drawImage: (_: unknown, __: number, ___: number, width: number, height: number) => drawn.push({ width, height }),
                fillRect: () => {},
                fillStyle: '',
                globalCompositeOperation: ''
            };
        }
        convertToBlob({ type }: { type: string }) {
            types.push(type);
            return Promise.resolve(encoded(type));
        }
    }
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    return { drawn, types };
}

const bitmap = (width: number, height: number) => ({ width, height, close: vi.fn() });

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('prepareImage', () => {
    it('leaves non-images, GIFs and SVGs untouched', async () => {
        const decode = vi.fn();
        vi.stubGlobal('createImageBitmap', decode);
        for (const file of [image('text/plain', 10, 'a.txt'), image('image/gif', 10, 'a.gif'), image('image/svg+xml', 10, 'a.svg')]) {
            expect(await prepareImage(file)).toBe(file);
        }
        expect(decode).not.toHaveBeenCalled();
    });

    it('returns the original where the browser cannot decode', async () => {
        vi.stubGlobal('createImageBitmap', undefined);
        const file = image('image/png');
        expect(await prepareImage(file)).toBe(file);
    });

    it('returns the original on any failure', async () => {
        vi.stubGlobal('createImageBitmap', () => Promise.reject(new Error('corrupt')));
        const file = image('image/png');
        expect(await prepareImage(file)).toBe(file);
        const b = bitmap(10, 10);
        vi.stubGlobal('createImageBitmap', () => Promise.resolve(b));
        stubCanvas(() => {
            throw new Error('encoder died');
        });
        expect(await prepareImage(file)).toBe(file);
        expect(b.close).toHaveBeenCalled();
    });

    it('downscales to maxEdge and re-encodes as WebP when smaller', async () => {
        vi.stubGlobal('createImageBitmap', () => Promise.resolve(bitmap(4000, 2000)));
        const { drawn } = stubCanvas((type) => new Blob([new Uint8Array(100)], { type }));
        const file = image('image/png', 1000, 'photo.png');
        const out = await prepareImage(file);
        expect(drawn).toEqual([{ width: 1568, height: 784 }]);
        expect(out).not.toBe(file);
        expect(out.type).toBe('image/webp');
        expect(out.name).toBe('photo.webp');
        expect(out.size).toBe(100);
    });

    it('honours maxEdge and never upscales', async () => {
        vi.stubGlobal('createImageBitmap', () => Promise.resolve(bitmap(300, 200)));
        const { drawn } = stubCanvas((type) => new Blob([new Uint8Array(10)], { type }));
        await prepareImage(image('image/png'), { maxEdge: 1000 });
        expect(drawn).toEqual([{ width: 300, height: 200 }]);
    });

    it('falls back to JPEG when the encoder cannot write WebP', async () => {
        vi.stubGlobal('createImageBitmap', () => Promise.resolve(bitmap(100, 100)));
        // An encoder without WebP answers with PNG.
        const { types } = stubCanvas((type) => new Blob([new Uint8Array(100)], { type: type === 'image/webp' ? 'image/png' : type }));
        const out = await prepareImage(image('image/png', 1000, 'scan.png'), { quality: 0.7 });
        expect(types).toEqual(['image/webp', 'image/jpeg']);
        expect(out.type).toBe('image/jpeg');
        expect(out.name).toBe('scan.jpg');
    });

    it('keeps the original when the re-encoded file is not smaller', async () => {
        vi.stubGlobal('createImageBitmap', () => Promise.resolve(bitmap(100, 100)));
        stubCanvas((type) => new Blob([new Uint8Array(5000)], { type }));
        const file = image('image/jpeg', 1000, 'small.jpg');
        expect(await prepareImage(file)).toBe(file);
    });
});
