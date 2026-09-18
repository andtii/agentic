/**
 * `prepareImage` — shrink a picked image before the host uploads it.
 *
 * Downscales so the long edge is at most `maxEdge` (1568 px: the edge past
 * which vision models resize anyway), decoding with `createImageBitmap` and
 * drawing on an `OffscreenCanvas`, or on a `<canvas>` element where there is
 * none. Re-encodes as WebP, or JPEG where the browser cannot write WebP, and
 * keeps the result only when it is smaller than the original. GIFs (they may
 * animate) and SVGs (vector) pass through untouched, as does anything that
 * is not an image; any failure returns the original file — preparing is an
 * optimisation, never a reason an attachment fails.
 */

export interface PrepareImageOptions {
    /** The longest edge, in pixels. Default 1568. */
    readonly maxEdge?: number;
    /** Encoder quality, 0–1. Default 0.85. */
    readonly quality?: number;
}

/** Image types re-encoding would damage: animation, vectors. */
const UNTOUCHED = new Set(['image/gif', 'image/svg+xml']);

interface Surface {
    readonly ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
    encode(type: string, quality: number): Promise<Blob | null>;
}

function surface(width: number, height: number): Surface | undefined {
    if (typeof OffscreenCanvas === 'function') {
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        if (ctx) return { ctx, encode: (type, quality) => canvas.convertToBlob({ type, quality }) };
    }
    if (typeof document === 'undefined') return undefined;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    return { ctx, encode: (type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality)) };
}

/** Draw the bitmap and encode it: WebP first, JPEG (on white — it has no alpha) when WebP comes back as something else. */
async function encode(bitmap: ImageBitmap, width: number, height: number, quality: number): Promise<Blob | undefined> {
    const s = surface(width, height);
    if (!s) return undefined;
    s.ctx.drawImage(bitmap, 0, 0, width, height);
    // An encoder that cannot write the type falls back to PNG — the type says which happened.
    const webp = await s.encode('image/webp', quality);
    if (webp?.type === 'image/webp') return webp;
    s.ctx.globalCompositeOperation = 'destination-over';
    s.ctx.fillStyle = '#fff';
    s.ctx.fillRect(0, 0, width, height);
    const jpeg = await s.encode('image/jpeg', quality);
    return jpeg?.type === 'image/jpeg' ? jpeg : undefined;
}

const renamed = (name: string, type: string): string => `${name.replace(/\.[^./\\]+$/, '') || 'image'}.${type === 'image/webp' ? 'webp' : 'jpg'}`;

export async function prepareImage(file: File, options: PrepareImageOptions = {}): Promise<File> {
    const { maxEdge = 1568, quality = 0.85 } = options;
    if (!file.type.startsWith('image/') || UNTOUCHED.has(file.type)) return file;
    if (typeof createImageBitmap !== 'function') return file;
    let bitmap: ImageBitmap | undefined;
    try {
        bitmap = await createImageBitmap(file);
        const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const blob = await encode(bitmap, width, height, quality);
        if (!blob || blob.size >= file.size) return file;
        return new File([blob], renamed(file.name, blob.type), { type: blob.type, lastModified: file.lastModified });
    } catch {
        return file;
    } finally {
        bitmap?.close?.();
    }
}
