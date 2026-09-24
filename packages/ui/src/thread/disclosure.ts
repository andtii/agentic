/**
 * The open state of a zero `Collapsible` that follows a default until the
 * reader toggles it — bind `model={() => d.open}` and
 * `onOpenChange={() => { d.touched = true; }}`. While untouched, `open`
 * tracks `follow()` (a reasoning block open while it streams, a sub-agent's
 * work open while it runs); once the reader has toggled, their choice wins
 * over every later default, so a streaming update never re-opens or folds
 * what the reader set. Call it in a component's setup.
 */
import { signal, watch } from '@sigx/reactivity';

export interface Disclosure {
    open: boolean;
    /** The reader has toggled; the default no longer moves `open`. */
    touched: boolean;
}

export function followDisclosure(follow: () => boolean): Disclosure {
    const st = signal<Disclosure>({ open: follow(), touched: false });
    watch(follow, (open) => {
        if (!st.touched) st.open = open;
    });
    return st;
}
