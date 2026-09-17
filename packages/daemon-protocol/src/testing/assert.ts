/** Throwing assertions for the conformance suite — no test-runner import, so `./testing` loads anywhere. */

export class ConformanceError extends Error {
    override readonly name = 'ConformanceError';
}

export function fail(message: string): never {
    throw new ConformanceError(message);
}

export function assert(condition: unknown, message: string): asserts condition {
    if (!condition) fail(message);
}

export function assertEqual(actual: unknown, expected: unknown, message: string): void {
    if (!jsonEqual(actual, expected)) fail(`${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
}

/** Structural equality over JSON values; `undefined` properties count as absent. */
export function jsonEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        return a.every((v, i) => jsonEqual(v, b[i]));
    }
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    const ra = a as Record<string, unknown>;
    const rb = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
    for (const k of keys) if (!jsonEqual(ra[k], rb[k])) return false;
    return true;
}

/** Settle `promise` within `ms`, or fail with `what`; `total` is the budget the message reports when `ms` is what is left of it. */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string, total = ms): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new ConformanceError(`timed out after ${total} ms waiting for ${what}`)), ms);
        promise.then(
            (v) => {
                clearTimeout(timer);
                resolve(v);
            },
            (e: unknown) => {
                clearTimeout(timer);
                reject(e instanceof Error ? e : new Error(String(e)));
            }
        );
    });
}
