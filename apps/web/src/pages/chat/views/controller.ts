/**
 * The chat page's view state (#1058), shared by the mock and the live page: the viewer's saved choices
 * (`view-prefs.ts`), the screen width Lanes needs, the pick (`pick.ts`), each turn's steps box state, and
 * the scroll anchor a view switch keeps.
 *
 * A steps box the viewer opened is remembered for the chat (`expanded`); one they closed stays closed for
 * the visit, so a turn that opened itself (a failure stopped the work) can be shut.
 */
import { onMounted, onUnmounted, signal, watch } from 'sigx';
import type { AgentMessage } from '@sigx/ai-agent/app';
import type { DetailLevel } from '@agentic/ui';
import { setStepsExpanded, setViewDetail, setViewPin, viewPrefs, type ChatViewName } from '../view-prefs';
import { LANES_MIN_WIDTH, anchorOf, pickDetail, pickView, restoreScroll, type ScrollAnchor, type ViewPick } from './pick';

export interface ChatViewState {
    readonly pick: () => ViewPick;
    readonly detail: () => DetailLevel;
    /** The screen is narrower than Lanes needs. */
    readonly narrow: () => boolean;
    /** Pin a view, or `auto` to let the count pick again. */
    readonly choose: (view: ChatViewName | 'auto') => void;
    readonly chooseDetail: (detail: DetailLevel) => void;
    readonly stepsOpen: (message: AgentMessage) => boolean | undefined;
    readonly onStepsToggle: (message: AgentMessage, open: boolean) => void;
    /** The conversation column, so a view switch keeps the reader's place. */
    readonly mainRef: (el: HTMLElement | null) => void;
}

const THREAD = '[data-scope="ai-thread"][data-part="root"]';

/** The rows of the thread under `main`, each as its top and bottom relative to the scroller's top. */
function rowsOf(root: HTMLElement): { el: HTMLElement; top: number; bottom: number }[] {
    const top = root.getBoundingClientRect().top;
    return [...root.querySelectorAll<HTMLElement>(':scope > ol > li')].map((el) => {
        const r = el.getBoundingClientRect();
        return { el, top: r.top - top, bottom: r.bottom - top };
    });
}

export function useChatView(opts: { readonly ws: () => string | null; readonly chatId: string; readonly working: () => number }): ChatViewState {
    const st = signal({ width: undefined as number | undefined, closed: [] as string[] });
    const prefs = () => {
        const ws = opts.ws();
        return ws ? viewPrefs(ws, opts.chatId) : { expanded: [] as readonly string[] };
    };
    const pick = (): ViewPick => pickView(opts.working(), prefs().pin, st.width);
    const detail = (): DetailLevel => pickDetail(pick().view, prefs().detail);

    let main: HTMLElement | null = null;
    let anchor: ScrollAnchor | null = null;
    const record = (): void => {
        const root = main?.querySelector<HTMLElement>(THREAD);
        anchor = !root || root.dataset.state === 'on' ? null : anchorOf(rowsOf(root));
    };
    onMounted(() => {
        if (typeof window === 'undefined') return;
        const sync = (): void => { st.width = window.innerWidth; };
        sync();
        window.addEventListener('resize', sync);
        // The view changed (a pin, or a second agent starting): once the new view has drawn, put the anchor row back where it was.
        const stop = watch(() => pick().view, () => {
            const keep = anchor;
            if (!keep) return;
            setTimeout(() => {
                const root = main?.querySelector<HTMLElement>(THREAD);
                const row = root ? rowsOf(root)[keep.index] : undefined;
                if (root && row) root.scrollTop = restoreScroll(root.scrollTop, keep, row.top);
            }, 0);
        });
        onUnmounted(() => {
            window.removeEventListener('resize', sync);
            stop.stop();
        });
    });

    return {
        pick,
        detail,
        narrow: () => st.width !== undefined && st.width < LANES_MIN_WIDTH,
        choose: (view) => {
            const ws = opts.ws();
            if (!ws) return;
            record();
            setViewPin(ws, opts.chatId, view === 'auto' ? undefined : view);
        },
        chooseDetail: (d) => {
            const ws = opts.ws();
            if (ws) setViewDetail(ws, opts.chatId, d);
        },
        stepsOpen: (m) => (prefs().expanded.includes(m.id) ? true : st.closed.includes(m.id) ? false : undefined),
        onStepsToggle: (m, open) => {
            st.closed = open ? st.closed.filter((id) => id !== m.id) : [...st.closed.filter((id) => id !== m.id), m.id];
            const ws = opts.ws();
            if (ws) setStepsExpanded(ws, opts.chatId, m.id, open);
        },
        mainRef: (el) => {
            if (main === el) return;
            main?.removeEventListener('scroll', record, true);
            main = el;
            main?.addEventListener('scroll', record, true);
        }
    };
}
