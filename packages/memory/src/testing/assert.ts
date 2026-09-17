/** Throwing assertions for the conformance suite — no test-runner import, so `./testing` loads under plain Node. */

export class MemoryConformanceError extends Error {
    override readonly name = 'MemoryConformanceError';
}

export function fail(message: string): never {
    throw new MemoryConformanceError(message);
}

export function assert(condition: unknown, message: string): asserts condition {
    if (!condition) fail(message);
}

/** Structural equality through JSON — the shape entries have after any wire hop. */
export function jsonEqual(a: unknown, b: unknown): boolean {
    return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(value as object).sort()) {
            const v = (value as Record<string, unknown>)[k];
            if (v !== undefined) out[k] = canonical(v);
        }
        return out;
    }
    return value;
}

export function assertEqual(actual: unknown, expected: unknown, message: string): void {
    if (!jsonEqual(actual, expected)) fail(`${message}\n  expected: ${JSON.stringify(canonical(expected))}\n  actual:   ${JSON.stringify(canonical(actual))}`);
}

export async function assertRejects(run: () => Promise<unknown>, message: string): Promise<unknown> {
    try {
        await run();
    } catch (error) {
        return error;
    }
    return fail(message);
}
