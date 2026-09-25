/**
 * The Requests inbox on the platform (#831): the project's Requests actor (#758) read as inbox entries, and a
 * person's accept / edit first / ask for more / decline as the actor's `resolve` (or `admit`, for a request the sender
 * rules held back). Pure: the page reads the actor and calls it; these shape the data between the two.
 */
import type { LinkedRequest, RequestResolution, RequestView } from '@agentic/platform';
import type { AcceptEdit } from './RequestsView';
import type { RequestEntry } from './model';

/** The three reads: `incoming()`, `sent()` and `linked()`. */
export interface RequestReads {
    readonly incoming: readonly RequestView[];
    readonly sent: readonly RequestView[];
    readonly linked: readonly LinkedRequest[];
}

/** A project's name by id; an unknown one shows its id. */
export type ProjectNames = (projectId: string) => string;

/** The list line a live request carries: what the manager asked, why it was declined, or that it waits to be let in. */
function noteOf(r: RequestView, manager: string): string | undefined {
    if (r.state === 'asked-for-more' && r.question) return `${manager} asked: ${r.question}`;
    if (r.state === 'declined' && r.declineReason) return r.declineReason;
    if (r.state === 'needs-you' && r.needs === 'admit') return 'waiting for you to let it in';
    return undefined;
}

function entryOf(r: RequestView, box: RequestEntry['box'], names: ProjectNames, manager: string): RequestEntry {
    const note = noteOf(r, manager);
    return {
        request: r,
        box,
        fromProjectName: names(r.fromProject),
        toProjectName: names(r.toProject),
        ...(r.state === 'needs-you' && r.needs ? { needs: r.needs } : {}),
        ...(note !== undefined ? { note } : {})
    };
}

/** Every entry of the inbox: incoming, sent and linked, each in its own box. */
export function liveEntries(reads: RequestReads, names: ProjectNames, manager: string): RequestEntry[] {
    return [
        ...reads.incoming.map((r) => entryOf(r, 'incoming', names, manager)),
        ...reads.sent.map((r) => entryOf(r, 'sent', names, manager)),
        ...reads.linked.map((l) => entryOf(l.request, 'linked', names, manager))
    ];
}

/** The resolution Accept sends: the triage's item as proposed, or the edited one. */
export const acceptResolution = (edit?: AcceptEdit): RequestResolution => (edit ? { action: 'accept', item: edit.item } : { action: 'accept' });

/** The phases a proposed item can go in: the project's first plan (where an accepted item lands by default). */
export const phasesOf = (plans: readonly { readonly phases: readonly { readonly n: number; readonly title: string }[] }[] | undefined): { n: number; title: string }[] =>
    (plans?.[0]?.phases ?? []).map((p) => ({ n: p.n, title: p.title }));

/** A failed call as the note above the list. */
export function failureNote(what: string, error: unknown): string {
    const message = error instanceof Error ? error.message.replace(/^\[requests\]\s*/, '') : String(error);
    return `Could not ${what}: ${message}`;
}
