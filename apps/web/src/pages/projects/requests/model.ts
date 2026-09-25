/**
 * The Requests inbox model (#761; HANDOFF.md → "Project manager and requests", board `Requests`): the three tabs, the
 * state pills, the triage rows and the three ways a person resolves a request (accept — as proposed or edited —, ask
 * for more, decline). Pure: the page keeps the entries and applies these.
 */
import type { PlanActor, ProjectRecord, ProjectRequest, RequestKind, RequestPriority, RequestState, Triage, TriageProposedItem } from '@agentic/core';
import type { Tone } from '@agentic/ui';

/** Incoming: sent to this project. Sent: this project's own asks. Linked: accepted items that tie the two together. */
export type RequestBox = 'incoming' | 'sent' | 'linked';
export const REQUEST_BOXES: readonly RequestBox[] = ['incoming', 'sent', 'linked'];
export const BOX_LABELS: Readonly<Record<RequestBox, string>> = { incoming: 'Incoming', sent: 'Sent', linked: 'Linked' };

/** A request as the inbox shows it: the record plus the names it holds as ids. */
export interface RequestEntry {
    readonly request: ProjectRequest;
    readonly box: RequestBox;
    readonly fromProjectName: string;
    readonly toProjectName: string;
    /** The chat it came from, by title. */
    readonly fromChatTitle?: string;
    /** The sending agent acted for the person reading. */
    readonly byYou?: boolean;
    /** The list row's trailing line (`Nova asked which page`). */
    readonly note?: string;
    /** When the manager finished its triage. */
    readonly triagedAt?: number;
    /** Where the triage places it (`core`), for the kind row: `Bug in core`. */
    readonly area?: string;
}

/** A name and hue for an actor id; the caller's directory. */
export type ActorNames = (agentId: string) => { readonly name: string; readonly hue?: 1 | 2 | 3 | 4 };

export interface RequestPill {
    readonly label: string;
    readonly tone: Tone;
    readonly hollow: boolean;
}

/** The state pill (HANDOFF table): TRIAGING names the manager. */
export function requestPill(state: RequestState, manager: string): RequestPill {
    switch (state) {
        case 'needs-you': return { label: 'NEEDS YOU', tone: 'needs-you', hollow: false };
        case 'triaging': return { label: `${manager.toUpperCase()} TRIAGING`, tone: 'working', hollow: false };
        case 'asked-for-more': return { label: 'ASKED FOR MORE', tone: 'dim', hollow: true };
        case 'accepted': return { label: 'ACCEPTED', tone: 'muted', hollow: false };
        case 'declined': return { label: 'DECLINED', tone: 'dim', hollow: true };
    }
}

/** Still waiting on someone: counts toward the Incoming tab. */
export const isOpen = (state: RequestState): boolean => state !== 'accepted' && state !== 'declined';

/** A box's entries: what needs you on top (as the board draws it), then newest first. */
export function entriesIn(entries: readonly RequestEntry[], box: RequestBox): RequestEntry[] {
    const rank = (e: RequestEntry): number => (e.request.state === 'needs-you' ? 0 : 1);
    return entries.filter((e) => e.box === box).sort((a, b) => rank(a) - rank(b) || b.request.createdAt - a.request.createdAt);
}

/** The tab's number: open requests for Incoming, every entry for Sent and Linked. */
export function boxCount(entries: readonly RequestEntry[], box: RequestBox): number {
    const inBox = entries.filter((e) => e.box === box);
    return box === 'incoming' ? inBox.filter((e) => isOpen(e.request.state)).length : inBox.length;
}

export const KIND_LABELS: Readonly<Record<RequestKind, string>> = {
    bug: 'Bug', feature: 'Feature', question: 'Question', docs: 'Docs', chore: 'Chore', duplicate: 'Duplicate'
};
export const PRIORITY_LABELS: Readonly<Record<RequestPriority, string>> = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };

/** The kind row: `Bug in core` when the triage names an area, the kind alone otherwise. */
export const kindLine = (t: Triage, area?: string): string => (area ? `${KIND_LABELS[t.kind]} in ${area}` : KIND_LABELS[t.kind]);

export const actorName = (a: PlanActor | undefined, names: ActorNames, you: string): string =>
    !a ? 'unassigned' : a.kind === 'agent' ? names(a.agentId).name : a.userId === 'me' ? you : a.userId;

/** `Forge, sent by you` · `Forge` · `Andii`. */
export const senderLine = (e: RequestEntry, names: ActorNames, you: string): string =>
    `${actorName(e.request.sender, names, you)}${e.byYou ? ', sent by you' : ''}`;

/** A phase by number, as the plan names it; `phase N` when unknown, the first open phase when absent. */
export const phaseName = (n: number | undefined, phases: readonly { n: number; title: string }[]): string =>
    n === undefined ? 'first open phase' : phases.find((p) => p.n === n)?.title ?? `phase ${n}`;

/** The proposed item's meta line after the phase: `Forge, top of queue · done when repro passes and bench holds`. */
export function itemMeta(item: TriageProposedItem, names: ActorNames, you: string): string {
    const who = `${actorName(item.assignee, names, you)}${item.first ? ', top of queue' : ''}`;
    return item.doneWhen.length ? `${who} · done when ${item.doneWhen.join(' and ')}` : who;
}

/** `owner/repo` from the project's git origin (feature `agentic.feature.git`, or the legacy `git` key), for the "open GitHub issue" line; `undefined` without a GitHub origin. */
export function githubRepoOf(p: Pick<ProjectRecord, 'features'>): string | undefined {
    for (const id of ['agentic.feature.git', 'git']) {
        const origin = (p.features[id] as { origin?: unknown } | undefined)?.origin;
        if (typeof origin !== 'string') continue;
        const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(origin);
        if (m) return `${m[1]}/${m[2]}`;
    }
    return undefined;
}

// ---- the edit-first form -------------------------------------------------------------------------------------------

/** The proposed item as the Edit-first form holds it: text for every field. */
export interface ItemDraft {
    title: string;
    /** A phase number as text; `''` → the first open phase. */
    phase: string;
    /** An agent id; `''` → unassigned. */
    assignee: string;
    /** One done-when line per line. */
    doneWhen: string;
    first: boolean;
    openIssue: boolean;
}

/** The form's starting values: the manager's proposal. */
export function draftOf(t: Triage): ItemDraft {
    const item = t.proposedItem;
    return {
        title: item?.title ?? '',
        phase: item?.phase !== undefined ? String(item.phase) : '',
        assignee: item?.assignee?.kind === 'agent' ? item.assignee.agentId : '',
        doneWhen: (item?.doneWhen ?? []).join('\n'),
        first: item?.first ?? false,
        openIssue: t.openIssue
    };
}

/** What is wrong with a draft, by field; empty when it can be accepted. */
export function draftErrors(d: ItemDraft): { title?: string } {
    return d.title.trim() ? {} : { title: 'The item needs a title.' };
}

/** The proposed item a draft stands for; keeps the original's options and a person assignee the form cannot change. */
export function itemOfDraft(d: ItemDraft, original?: TriageProposedItem): TriageProposedItem {
    const phase = d.phase === '' ? undefined : Number(d.phase);
    const assignee: PlanActor | undefined = d.assignee
        ? { kind: 'agent', agentId: d.assignee as never }
        : original?.assignee?.kind === 'user' ? original.assignee : undefined;
    return {
        title: d.title.trim(),
        ...(phase !== undefined && Number.isFinite(phase) ? { phase } : {}),
        ...(assignee ? { assignee } : {}),
        doneWhen: d.doneWhen.split('\n').map((l) => l.trim()).filter(Boolean),
        ...(d.first ? { first: true } : {}),
        ...(original?.options ? { options: original.options } : {})
    };
}

// ---- resolving -----------------------------------------------------------------------------------------------------

/** The entry with `patch` applied; its list line becomes `note` (none when absent). */
const withRequest = (e: RequestEntry, patch: Partial<ProjectRequest>, now: number, note?: string): RequestEntry => {
    const { note: _old, ...rest } = e;
    return { ...rest, request: { ...e.request, ...patch, updatedAt: now }, ...(note !== undefined ? { note } : {}) };
};

/**
 * Accept: the request becomes item `#itemN` in this project — as the manager proposed, or with `edited` in place of
 * its proposed item and `openIssue`. Only a request that needs you can be accepted.
 */
export function accept(e: RequestEntry, itemN: number, now: number, edited?: { item: TriageProposedItem; openIssue: boolean }): RequestEntry {
    if (e.request.state !== 'needs-you') return e;
    const triage = e.request.triage && edited ? { ...e.request.triage, proposedItem: edited.item, openIssue: edited.openIssue } : e.request.triage;
    return withRequest(e, { state: 'accepted', resultItem: itemN, ...(triage ? { triage } : {}) }, now);
}

/** Ask for more: the manager asks the sender `question` and the request waits on them. */
export function askForMore(e: RequestEntry, question: string, manager: string, now: number): RequestEntry {
    const q = question.trim();
    if (e.request.state !== 'needs-you' || !q) return e;
    return withRequest(e, { state: 'asked-for-more' }, now, `${manager} asked: ${q}`);
}

/** Decline with a reason, which the manager posts back. */
export function decline(e: RequestEntry, reason: string, now: number): RequestEntry {
    const r = reason.trim();
    if (e.request.state !== 'needs-you' || !r) return e;
    return withRequest(e, { state: 'declined', declineReason: r }, now, r);
}

/** The next free item number: one past the highest `resultItem` or `floor`. */
export function nextItemNumber(entries: readonly RequestEntry[], floor: number): number {
    return Math.max(floor, ...entries.map((e) => e.request.resultItem ?? 0)) + 1;
}
