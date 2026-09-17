/**
 * Reading a posted form. Every form in this folder has two entry points to
 * the same model: the live `model=` binding when hydrated, and `FormData`
 * when the page posted before hydration (or with JS off). These helpers keep
 * the second path as strict as the first.
 */

/** The string value of one field, `''` when absent or a file. */
export function text(fd: FormData, name: string): string {
    const v = fd.get(name);
    return typeof v === 'string' ? v : '';
}

/** Every non-empty string posted under `name` (repeated hidden inputs, multi-selects). */
export function list(fd: FormData, name: string): string[] {
    return fd.getAll(name).filter((v): v is string => typeof v === 'string' && v !== '');
}

/** A checkbox or switch: present when checked (the browser posts `on`), absent otherwise. */
export function flag(fd: FormData, name: string): boolean {
    return fd.has(name);
}

/** A number field: `null` when empty or not a finite number. */
export function number(fd: FormData, name: string): number | null {
    const t = text(fd, name).trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
}

/** A JSON-carrying hidden input; `fallback` when absent or malformed. */
export function json<T>(fd: FormData, name: string, fallback: T): T {
    const t = text(fd, name);
    if (!t) return fallback;
    try {
        return JSON.parse(t) as T;
    } catch {
        return fallback;
    }
}
