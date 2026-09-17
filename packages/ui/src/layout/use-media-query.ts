import { onMounted, onUnmounted, signal } from '@sigx/runtime-core';

/** A read-only boolean signal: `matches.value`. */
export interface MediaQueryMatch {
    readonly value: boolean;
}

/**
 * Reactive `matchMedia` — a media query as a boolean signal.
 *
 * Call it in a component's setup. On the server it reads `false` and never
 * subscribes; in the browser it still starts at `false` and reads the real
 * match on mount, so server markup and the first client render agree and
 * hydration never sees a mismatch. The listener detaches on unmount.
 */
export function useMediaQuery(query: string): MediaQueryMatch {
    const matches = signal(false);
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return matches;

    let mql: MediaQueryList | undefined;
    const onChange = (e: MediaQueryListEvent) => { matches.value = e.matches; };
    onMounted(() => {
        mql = window.matchMedia(query);
        matches.value = mql.matches;
        mql.addEventListener('change', onChange);
    });
    onUnmounted(() => mql?.removeEventListener('change', onChange));
    return matches;
}
