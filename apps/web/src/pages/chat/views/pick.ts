/**
 * Which view a chat shows and at what detail (#1058, CHT-09; `docs/design/chat-modes/HANDOFF.md` →
 * "Views", "Detail levels"; `docs/decisions.md` 2026-09-28 §3). Pure:
 *
 * - 0 or 1 agents at work is `focus`; 2 or more is `team`. At work is working, waiting on the person, or
 *   with a feed mid-turn — counted once each (`agentsAtWork`).
 * - A pin wins over the count.
 * - `lanes` needs 1024 px: below it the chat shows `team`.
 * - The detail follows the view (Team is Messages, Focus and Lanes are Steps); a detail the viewer saved wins.
 *
 * And the scroll anchor a view switch keeps: the first row in view and how far it sat from the top.
 */
import type { DetailLevel } from '@agentic/ui';
import type { ChatViewName } from '../view-prefs';

/** Lanes shows at this width and up; below it falls back to Team. */
export const LANES_MIN_WIDTH = 1024;

export interface ViewPick {
    readonly view: ChatViewName;
    /** `auto`: the count chose; `pinned`: the viewer did. */
    readonly rule: 'auto' | 'pinned';
    /** How many agents are at work — the count the rule read. */
    readonly working: number;
    /** A pinned Lanes shown as Team on a narrow screen. */
    readonly narrowed?: true;
}

/** The agents at work: the union of the working, the waiting and the ones whose feed is mid-turn. */
export function agentsAtWork(...groups: readonly Iterable<string>[]): Set<string> {
    const out = new Set<string>();
    for (const g of groups) for (const id of g) out.add(id);
    return out;
}

/** The view for `working` agents at work, a pin and the screen's width (none: wide, as a server render). */
export function pickView(working: number, pin?: ChatViewName, width?: number): ViewPick {
    const view: ChatViewName = pin ?? (working >= 2 ? 'team' : 'focus');
    const rule = pin ? 'pinned' : 'auto';
    if (view === 'lanes' && width !== undefined && width < LANES_MIN_WIDTH) return { view: 'team', rule, working, narrowed: true };
    return { view, rule, working };
}

/** A view's default detail level. */
export const defaultDetail = (view: ChatViewName): DetailLevel => (view === 'team' ? 'messages' : 'steps');

/** The detail the thread shows: the one the viewer saved, else the view's default. */
export const pickDetail = (view: ChatViewName, saved?: DetailLevel): DetailLevel => saved ?? defaultDetail(view);

const VIEW_NAME: Record<ChatViewName, string> = { focus: 'Focus', team: 'Team', lanes: 'Lanes' };
const PINNED_WHAT: Record<ChatViewName, string> = {
    focus: 'one thread, each turn folded',
    team: 'a work card per agent at work',
    lanes: 'one column per agent at work'
};

const countText = (n: number): string => (n === 0 ? 'no agent working' : n === 1 ? 'one agent working' : `${n} agents working`);

/** The header note: which rule chose the view — `one agent working · Focus picked automatically`, `pinned by you · …`. */
export function viewNote(pick: ViewPick): string {
    if (pick.rule === 'auto') return `${countText(pick.working)} · ${VIEW_NAME[pick.view]} picked automatically`;
    if (pick.narrowed) return `pinned by you · Lanes needs a wider screen, showing Team`;
    return `pinned by you · ${PINNED_WHAT[pick.view]}`;
}

/** Where the reader was: the index of the first row in view and its offset from the scroller's top. */
export interface ScrollAnchor {
    readonly index: number;
    readonly offset: number;
}

/**
 * The first row in view: of the rows' top and bottom edges (relative to the scroller's top, in order), the
 * first whose bottom is below the top edge. `null` with no rows.
 */
export function anchorOf(rows: readonly { readonly top: number; readonly bottom: number }[]): ScrollAnchor | null {
    const index = rows.findIndex((r) => r.bottom > 0);
    if (index < 0) return rows.length ? { index: rows.length - 1, offset: rows[rows.length - 1]!.top } : null;
    return { index, offset: rows[index]!.top };
}

/** The scroll offset that puts row `index` (now at `rowTop` from the scroller's top) back at the anchor's offset. */
export const restoreScroll = (scrollTop: number, anchor: ScrollAnchor, rowTop: number): number => Math.max(0, scrollTop + rowTop - anchor.offset);
