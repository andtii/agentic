/** Small edge-safe helpers shared by the server and the client. */

export function newId(prefix: string): string {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/** ISO 8601 in UTC with millisecond precision (spec §5.6.1). */
export function isoTime(ms: number): string {
    return new Date(ms).toISOString();
}

export interface Deferred<T> {
    readonly promise: Promise<T>;
    resolve(value: T): void;
    reject(reason: unknown): void;
}

export function deferred<T = void>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/** Sleep, rejecting with an `AbortError` when `signal` fires first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(abortError(signal));
        const t = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(t);
            reject(abortError(signal!));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

export function abortError(signal: AbortSignal): Error {
    const reason: unknown = signal.reason;
    if (reason instanceof Error) return reason;
    const e = new Error(typeof reason === 'string' ? reason : 'aborted');
    e.name = 'AbortError';
    return e;
}

export function isAbort(e: unknown): boolean {
    return e instanceof Error && e.name === 'AbortError';
}
