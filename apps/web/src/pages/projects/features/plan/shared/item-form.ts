/**
 * The item form's model (#1074): what a person types for an item's `after` (item numbers — `3`, `#3` — or another
 * project's item, `project#3`) and `touches` (paths relative to the project, one per line), read into what the Plan
 * actor takes, and an item's current values as that text. An item that names no touches runs alone (#1047).
 */
import type { PlanItem } from '@agentic/core';

/** The hint beside touches. */
export const TOUCHES_HINT = 'One path per line, relative to the project. Leave empty and the item runs alone.';
export const AFTER_HINT = 'Items that must be done first: #3, #5 or project#3 for another project’s.';

/** The two fields as typed. */
export interface ItemLinksDraft {
    readonly after: string;
    readonly touches: string;
}

/** `after` as `Plan.add` / `Plan.after` take it: this project's numbers, `project#n` for another's. */
export type AfterValue = number | string;

export interface ItemLinks {
    readonly after: readonly AfterValue[];
    readonly touches: readonly string[];
}

/** The draft read: the values, or why a field is not right yet. */
export interface ItemLinksRead {
    readonly links?: ItemLinks;
    readonly afterError?: string;
    readonly touchesError?: string;
}

const LOCAL = /^#?(\d+)$/;
const CROSS = /^([A-Za-z0-9][\w.-]*)#(\d+)$/;

/** `after` text: separated by commas or spaces; each `n`, `#n` or `project#n`. Repeats are kept once. */
export function readAfter(text: string): { readonly values: readonly AfterValue[]; readonly error?: string } {
    const values: AfterValue[] = [];
    const seen = new Set<string>();
    for (const token of text.split(/[\s,]+/).filter(Boolean)) {
        const local = LOCAL.exec(token);
        const cross = local ? null : CROSS.exec(token);
        const n = Number(local?.[1] ?? cross?.[2]);
        if ((!local && !cross) || !Number.isSafeInteger(n) || n < 1) return { values: [], error: `After takes #n or project#n, not “${token}”.` };
        const value: AfterValue = local ? n : `${cross![1]}#${n}`;
        const key = String(value).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        values.push(value);
    }
    return { values };
}

/** `touches` text: one path per line, relative to the project; a backslash reads as `/`. Repeats are kept once. */
export function readTouches(text: string): { readonly paths: readonly string[]; readonly error?: string } {
    const paths: string[] = [];
    for (const line of text.split(/\r?\n/)) {
        const p = line.trim().replace(/\\/g, '/');
        if (!p) continue;
        if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').includes('..')) return { paths: [], error: `Paths are relative to the project, not “${p}”.` };
        if (!paths.includes(p)) paths.push(p);
    }
    return { paths };
}

/** Both fields read; `links` only when both are right. */
export function readItemLinks(draft: ItemLinksDraft): ItemLinksRead {
    const after = readAfter(draft.after);
    const touches = readTouches(draft.touches);
    if (after.error || touches.error) return { ...(after.error ? { afterError: after.error } : {}), ...(touches.error ? { touchesError: touches.error } : {}) };
    return { links: { after: after.values, touches: touches.paths } };
}

/** An item's other-project waits as the live view carries them (`afterRefs`, #822); none on mock data. */
const crossAfterOf = (item: PlanItem): readonly { readonly projectId: string; readonly n: number }[] =>
    (item as PlanItem & { readonly afterRefs?: readonly { readonly projectId: string; readonly n: number }[] }).afterRefs ?? [];

/** An item's `after` and `touches` as the form shows them to edit. */
export function draftOf(item: Pick<PlanItem, 'after' | 'touches'>): ItemLinksDraft {
    const after = [...item.after.map((n) => `#${n}`), ...crossAfterOf(item as PlanItem).map((a) => `${a.projectId}#${a.n}`)];
    return { after: after.join(', '), touches: item.touches.join('\n') };
}

const afterKey = (values: readonly AfterValue[]): string => values.map((v) => String(v).toLowerCase()).sort().join(' ');

/** Which of the two an edit changes, so the page writes only those. */
export function linksChanged(item: Pick<PlanItem, 'after' | 'touches'>, links: ItemLinks): { readonly after: boolean; readonly touches: boolean } {
    const was = readItemLinks(draftOf(item)).links ?? { after: [], touches: [] };
    return {
        after: afterKey(was.after) !== afterKey(links.after),
        touches: was.touches.length !== links.touches.length || was.touches.some((p, i) => p !== links.touches[i])
    };
}

/** What `Plan.add` takes for one item: the title, and `after` / `touches` only when named. */
export function newItemInput(title: string, links: ItemLinks): { title: string; after?: AfterValue[]; touches?: string[] } {
    return { title, ...(links.after.length ? { after: [...links.after] } : {}), ...(links.touches.length ? { touches: [...links.touches] } : {}) };
}
