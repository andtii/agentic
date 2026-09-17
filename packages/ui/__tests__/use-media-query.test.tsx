import { component } from '@sigx/runtime-core';
import { render } from '@sigx/runtime-dom';
import { useMediaQuery } from '../src/index';

type Listener = (e: { matches: boolean }) => void;

/** A controllable matchMedia: one list per query, `fire()` flips it. */
function fakeMatchMedia(initial: boolean) {
    const listeners = new Set<Listener>();
    const list = {
        matches: initial,
        media: '',
        addEventListener: (_: string, fn: Listener) => { listeners.add(fn); },
        removeEventListener: (_: string, fn: Listener) => { listeners.delete(fn); }
    };
    const matchMedia = vi.fn(() => list as unknown as MediaQueryList);
    const fire = (matches: boolean) => { list.matches = matches; for (const fn of listeners) fn({ matches }); };
    return { matchMedia, fire, listeners };
}

describe('useMediaQuery', () => {
    const original = window.matchMedia;
    afterEach(() => { window.matchMedia = original; });

    it('reads false before mount and the real match after, then follows changes', async () => {
        const mm = fakeMatchMedia(true);
        window.matchMedia = mm.matchMedia;
        const seen: boolean[] = [];
        let match!: ReturnType<typeof useMediaQuery>;
        const Probe = component(() => {
            match = useMediaQuery('(min-width: 768px)');
            seen.push(match.value);
            return () => <i>{String(match.value)}</i>;
        });
        const host = document.createElement('div');
        render(<Probe />, host);

        expect(seen[0]).toBe(false);
        expect(mm.matchMedia).toHaveBeenCalledWith('(min-width: 768px)');
        expect(match.value).toBe(true);
        await Promise.resolve();
        expect(host.textContent).toBe('true');

        mm.fire(false);
        expect(match.value).toBe(false);
        await Promise.resolve();
        expect(host.textContent).toBe('false');
    });

    it('detaches its listener on unmount', () => {
        const mm = fakeMatchMedia(false);
        window.matchMedia = mm.matchMedia;
        const Probe = component(() => {
            useMediaQuery('(prefers-reduced-motion: reduce)');
            return () => <i />;
        });
        const host = document.createElement('div');
        render(<Probe />, host);
        expect(mm.listeners.size).toBe(1);
        render(<span />, host);
        expect(mm.listeners.size).toBe(0);
    });

    it('is inert where matchMedia does not exist (the server)', () => {
        window.matchMedia = undefined as unknown as typeof window.matchMedia;
        const m = useMediaQuery('(min-width: 1px)');
        expect(m.value).toBe(false);
    });
});
